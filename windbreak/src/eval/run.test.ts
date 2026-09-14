import { describe, expect, test } from 'bun:test'

import { seedState } from '../pipeline/test-support'
import { EvalInputReadError } from './load'
import { commitMatches, loadFixtureSet, runEval, UnknownRunError } from './run'

import type { FixtureBug, FixtureSet } from './types'

const BUG: FixtureBug = {
  id: 'bug-1',
  cwe: 'CWE-120',
  cve: null,
  files: [{ filePath: 'src/a.c', startLine: 10, endLine: 20, functionName: null }],
  fixCommit: 'def5678',
  note: null,
}

const fixtureSet = (fixtures: FixtureSet['fixtures']): FixtureSet => ({
  version: 1,
  description: 'seeded set',
  fixtures,
})

const oneFixture = (overrides: Partial<FixtureSet['fixtures'][number]> = {}) =>
  fixtureSet([
    {
      id: 'fx-1',
      project: 'libarchive',
      commitSha: 'abc1234',
      bugs: [BUG],
      note: null,
      ...overrides,
    },
  ])

describe('commitMatches', () => {
  test('accepts an abbreviated sha either way round', () => {
    expect(commitMatches('abc1234', 'abc1234fullsha')).toBe(true)
    expect(commitMatches('abc1234fullsha', 'abc1234')).toBe(true)
  })

  test('is a prefix relation, not a substring one', () => {
    // A fixture pinned to `1234abc` must not match a commit that merely
    // contains it, or the wrong revision gets scored against real ground truth.
    expect(commitMatches('1234abc', 'dead1234abc')).toBe(false)
  })

  test('compares case-insensitively', () => {
    expect(commitMatches('ABC1234', 'abc1234full')).toBe(true)
  })
})

describe('runEval', () => {
  test('scores a fixture against the run pinned to its commit', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      candidates: [{ startLine: 15 }, { startLine: 400 }],
    })

    const report = runEval({ db, fixtureSet: oneFixture() })

    expect(report.scoredFixtures).toBe(1)
    expect(report.unscoredFixtures).toBe(0)
    expect(report.totalBugs).toBe(1)

    const raw = report.fixtures[0]!.funnel.find((row) => row.stage === 'raw')!
    expect(raw.truePositives).toBe(1)
    expect(raw.falsePositives).toBe(1)
    expect(raw.recall).toBe(1)
    expect(report.recall).toBe(1)
  })

  test('a fixture with no run is unscored, never a zero-recall result', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })

    const report = runEval({
      db,
      fixtureSet: oneFixture({ commitSha: 'fffffff' }),
    })

    expect(report.fixtures[0]!.status).toBe('not-run')
    expect(report.fixtures[0]!.runId).toBeNull()
    expect(report.fixtures[0]!.reason).toContain('no run in the database is pinned to')
    expect(report.fixtures[0]!.funnel).toEqual([])
    expect(report.scoredFixtures).toBe(0)
    expect(report.unscoredFixtures).toBe(1)
    // Nothing was measured, so the gate cannot be a pass.
    expect(report.gate).toBe('not-evaluable')
    expect(report.caveats.join(' ')).toContain('neither a pass nor a failure')
  })

  test('matches an abbreviated fixture sha to a full run sha', () => {
    const { db } = seedState({ commitSha: 'abc1234fullsha', candidates: [{}] })
    const report = runEval({ db, fixtureSet: oneFixture({ commitSha: 'abc1234' }) })
    expect(report.fixtures[0]!.status).toBe('scored')
  })

  test('scores the newest run and says which one it ignored', () => {
    const { db, runId } = seedState({ commitSha: 'abc1234full', candidates: [{}] })

    // A re-scan of the same revision. Newest by `started_at` wins, and the
    // note is what keeps a stale run from being scored without saying so.
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status, started_at)
       VALUES ('run-2', 'target-1', '{"stage":"scan"}', 'abc1234full', 'complete', '2026-06-01T00:00:00Z')`,
    ).run()
    db.prepare(`UPDATE runs SET started_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(runId)

    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.fixtures[0]!.runId).toBe('run-2')
    expect(report.fixtures[0]!.notes.join(' ')).toContain('2 runs are pinned to this commit')
  })

  test('notes a discovery-only run rather than blaming the models', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      configJson: '{"stage":"scan","staticOnly":true}',
      candidates: [{ startLine: 15 }],
    })
    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.fixtures[0]!.notes.join(' ')).toContain('discovery-only')
  })

  test('says the mode is unknown when the run recorded none', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })
    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.fixtures[0]!.notes.join(' ')).toContain('recorded no mode flags')
  })

  test('carries the author\'s fixture note into the report', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })
    const report = runEval({
      db,
      fixtureSet: oneFixture({ note: 'run this one by hand, the engine is flaky' }),
    })
    expect(report.fixtures[0]!.notes.join(' ')).toContain(
      'fixture note: run this one by hand, the engine is flaky',
    )
  })

  test('notes a run that did not finish', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      runStatus: 'partial',
      candidates: [{}],
    })
    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.fixtures[0]!.notes.join(' ')).toContain('did not finish')
  })

  test('averages recall over the scored fixtures that seed bugs', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      candidates: [{ startLine: 15 }, { startLine: 400 }, { startLine: 401 }],
    })

    const report = runEval({
      db,
      fixtureSet: fixtureSet([
        { id: 'fx-1', project: 'p', commitSha: 'abc1234full', bugs: [BUG], note: null },
        {
          id: 'fx-clean',
          project: 'q',
          commitSha: 'abc1234full',
          bugs: [],
          note: null,
        },
      ]),
    })

    expect(report.scoredFixtures).toBe(2)
    expect(report.totalBugs).toBe(1)
    // The negative control contributes precision, not recall, so the mean is
    // over one fixture rather than two.
    expect(report.recall).toBe(1)
    expect(report.caveats.join(' ')).toContain('contribute only to the precision figures')
  })

  test('fails the gate below D11\'s bar, and passes at it', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      candidates: [{ startLine: 15 }, { startLine: 400 }, { startLine: 401 }, { startLine: 402 }],
    })

    const fourBugs: FixtureSet = fixtureSet([
      {
        id: 'fx-1',
        project: 'p',
        commitSha: 'abc1234full',
        note: null,
        bugs: [
          BUG,
          { ...BUG, id: 'bug-2', files: [{ filePath: 'src/b.c', startLine: 1, endLine: 5, functionName: null }] },
          { ...BUG, id: 'bug-3', files: [{ filePath: 'src/c.c', startLine: 1, endLine: 5, functionName: null }] },
          { ...BUG, id: 'bug-4', files: [{ filePath: 'src/d.c', startLine: 1, endLine: 5, functionName: null }] },
        ],
      },
    ])

    // 1 of 4 seeded bugs surfaced is 0.25.
    const passed = runEval({ db, fixtureSet: fourBugs, minRecall: 0.2 })
    expect(passed.recall).toBe(0.25)
    expect(passed.gate).toBe('pass')

    const failed = runEval({ db, fixtureSet: fourBugs, minRecall: 0.5 })
    expect(failed.gate).toBe('fail')
  })

  test('cannot be a pass when nothing seeds a bug', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })
    const report = runEval({
      db,
      fixtureSet: oneFixture({ bugs: [] }),
    })
    expect(report.recall).toBeNull()
    expect(report.gate).toBe('not-evaluable')
    expect(report.gateReason).toContain('seeds any bug')
  })

  test('always states that precision is a lower bound', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })
    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.caveats[0]).toContain('lower bound')
  })

  test('refuses a --run that does not exist', () => {
    const { db } = seedState({ commitSha: 'abc1234full', candidates: [{}] })
    expect(() => runEval({ db, fixtureSet: oneFixture(), runId: 'run-nope' })).toThrow(
      UnknownRunError,
    )
  })

  test('restricts scoring to one run when asked', () => {
    const { db, runId } = seedState({ commitSha: 'abc1234full', candidates: [{ startLine: 15 }] })
    const report = runEval({ db, fixtureSet: oneFixture(), runId })
    expect(report.fixtures[0]!.runId).toBe(runId)
  })

  test('a rediscovery is surfaced but not discovery', () => {
    const { db } = seedState({
      commitSha: 'abc1234full',
      candidates: [{ startLine: 15, state: 'rediscovery' }],
    })
    const report = runEval({ db, fixtureSet: oneFixture() })
    expect(report.recall).toBe(1)
    expect(report.discoveryRecall).toBe(0)
    expect(report.caveats.join(' ')).toContain('correlation rather than by discovery')
  })
})

describe('loadFixtureSet', () => {
  test('refuses a missing file by name', () => {
    expect(() => loadFixtureSet('/nonexistent/fixtures.json')).toThrow(EvalInputReadError)
  })
})
