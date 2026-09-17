import { describe, expect, test } from 'bun:test'

import { scanSummaryLines } from './summary'
import { EMPTY_COUNTS } from './types'

import type { LanguageCoverage } from './coverage'
import type { ScanCounts, ScanResult, StageRecord } from './types'

const NO_COVERAGE: LanguageCoverage = {
  sweptCallables: 0,
  partiallySweptCallables: 0,
  unsweptCallables: 0,
  languages: [],
}

const stage = (over: Partial<StageRecord> = {}): StageRecord => ({
  stage: 'ingestion',
  status: 'complete',
  durationMs: 1500,
  detail: '12 files',
  counts: {},
  reason: null,
  ...over,
})

const result = (over: Partial<ScanResult> = {}): ScanResult => ({
  runId: 'run-7',
  targetId: 'target-abc',
  commitSha: 'deadbee',
  status: 'complete',
  stages: [stage()],
  counts: { ...EMPTY_COUNTS } as ScanCounts,
  resumeFrom: null,
  report: null,
  languageCoverage: NO_COVERAGE,
  providerFailure: null,
  warnings: [],
  ...over,
})

describe('scanSummaryLines', () => {
  test('names the run before it says anything about the target', () => {
    const lines = scanSummaryLines(result())

    expect(lines[1]).toBe('run id:       run-7')
    expect(lines[2]).toBe('target id:    target-abc')
    expect(lines[3]).toBe('commit:       deadbee')
    expect(lines[4]).toBe('status:       complete')
  })

  test('states an account-level refusal before the stage table', () => {
    // §18: `partial` stages with a depleted balance would send a reader looking for a bug
    // in the target, so the cause is stated once, above the table, where the counts are.
    const lines = scanSummaryLines(
      result({
        status: 'partial',
        providerFailure: { kind: 'credits', detail: 'Out of credits.' },
      }),
    )

    const blocked = lines.findIndex((line) => line.startsWith('BLOCKED:'))
    const stages = lines.findIndex((line) => line === 'stages:')

    expect(blocked).toBeGreaterThan(-1)
    expect(stages).toBeGreaterThan(-1)
    expect(blocked).toBeLessThan(stages)
  })

  test('keeps every warning, because each one is a candidate left unexamined', () => {
    const lines = scanSummaryLines(
      result({ warnings: ['candidate 1 unexamined', 'candidate 2 unexamined'] }),
    )

    expect(lines).toContain('warning: candidate 1 unexamined')
    expect(lines).toContain('warning: candidate 2 unexamined')
  })

  test('prints the pin\u2019s cost beside the candidate counts, even at zero', () => {
    // `0 candidates` must not be the last word on a repository whose callables the
    // C-shaped tables never reached (§20.24.5), nor on one with no call graph at all.
    const lines = scanSummaryLines(result())
    const joined = lines.join('\n')

    expect(joined).toContain('language coverage')
    expect(joined).toContain('interprocedural:')
  })

  test('prints the reachability classes beside the counts that qualify them', () => {
    // §4.4.4's `0 unreachable` and a closure that never completed must not print the same
    // way, and the four classes are printed including their zeros for that reason.
    const lines = scanSummaryLines(
      result({
        counts: {
          ...EMPTY_COUNTS,
          entryPoints: 2,
          reachCallables: 10,
          reachAttackerInput: 3,
          reachExposedApi: 1,
          reachUnreachable: 4,
          reachUnknown: 2,
          reachTaintRoots: 1,
          reachExternalCallees: 5,
        },
      }),
    )
    const joined = lines.join('\n')

    expect(joined).toContain('reachability: 3/10 callable(s) reachable from attacker input')
    expect(joined).toContain('4 no path')
    expect(joined).toContain('5 name(s) with no definition')
  })

  test('names the qualified calls among the unresolved ones, because they are unattributable', () => {
    // §20.39.8: `Q::f` leaves a caller set this analysis cannot complete, so `0 unreachable` is
    // worth less than it looks. The subset is printed rather than folded into the total.
    const lines = scanSummaryLines(
      result({
        counts: {
          ...EMPTY_COUNTS,
          entryPoints: 2,
          reachCallables: 10,
          reachExternalCallees: 5,
          reachQualifiedCallees: 3,
        },
      }),
    )

    expect(lines.join('\n')).toContain(
      '5 name(s) with no definition (3 written with a class or namespace qualifier)',
    )
  })

  test('says nothing about qualifiers when every unresolved name is bare', () => {
    const lines = scanSummaryLines(
      result({ counts: { ...EMPTY_COUNTS, entryPoints: 2, reachCallables: 10, reachExternalCallees: 5 } }),
    )

    expect(lines.join('\n')).not.toContain('qualifier')
  })

  test('a model with no callables says so rather than reporting a clean closure', () => {
    const lines = scanSummaryLines(result())

    expect(lines.join('\n')).toContain('no indexed callables')
  })

  test('a complete run ends with OK and no resume instruction', () => {
    const lines = scanSummaryLines(result())

    expect(lines).toContain('OK: scan complete.')
    expect(lines.some((line) => line.startsWith('Resume with:'))).toBe(false)
  })

  test('an incomplete run says so and names what would continue it', () => {
    const lines = scanSummaryLines(
      result({ status: 'partial', resumeFrom: 'triage' }),
    )

    expect(lines).toContain('WARN: scan partial.')
    const resume = lines.find((line) => line.startsWith('Resume with:'))
    expect(resume).toContain('--run run-7')
    expect(resume).toContain('the first incomplete stage is triage')
  })

  test('the first line is the blank one the batch command used to print', () => {
    // `console.log(lines.join('\n'))` has to reproduce the previous output byte for byte,
    // so the leading newline is the first element rather than the printer's business.
    const lines = scanSummaryLines(result())

    expect(lines[0]).toBe('')
    expect(lines.join('\n').startsWith('\nrun id:')).toBe(true)
  })
})
