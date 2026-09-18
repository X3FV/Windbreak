import { describe, expect, test } from 'bun:test'

import { runShapeTier, sweepShapes } from './shape-tier'

import type { FixShape } from '../patchmine/types'
import type { ShapeDetector } from './shape-tier'
import type { FunctionPair, PairSet } from './types'

const pair = (id: string, source?: string): FunctionPair => ({
  id,
  project: 'demo',
  cwe: null,
  cve: null,
  commitSha: 'a'.repeat(40),
  fixCommit: 'f'.repeat(40),
  vulnerable: source ?? 'int f(void) { strcpy(a, b); }',
  patched: 'int f(void) { snprintf(a, n, "%s", b); }',
  filePath: 'src/a.c',
  note: null,
})

const pairSet = (pairs: FunctionPair[]): PairSet => ({
  kind: 'function-pairs',
  version: 1,
  corpus: 'test-corpus',
  description: null,
  pairs,
})

/**
 * A detector that decides every half from a table keyed by `pairId:half`.
 *
 * Three states, and the tier has to keep all three apart: a key holding a list
 * (the sweep ran), a key holding `[]` (the sweep ran and found nothing), and no
 * key at all or `null` (the sweep produced no verdict). Collapsing the last into
 * the second is the §18 substitution this tier inherits.
 */
const detector =
  (decisions: Record<string, readonly FixShape[] | null>): ShapeDetector =>
  (half) => {
    const key = half.key.replace('\u0000', ':')
    const value = decisions[key]
    if (value === undefined) {
      return { firedShapes: null, failureReason: 'no verdict for this half' }
    }
    return value === null
      ? { firedShapes: null, failureReason: 'detector said no' }
      : { firedShapes: value, findings: value.length }
  }

describe('runShapeTier', () => {
  test('a shape firing only on the vulnerable half is the one that counts', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': ['null-check'], 'p1:patched': [] }),
    })

    expect(report.metrics.status).toBe('scored')
    expect(report.metrics.discrimination).toBe(1)
    expect(report.metrics.sensitivity).toBe(1)
    expect(report.outcomes[0]!.verdict).toBe('discriminated')
  })

  test('a shape firing on both halves catches nothing', () => {
    // The failure the pair figure exists to expose, and the reason a subject-free
    // sweep has to be priced rather than assumed: `null-check` fires on most of a
    // C codebase, and a fix that adds the test does not make the function stop
    // looking like code.
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': ['null-check'], 'p1:patched': ['null-check'] }),
    })

    expect(report.metrics.sensitivity).toBe(1)
    expect(report.metrics.discrimination).toBe(0)
    expect(report.metrics.falseAlarmRate).toBe(1)
    expect(report.outcomes[0]!.verdict).toBe('false-alarm')
  })

  test('no fire on the vulnerable half is recall loss', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': [], 'p1:patched': [] }),
    })

    expect(report.metrics.sensitivity).toBe(0)
    expect(report.metrics.discrimination).toBe(0)
    expect(report.outcomes[0]!.verdict).toBe('no-fire')
  })

  test('a half with no verdict is unscoreable, never a clear', () => {
    // The rule the tier inherits from §18 and from the rule tier: a detector that
    // produced no verdict must not be recorded as one that found nothing, or a
    // sweep that failed on the hard cases would score better than one that tried.
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': ['null-check'] }),
    })

    expect(report.unscoreable).toBe(1)
    expect(report.outcomes[0]!.verdict).toBe('undecided')
    expect(report.metrics.unscoreable).toBe(1)
    expect(report.metrics.status).toBe('scored')
  })

  test('an explicit null verdict carries the detector reason into the detail', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': null, 'p1:patched': [] }),
    })

    expect(report.metrics.unscoreable).toBe(1)
    expect(report.metrics.byDetail.map((entry) => entry.detail)).toContain('detector said no')
  })

  test('every half failing is a measurement that did not happen, not a zero', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: () => ({ firedShapes: null, failureReason: 'no verdict' }),
    })

    expect(report.metrics.status).toBe('not-run')
    expect(report.metrics.sensitivity).toBeNull()
    expect(report.metrics.discrimination).toBeNull()
    expect(report.metrics.reason).toContain('no verdict')
  })

  test('an empty corpus reports not-run with its own reason', () => {
    const report = runShapeTier({ pairSet: pairSet([]), detector: () => ({ firedShapes: [] }) })

    expect(report.metrics.status).toBe('not-run')
    expect(report.metrics.reason).toBe('the corpus has no pairs to score')
  })

  test('attributes fires per shape across the corpus, and counts emitted sites', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1'), pair('p2')]),
      detector: detector({
        'p1:vulnerable': ['null-check', 'lifetime'],
        'p1:patched': [],
        'p2:vulnerable': ['null-check'],
        'p2:patched': [],
      }),
    })

    expect(report.shapes).toEqual([
      { shape: 'null-check', vulnerable: 2, patched: 0 },
      { shape: 'lifetime', vulnerable: 1, patched: 0 },
    ])
    // Sites, not pairs: one half can emit several, and the volume is what a
    // downstream triage stage has to absorb.
    expect(report.emitted).toEqual({ vulnerable: 3, patched: 0 })
  })

  test('deduplicates a shape reported twice for one half', () => {
    const report = runShapeTier({
      pairSet: pairSet([pair('p1')]),
      detector: detector({ 'p1:vulnerable': ['guard', 'guard'], 'p1:patched': [] }),
    })

    expect(report.outcomes[0]!.vulnerableShapes).toEqual(['guard'])
    expect(report.shapes[0]!.vulnerable).toBe(1)
  })
})

/**
 * The real detector, which is the part of this tier that cannot be faked by a
 * fixture: `sweepShapes` is the subject-free reading, and the two claims the
 * report makes about it are claims about this function.
 */
describe('sweepShapes', () => {
  const subjectFreeSource = [
    'int paste(char *dst, const char *src) {',
    '    strcpy(dst, src);',
    '    return 0;',
    '}',
  ].join('\n')

  test('fires subject-free on a dereference with no null test', () => {
    // The positive control the tier needs before any of its zeros mean anything:
    // a sweep that cannot fire is indistinguishable from a sweep that found
    // nothing, which is §20.35.6 #1 one layer down.
    const outcome = sweepShapes(subjectFreeSource)

    expect(outcome.firedShapes).toContain('null-check')
    expect(outcome.findings).toBeGreaterThan(0)
  })

  test('guard and lock cannot fire without a mined operation', () => {
    // Not weakness — a design boundary. `detectAll` returns `[]` for both when no
    // operation is supplied, so on a checkout with no fix history of its own the
    // patch-mined layer emits *nothing* from these two. The report names that
    // rather than letting a zero read as a measurement.
    const outcome = sweepShapes(subjectFreeSource)

    expect(outcome.firedShapes).not.toContain('guard')
    expect(outcome.firedShapes).not.toContain('lock')

    const report = runShapeTier({
      pairSet: pairSet([pair('p1', subjectFreeSource)]),
      detector: (half) => sweepShapes(half.source),
    })

    expect(report.inertShapes).toContain('guard')
    expect(report.inertShapes).toContain('lock')
    // And the same run is not inert overall, so the claim above is about two
    // shapes rather than about a detector that never fires.
    expect(report.shapes.map((entry) => entry.shape)).toContain('null-check')
  })
})
