import { describe, expect, test } from 'bun:test'

import { renderEvalReport } from './report-text'

import type { EvalReport, FunnelRow, FunnelStage } from './types'

const row = (stage: FunnelStage, overrides: Partial<FunnelRow> = {}): FunnelRow => ({
  stage,
  label: stage,
  status: 'scored',
  reason: null,
  candidates: 0,
  truePositives: 0,
  falsePositives: 0,
  unscored: 0,
  rediscovery: 0,
  modelProposed: 0,
  precision: null,
  recall: null,
  discoveryRecall: null,
  bugsFound: [],
  bugsFoundByDiscovery: [],
  bugsLost: [],
  targetFpRate: 0.9,
  targetMet: null,
  notes: [],
  ...overrides,
})

const report = (overrides: Partial<EvalReport> = {}): EvalReport => ({
  fixtureSetVersion: 1,
  fixtureSetDescription: 'seeded set',
  fixtures: [
    {
      fixtureId: 'fx-1',
      project: 'libarchive',
      commitSha: 'abc1234',
      runId: 'run-1',
      status: 'scored',
      reason: null,
      totalBugs: 3,
      funnel: [
        row('raw', {
          label: 'raw static hits',
          candidates: 4,
          truePositives: 2,
          falsePositives: 2,
          precision: 0.5,
          recall: 2 / 3,
          discoveryRecall: 2 / 3,
          bugsFound: ['bug-1', 'bug-2'],
          bugsFoundByDiscovery: ['bug-1', 'bug-2'],
          targetMet: true,
        }),
        row('post-triage', {
          status: 'not-run',
          reason: 'no candidate carries a triage label, so §4.6 never ran',
          candidates: null,
          truePositives: null,
          falsePositives: null,
          unscored: null,
          rediscovery: null,
          precision: null,
          recall: null,
          discoveryRecall: null,
          bugsFound: null,
          bugsFoundByDiscovery: null,
          bugsLost: null,
          targetMet: null,
        }),
      ],
      notes: ['scored against run run-1 (status: complete)'],
    },
  ],
  scoredFixtures: 1,
  unscoredFixtures: 0,
  totalBugs: 3,
  recall: 2 / 3,
  discoveryRecall: 2 / 3,
  minRecall: 0.2,
  gate: 'pass',
  gateReason: null,
  caveats: ['precision is a lower bound'],
  ...overrides,
})

describe('renderEvalReport', () => {
  test('a stage that did not run prints an em dash, never a zero', () => {
    const text = renderEvalReport(report())
    const line = text.split('\n').find((entry) => entry.trimStart().startsWith('post-triage'))!
    expect(line).toContain('—')
    // A zero here would read as "the stage ran and killed everything", which is
    // the most interesting row in the report — and the opposite of this one.
    expect(line).not.toMatch(/\d/)
  })

  test('explains why the stage did not run, beneath the table', () => {
    const text = renderEvalReport(report())
    expect(text).toContain('post-triage: no candidate carries a triage label')
  })

  test('renders a scorable stage with counts, precision, and recall', () => {
    const text = renderEvalReport(report())
    const line = text.split('\n').find((entry) => entry.trimStart().startsWith('raw static'))!
    expect(line).toContain('4')
    expect(line).toContain('0.500')
    expect(line).toContain('2/3')
  })

  test('prints the gate and the bar it was measured against', () => {
    expect(renderEvalReport(report())).toContain('gate          PASS  >= 0.20')
    expect(renderEvalReport(report({ gate: 'fail' }))).toContain('gate          FAIL  below 0.20')
    expect(
      renderEvalReport(
        report({ gate: 'not-evaluable', recall: null, gateReason: 'nothing was scored' }),
      ),
    ).toContain('gate          NOT EVALUABLE  nothing was scored')
  })

  test('a fixture with no run says so instead of showing an empty table', () => {
    const text = renderEvalReport(
      report({
        fixtures: [
          {
            fixtureId: 'fx-2',
            project: 'p',
            commitSha: 'fffffff',
            runId: null,
            status: 'not-run',
            reason: 'no run in the database is pinned to fffffff',
            totalBugs: 3,
            funnel: [],
            notes: [],
          },
        ],
        scoredFixtures: 0,
        unscoredFixtures: 1,
      }),
    )
    expect(text).toContain('NOT SCORED  no run in the database is pinned to fffffff')
    expect(text).toContain('seeded: 3 bug(s)')
  })

  test('reports a missed §2.4 target and the bugs lost between stages', () => {
    const text = renderEvalReport(
      report({
        fixtures: [
          {
            fixtureId: 'fx-1',
            project: 'p',
            commitSha: 'abc1234',
            runId: 'run-1',
            status: 'scored',
            reason: null,
            totalBugs: 3,
            funnel: [
              row('raw', {
                label: 'raw static hits',
                targetMet: false,
                targetFpRate: 0.9,
                bugsFound: ['bug-1', 'bug-2'],
                bugsFoundByDiscovery: ['bug-1', 'bug-2'],
              }),
              row('post-triage', {
                label: 'post-triage',
                targetFpRate: 0.6,
                bugsFound: ['bug-1'],
                bugsFoundByDiscovery: ['bug-1'],
                bugsLost: ['bug-2'],
              }),
            ],
            notes: [],
          },
        ],
      }),
    )
    expect(text).toContain('90% !')
    expect(text).toContain('lost after post-triage: bug-2')
  })

  test('an empty fixture set says nothing passed', () => {
    const text = renderEvalReport(report({ fixtures: [] }))
    expect(text).toContain('Nothing was scored, and nothing passed.')
  })
})
