import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
  formatSeconds,
} from './governor'
import { DEFAULT_STAGE_SHARES } from './types'
import { applySchema } from '../state/db'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  applySchema(db)
  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    'target-1',
    '/virtual',
  )
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status) VALUES ('run-1', 'target-1', '{}', 'abc', 'running')`,
  ).run()
})

describe('quota', () => {
  test('derives stage quotas from the §9 shares', () => {
    const governor = createBudgetGovernor({ totalSeconds: 3600 })

    expect(governor.quotaSeconds('static-core')).toBe(900)
    expect(governor.quotaSeconds('verification')).toBe(1440)
    expect(governor.quotaSeconds('ingestion')).toBe(360)
  })

  test('lets config override a share without disturbing the others', () => {
    const governor = createBudgetGovernor({
      totalSeconds: 1000,
      shares: { 'static-core': 0.5 },
    })

    expect(governor.quotaSeconds('static-core')).toBe(500)
    expect(governor.quotaSeconds('triage')).toBe(
      Math.round(1000 * DEFAULT_STAGE_SHARES.triage),
    )
  })
})

describe('session', () => {
  test('reports elapsed time and exhaustion from the injected clock', () => {
    let now = 1_000_000
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { 'static-core': 1 },
      now: () => now,
    })

    const session = governor.session('static-core')
    expect(session.elapsedSeconds()).toBe(0)
    expect(session.exhausted()).toBe(false)

    now += 60_000
    expect(session.elapsedSeconds()).toBeCloseTo(60, 5)
    expect(session.exhausted()).toBe(false)

    now += 50_000
    expect(session.exhausted()).toBe(true)
    expect(session.remainingMs()).toBe(0)
  })

  test('allowMs caps the work unit at the remaining quota', () => {
    let now = 0
    const governor = createBudgetGovernor({
      totalSeconds: 1000,
      shares: { 'static-core': 1 },
      now: () => now,
    })

    const session = governor.session('static-core')

    // Fresh: the unit's own ceiling wins.
    expect(session.allowMs(600)).toBe(600_000)

    // 900s in: only 100s remain, so the quota wins.
    now = 900_000
    expect(session.allowMs(600)).toBe(100_000)
  })

  test('reusing a stage shares one quota rather than granting a second', () => {
    let now = 0
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      now: () => now,
    })

    const first = governor.session('static-core')
    now = 10_000
    const second = governor.session('static-core')

    expect(first.quotaSeconds).toBe(second.quotaSeconds)
    expect(second.elapsedSeconds()).toBeCloseTo(10, 5)
  })
})

describe('resolveOverrun', () => {
  test('records the decision and persists a budget event', async () => {
    const governor = createBudgetGovernor({
      totalSeconds: 3600,
      db,
      runId: 'run-1',
      decide: async () => ({ action: 'continue', decidedBy: 'human' }),
    })

    const action = await governor.resolveOverrun('static-core', 905)

    expect(action).toBe('continue')
    expect(governor.events()).toHaveLength(1)
    expect(governor.events()[0]).toMatchObject({
      stage: 'static-core',
      quotaSeconds: 900,
      elapsedSeconds: 905,
      action: 'continue',
      decidedBy: 'human',
    })

    const row = db
      .query<{ action: string; decided_by: string }, []>(
        'SELECT action, decided_by FROM budget_events',
      )
      .get()
    expect(row).toEqual({ action: 'continue', decided_by: 'human' })
  })

  test('reports the remaining target budget after the overrunning stage', async () => {
    let seen: { remainingTargetSeconds: number } | null = null
    const governor = createBudgetGovernor({
      totalSeconds: 3600,
      decide: async (request) => {
        seen = { remainingTargetSeconds: request.remainingTargetSeconds }
        return { action: 'degrade', decidedBy: 'human' }
      },
    })

    // static-core quota is 900s; spending 900 leaves 2700.
    await governor.resolveOverrun('static-core', 900)

    expect(seen!.remainingTargetSeconds).toBeCloseTo(2700, 5)
  })

  test('passes the action through unchanged', async () => {
    const governor = createBudgetGovernor({
      totalSeconds: 3600,
      decide: async () => ({ action: 'abort', decidedBy: 'human' }),
    })

    expect(await governor.resolveOverrun('triage', 400)).toBe('abort')
  })
})

describe('deciders', () => {
  test('a non-TTY prompt degrades rather than waiting on input', async () => {
    const decide = createInteractiveDecider({ isTty: false })
    const result = await decide({
      stage: 'static-core',
      elapsedSeconds: 901,
      quotaSeconds: 900,
      remainingTargetSeconds: 2699,
    })

    expect(result).toEqual({
      action: 'degrade',
      decidedBy: 'policy:non-interactive',
    })
  })

  test('--yes degrades and says so', async () => {
    const decide = createNonInteractiveDecider('policy:--yes')
    const result = await decide({
      stage: 'static-core',
      elapsedSeconds: 901,
      quotaSeconds: 900,
      remainingTargetSeconds: 2699,
    })

    expect(result).toEqual({ action: 'degrade', decidedBy: 'policy:--yes' })
  })
})

describe('formatSeconds', () => {
  test('renders minutes and seconds', () => {
    expect(formatSeconds(900)).toBe('15m00s')
    expect(formatSeconds(45)).toBe('45s')
    expect(formatSeconds(-5)).toBe('0s')
  })
})
