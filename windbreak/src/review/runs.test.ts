import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { applySchema } from '../state/db'

import { readReviewRuns } from './runs'
import { reviewSessionFor } from './session'

/**
 * §20.33's run listing.
 *
 * What is asserted is mostly about *absence* being legible, because that is where this
 * list can lie: a run that escalated nothing has no queue rows, and a run that never
 * finished has no `finished_at`. Both must still appear, with counters that say zero
 * rather than a row missing, or the screen would offer a list that looks like the whole
 * database and is not.
 */

const seed = () => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)

  db.prepare(
    `INSERT INTO targets (id, location, commit_sha) VALUES ('t1', '/repo/a', 'aaa')`,
  ).run()
  db.prepare(
    `INSERT INTO targets (id, location, commit_sha) VALUES ('t2', '/repo/b', 'bbb')`,
  ).run()

  // The newest run, complete, with one decided disagreement and one still pending.
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status, started_at, finished_at)
     VALUES ('run-2', 't2', '{}', 'bbb', 'complete', '2026-09-13T10:00:00Z', '2026-09-13T10:20:00Z')`,
  ).run()
  db.prepare(
    `INSERT INTO candidates (id, run_id, source, normalized_json, state)
     VALUES ('c-1', 'run-2', 'semgrep', '{}', 'escalated'),
            ('c-2', 'run-2', 'semgrep', '{}', 'escalated'),
            ('c-3', 'run-2', 'semgrep', '{}', 'confirmed')`,
  ).run()
  db.prepare(
    `INSERT INTO adjudication_queue (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id, decision)
     VALUES ('c-1', 'run-2', 'v1', 'v2', 'real'),
            ('c-2', 'run-2', 'v3', 'v4', NULL)`,
  ).run()

  // An older run that never finished and escalated nothing: it must survive both facts.
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status, started_at, finished_at)
     VALUES ('run-1', 't1', '{}', 'aaa', 'partial', '2026-09-12T09:00:00Z', NULL)`,
  ).run()

  return db
}

describe('readReviewRuns', () => {
  test('lists newest first, with the checkout each run was pinned to', () => {
    const runs = readReviewRuns(seed())

    expect(runs.map((run) => run.runId)).toEqual(['run-2', 'run-1'])
    expect(runs[0]).toMatchObject({
      targetId: 't2',
      targetLocation: '/repo/b',
      commitSha: 'bbb',
      status: 'complete',
      finishedAt: '2026-09-13T10:20:00Z',
    })
  })

  test('counts disagreements and how many are decided', () => {
    const runs = readReviewRuns(seed())
    // Three candidates, but only two were escalated to §5.3 — a confirmed candidate is
    // not a disagreement, and counting it would overstate what there is to work.
    expect(runs[0]).toMatchObject({ queued: 2, resolved: 1 })
  })

  test('a run that escalated nothing is still a run', () => {
    const runs = readReviewRuns(seed())
    expect(runs[1]).toMatchObject({
      runId: 'run-1',
      status: 'partial',
      queued: 0,
      resolved: 0,
      finishedAt: null,
    })
  })

  test('a run whose target row is gone names no checkout rather than guessing one', () => {
    const db = seed()
    db.prepare(`DELETE FROM targets WHERE id = 't1'`).run()

    expect(readReviewRuns(db).find((run) => run.runId === 'run-1')!.targetLocation).toBeNull()
  })

  test('the session exposes the same list, so the screen needs no second connection', () => {
    const db = seed()
    expect(reviewSessionFor(db).runs().map((run) => run.runId)).toEqual(['run-2', 'run-1'])
  })
})
