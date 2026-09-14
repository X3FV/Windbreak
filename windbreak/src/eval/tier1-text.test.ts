import { describe, expect, test } from 'bun:test'

import { renderTier1Report } from './tier1-text'

import type { StageMetrics } from './confusion'
import type { Tier1Report } from './tier1'

const scored = (overrides: Partial<StageMetrics> = {}): StageMetrics => ({
  stage: 'triage',
  label: 'triage (§4.6)',
  status: 'scored',
  reason: null,
  pairs: 3,
  truePositives: 2,
  falseNegatives: 1,
  falsePositives: 1,
  trueNegatives: 2,
  unscoreable: 0,
  notRun: 0,
  sensitivity: 2 / 3,
  falseAlarmRate: 1 / 3,
  specificity: 2 / 3,
  precision: 2 / 3,
  f1: 2 / 3,
  discrimination: 1 / 3,
  biasRatio: 2,
  byDetail: [{ detail: 'likely-real', count: 2 }],
  notes: [],
  ...overrides,
})

const notRun = (): StageMetrics => ({
  ...scored(),
  status: 'not-run',
  reason: 'no half received a triage label, so §4.6 did not answer',
  truePositives: null,
  falseNegatives: null,
  falsePositives: null,
  trueNegatives: null,
  unscoreable: null,
  notRun: null,
  sensitivity: null,
  falseAlarmRate: null,
  specificity: null,
  precision: null,
  f1: null,
  discrimination: null,
  biasRatio: null,
  byDetail: [],
})

const report = (overrides: Partial<Tier1Report> = {}): Tier1Report => ({
  corpus: 'primevul-test',
  corpusVersion: 1,
  description: null,
  targetId: 'primevul-abc',
  runId: 'run-1',
  commitSha: 'abcdef0123456789',
  pairs: 3,
  stages: [scored()],
  cached: { triageCandidates: 0, verificationCalls: 0 },
  mixedCache: false,
  warnings: [],
  caveats: ['not repo-scale evidence'],
  ...overrides,
})

describe('renderTier1Report', () => {
  test('a stage that did not answer prints em dashes, never zeroes', () => {
    const text = renderTier1Report(report({ stages: [notRun()] }))
    const line = text.split('\n').find((entry) => entry.trimStart().startsWith('triage'))!
    // The label itself carries a §4.6, so only the metric columns are checked.
    const cells = line.replace(notRun().label, '')
    expect(cells).toContain('—')
    expect(cells).not.toMatch(/\d/)
    expect(text).toContain('did not answer')
  })

  test('prints both sides of the result on the same line', () => {
    const text = renderTier1Report(report())
    const line = text.split('\n').find((entry) => entry.trimStart().startsWith('triage'))!
    // Sensitivity alone would let a stage that flags everything look perfect.
    expect(line).toContain('0.667')
    expect(line).toContain('0.333')
  })

  test('labels the two cache units, because they differ', () => {
    const text = renderTier1Report(
      report({ cached: { triageCandidates: 3, verificationCalls: 6 } }),
    )
    expect(text).toContain('3 triage candidate(s), 6 verification call(s)')
    expect(text).not.toContain('mixed with fresh calls')
  })

  test('says when a run mixed cached and fresh answers', () => {
    const text = renderTier1Report(
      report({ cached: { triageCandidates: 3, verificationCalls: 0 }, mixedCache: true }),
    )
    expect(text).toContain('mixed with fresh calls')
  })

  test('prints the corpus revision and the number of functions judged', () => {
    const text = renderTier1Report(report())
    expect(text).toContain('corpus revision abcdef012345')
    expect(text).toContain('3 pair(s)')
    expect(text).toContain('6 function(s) judged')
  })

  test('shows the raw answer breakdown under each stage', () => {
    expect(renderTier1Report(report())).toContain('likely-real 2')
  })

  test('carries the caveats, so a reader cannot take the number as repo-scale', () => {
    expect(renderTier1Report(report())).toContain('not repo-scale evidence')
  })
})
