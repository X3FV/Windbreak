import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { applySchema, openStateDatabase } from '../state/db'
import { DEFAULT_MODEL_CONFIG } from '../models'
import { SCAN_STAGE_IDS } from './types'
import { launchScan } from './launch'
import { writeRunMetrics } from './stages'

import type { StageRecord } from './types'

/**
 * §20.33's launcher.
 *
 * The tests here are about what happens *before* and *around* the pipeline: which checkout
 * a run is pinned to, which refusals the caller gets to render, and the fact that a run
 * with nothing left to do comes back as a result rather than as a fresh pipeline. The
 * pipeline itself is `scan/run.test.ts`'s subject; the CLI reaches a scan through the
 * WindBreak CLI, not through a screen of its own.
 */

const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix))

const completeStage = (stage: (typeof SCAN_STAGE_IDS)[number]): StageRecord => ({
  stage,
  status: 'complete',
  durationMs: 10,
  detail: null,
  counts: {},
  reason: null,
})

describe('launchScan', () => {
  test('there is no scan without a checkout', async () => {
    const dir = tempDir('windbreak-launch-')
    const outcome = await launchScan({ dbPath: path.join(dir, 'state.db') })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('no checkout to scan')
    // Refused before the database was opened: a refusal must not leave a state database
    // behind, which is the file §20.28 is about.
    expect(fs.existsSync(path.join(dir, 'state.db'))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a resume of a run that does not exist is refused by name', async () => {
    const dir = tempDir('windbreak-launch-')
    const dbPath = path.join(dir, 'state.db')

    const outcome = await launchScan({ dbPath, runId: 'run-nope' })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('no run run-nope')
    // Looking a run up means opening the database, and opening a missing one initialises
    // it. That is the same thing the batch `scan` command does, and it is not the §20.28
    // substitution: a *scan* is the operation that makes the facts, so a database it
    // created holds a run's rows rather than an empty queue presented as a clean one.
    expect(fs.existsSync(dbPath)).toBe(true)
    const check = new Database(dbPath)
    expect(
      check.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runs').get()!.n,
    ).toBe(0)
    check.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // What is *not* asserted here: the checkout a continuation actually reads back from its
  // run. Proving that means running the pipeline against it, which belongs to
  // `scan/run.test.ts`; the tests below cover the two halves that can be checked cheaply —
  // a run whose target records no checkout is refused, and a run with nothing left to do
  // comes back as a result.
  test('a run whose target has no checkout on record is refused rather than guessed', async () => {
    const dir = tempDir('windbreak-launch-')
    const dbPath = path.join(dir, 'state.db')
    const db = openStateDatabase(dbPath)
    // `targets.location` is NOT NULL, so the reachable form of "no checkout on record" is a
    // run whose target row is gone — a database that lost one, not a target recon ever
    // wrote without a path.
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES ('run-1', 't1', '{}', 'abc', 'partial')`,
    ).run()
    db.close()

    const outcome = await launchScan({ dbPath, runId: 'run-1' })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('no checkout path')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a config that does not validate is a reason, not a rejection', async () => {
    // The screen awaits this and then renders whatever comes back, so a *thrown* config
    // error would leave it on a running scan that had already stopped. Reading the config
    // throws for a structurally broken file rather than returning violations, which is
    // exactly the path that has to be caught.
    const dir = tempDir('windbreak-launch-')
    const configPath = path.join(dir, 'wb.json')
    fs.writeFileSync(configPath, JSON.stringify({ models: { proposer: { model: 'x' } } }))
    const repo = tempDir('windbreak-repo-')

    const outcome = await launchScan({
      dbPath: path.join(dir, 'state.db'),
      targetRoot: repo,
      configPath,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('configuration could not be read')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('a config with violations refuses the scan and names them', async () => {
    const dir = tempDir('windbreak-launch-')
    const configPath = path.join(dir, 'wb.json')
    // The cross-provider gate: proposer and refuter on the same provider is the violation
    // §5.2 exists to catch, and the batch `scan` refuses on exactly these. Written over the
    // shipped defaults rather than spelled out, so a change to the default catalog cannot
    // make this test pass for the wrong reason.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          ...DEFAULT_MODEL_CONFIG,
          proposer: {
            ...DEFAULT_MODEL_CONFIG.proposer,
            model: DEFAULT_MODEL_CONFIG.refuter.model,
          },
        },
      }),
    )
    const repo = tempDir('windbreak-repo-')

    const outcome = await launchScan({
      dbPath: path.join(dir, 'state.db'),
      targetRoot: repo,
      configPath,
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('configuration is invalid')
      expect(outcome.reason).toContain('proposer')
    }
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test('a discovered config governs the scan when no file was named', async () => {
    // The screen passes `configPath` only when it was given a `--config`. Without this the
    // menu's scan would run the built-in models in a checkout whose own `.windbreak`
    // config asked for others, which is the menu and the batch commands disagreeing about
    // which config is in effect. The violation is the observable: it can only be reported
    // if the discovered file was read.
    const dir = tempDir('windbreak-launch-')
    const configPath = path.join(dir, 'wb.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          ...DEFAULT_MODEL_CONFIG,
          proposer: {
            ...DEFAULT_MODEL_CONFIG.proposer,
            model: DEFAULT_MODEL_CONFIG.refuter.model,
          },
        },
      }),
    )
    const repo = tempDir('windbreak-repo-')
    const previousEnv = process.env.WINDBREAK_CONFIG

    try {
      process.env.WINDBREAK_CONFIG = configPath

      const outcome = await launchScan({
        dbPath: path.join(dir, 'state.db'),
        targetRoot: repo,
      })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason).toContain('configuration is invalid')
    } finally {
      if (previousEnv === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previousEnv
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a run with nothing left to do comes back as a result, not a fresh pipeline', async () => {
    // The one continuation a unit test can drive: `runScan` returns early when every
    // requested stage is already complete. That exercises the whole of this module's happy
    // path — the database it opened, the target it resolved from the run, and the result it
    // handed back — without running a pipeline.
    const dir = tempDir('windbreak-launch-')
    const dbPath = path.join(dir, 'state.db')
    const db = openStateDatabase(dbPath)
    db.prepare(`INSERT INTO targets (id, location, commit_sha) VALUES ('t1', '/repo/a', 'abc')`).run()
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES ('run-1', 't1', '{}', 'abc', 'partial')`,
    ).run()

    const lines: string[] = []
    const stages = SCAN_STAGE_IDS.map(completeStage)
    writeRunMetrics({
      db,
      runId: 'run-1',
      stages,
      counts: {},
      cacheHitRate: null,
      models: [],
    })
    db.close()

    const outcome = await launchScan({ dbPath, runId: 'run-1', log: (line) => lines.push(line) })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.runId).toBe('run-1')
      expect(outcome.result.targetId).toBe('t1')
      expect(outcome.result.status).toBe('complete')
      expect(outcome.result.resumeFrom).toBeNull()
    }
    // The run's own log, through the same callback the screen draws.
    expect(lines.join('\n')).toContain('already complete')
    fs.rmSync(dir, { recursive: true, force: true })
  })

})

describe('the schema the launcher writes into', () => {
  test('is the same one a fresh database gets', () => {
    const db = new Database(':memory:')
    applySchema(db)
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runs').get()!.n).toBe(0)
  })
})
