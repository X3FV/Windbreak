import { describe, expect, test } from 'bun:test'

import { halfKey, runRuleTier } from './rule-tier'

import type { RuleBatchRunner, RuleHalfOutcome } from './rule-tier'
import type { FunctionPair, PairSet } from './types'

const pair = (id: string, cve: string | null = null): FunctionPair => ({
  id,
  project: 'demo',
  cwe: null,
  cve,
  commitSha: 'a'.repeat(40),
  fixCommit: 'f'.repeat(40),
  vulnerable: 'int f(void) { strcpy(a, b); }',
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

/** A runner that decides every half from a table keyed by `pairId:half`. */
const runner = (
  decisions: Record<string, readonly string[] | null>,
): RuleBatchRunner => async (halves) => {
  const outcomes = new Map<string, RuleHalfOutcome>()
  for (const half of halves) {
    const key = half.key.replace('\u0000', ':')
    if (!(key in decisions)) continue
    const value = decisions[key]
    outcomes.set(
      half.key,
      value === null
        ? { firedRuleIds: null, failureReason: 'engine said no' }
        : { firedRuleIds: value },
    )
  }
  return { outcomes, notes: [] }
}

describe('runRuleTier', () => {
  test('a rule firing only on the vulnerable half is the one that counts', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1', 'CVE-2024-1')]),
      runBatch: runner({ 'p1:vulnerable': ['wb-a'], 'p1:patched': [] }),
    })

    expect(report.metrics.status).toBe('scored')
    expect(report.metrics.discrimination).toBe(1)
    expect(report.metrics.sensitivity).toBe(1)
    expect(report.metrics.falseAlarmRate).toBe(0)
    expect(report.outcomes[0]!.verdict).toBe('discriminated')
  })

  test('a rule firing on both halves catches nothing, and scores zero discrimination', async () => {
    // The failure this number exists to expose: a rule that matches the shape of
    // ordinary C fires on the fix as readily as on the bug, and looks identical
    // to a working rule in a recall-only figure.
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: runner({ 'p1:vulnerable': ['wb-a'], 'p1:patched': ['wb-a'] }),
    })

    expect(report.metrics.sensitivity).toBe(1)
    expect(report.metrics.discrimination).toBe(0)
    expect(report.metrics.falseAlarmRate).toBe(1)
    expect(report.outcomes[0]!.verdict).toBe('false-alarm')
  })

  test('no fire on the vulnerable half is recall loss', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: runner({ 'p1:vulnerable': [], 'p1:patched': [] }),
    })

    expect(report.metrics.sensitivity).toBe(0)
    expect(report.metrics.discrimination).toBe(0)
    expect(report.outcomes[0]!.verdict).toBe('no-fire')
  })

  test('a half the engine did not report is unscoreable, never a clear', async () => {
    // The honesty rule the whole tier rests on. Treating a missing result as
    // *no findings* would shrink the denominator by exactly the halves the
    // engine choked on, so the failure would improve the score.
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: runner({ 'p1:vulnerable': ['wb-a'] }),
    })

    expect(report.unscoreable).toBe(1)
    expect(report.outcomes[0]!.verdict).toBe('undecided')
    expect(report.metrics.unscoreable).toBe(1)
    // The vulnerable half was still decided, so the stage scored.
    expect(report.metrics.status).toBe('scored')
  })

  test('an explicit null verdict is unscoreable, carrying the engine reason', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: runner({ 'p1:vulnerable': null, 'p1:patched': [] }),
    })

    expect(report.metrics.unscoreable).toBe(1)
    expect(report.metrics.byDetail.map((entry) => entry.detail)).toContain('engine said no')
  })

  test('every half failing is a measurement that did not happen, not a zero', async () => {
    // §18: a stage that ran and found nothing must not read the same as a stage
    // that never ran. The metrics are absent rather than zero.
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: async () => ({ outcomes: new Map(), notes: [] }),
    })

    expect(report.metrics.status).toBe('not-run')
    expect(report.metrics.sensitivity).toBeNull()
    expect(report.metrics.discrimination).toBeNull()
    expect(report.metrics.reason).toContain('no verdict')
  })

  test('an empty corpus reports not-run with its own reason', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([]),
      runBatch: async () => ({ outcomes: new Map(), notes: [] }),
    })

    expect(report.metrics.status).toBe('not-run')
    expect(report.metrics.reason).toBe('the corpus has no pairs to score')
  })

  test('attributes fires per rule across the corpus, and keeps engine notes', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1'), pair('p2')]),
      runBatch: async (halves) => ({
        outcomes: new Map([
          [halfKey('p1', 'vulnerable'), { firedRuleIds: ['wb-a', 'wb-b'] }],
          [halfKey('p1', 'patched'), { firedRuleIds: [] }],
          [halfKey('p2', 'vulnerable'), { firedRuleIds: ['wb-a'] }],
          [halfKey('p2', 'patched'), { firedRuleIds: [] }],
        ]),
        notes: ['semgrep warned about something'],
      }),
    })

    expect(report.rules).toEqual([
      { ruleId: 'wb-a', vulnerable: 2, patched: 0 },
      { ruleId: 'wb-b', vulnerable: 1, patched: 0 },
    ])
    expect(report.metrics.discrimination).toBe(1)
    expect(report.engineNotes).toEqual(['semgrep warned about something'])
  })

  test('deduplicates a rule reported twice for one half', async () => {
    const report = await runRuleTier({
      pairSet: pairSet([pair('p1')]),
      runBatch: runner({ 'p1:vulnerable': ['wb-a', 'wb-a'], 'p1:patched': [] }),
    })

    expect(report.outcomes[0]!.vulnerableRules).toEqual(['wb-a'])
    expect(report.rules[0]!.vulnerable).toBe(1)
  })
})
