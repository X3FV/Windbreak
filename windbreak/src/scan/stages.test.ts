import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { applySchema } from '../state/db'

import {
  carriedElapsedSeconds,
  deriveCounts,
  firstIncompleteStage,
  LIBRARY_OPT_IN_SKIP,
  modelsUsedByRun,
  readRunMetrics,
  SCAN_STAGES,
  skippedByRequest,
  STATIC_ONLY_SKIP,
  writeRunMetrics,
} from './stages'

import type { StageRecord } from './types'

const record = (
  stage: StageRecord['stage'],
  status: StageRecord['status'],
  extra: Partial<StageRecord> = {},
): StageRecord => ({
  stage,
  status,
  durationMs: 1000,
  detail: null,
  counts: {},
  reason: null,
  ...extra,
})

const everyStage = (status: StageRecord['status']): StageRecord[] =>
  SCAN_STAGES.map((stage) => record(stage.id, status))

describe('firstIncompleteStage', () => {
  test('an unstarted run starts at ingestion', () => {
    expect(firstIncompleteStage([], { includeOptIn: false })).toBe('ingestion')
  })

  test('a fully complete run has nothing left', () => {
    const records = SCAN_STAGES.filter((stage) => !stage.optIn).map((stage) =>
      record(stage.id, 'complete'),
    )
    expect(firstIncompleteStage(records, { includeOptIn: false })).toBeNull()
  })

  test('partial counts as incomplete, because it describes the invocation rather than the target', () => {
    const records = SCAN_STAGES.filter((stage) => !stage.optIn).map((stage) =>
      record(stage.id, stage.id === 'known-vuln' ? 'partial' : 'complete'),
    )
    expect(firstIncompleteStage(records, { includeOptIn: false })).toBe('known-vuln')
  })

  test('a stage skipped by request is still retried, so a later scan can do more', () => {
    const records = SCAN_STAGES.filter((stage) => !stage.optIn).map((stage) =>
      record(
        stage.id,
        stage.needsModel ? 'skipped' : 'complete',
        stage.needsModel ? { reason: STATIC_ONLY_SKIP } : {},
      ),
    )
    expect(firstIncompleteStage(records, { includeOptIn: false })).toBe('triage')
  })

  test('the opt-in library update only ends the chain when it was requested', () => {
    const records = SCAN_STAGES.filter((stage) => !stage.optIn).map((stage) =>
      record(stage.id, 'complete'),
    )
    expect(firstIncompleteStage(records, { includeOptIn: false })).toBeNull()
    expect(firstIncompleteStage(records, { includeOptIn: true })).toBe('library-update')
  })

  test('the order is §3.2\u2019s, not the order the records arrive in', () => {
    expect(firstIncompleteStage(
      [record('reporting', 'complete'), record('verification', 'failed')],
      { includeOptIn: false },
    )).toBe('ingestion')
  })
})

describe('carriedElapsedSeconds', () => {
  test('sums each stage group\u2019s recorded duration', () => {
    const elapsed = carriedElapsedSeconds([
      record('ingestion', 'complete', { durationMs: 61_000 }),
      record('static-core', 'failed', { durationMs: 120_000 }),
      record('triage', 'complete', { durationMs: 30_000 }),
    ])

    expect(elapsed.ingestion).toBeCloseTo(61, 5)
    expect(elapsed['static-core']).toBeCloseTo(120, 5)
    expect(elapsed.triage).toBeCloseTo(30, 5)
  })

  test('stages §9 does not budget contribute nothing', () => {
    const elapsed = carriedElapsedSeconds([
      record('known-vuln', 'complete', { durationMs: 5_000 }),
      record('library-update', 'complete', { durationMs: 9_000 }),
    ])

    expect(Object.keys(elapsed)).toEqual([])
  })
})

describe('skippedByRequest', () => {
  test('distinguishes the operator\u2019s choice from the environment\u2019s refusal', () => {
    expect(skippedByRequest(record('triage', 'skipped', { reason: STATIC_ONLY_SKIP }))).toBe(true)
    expect(skippedByRequest(record('library-update', 'skipped', { reason: LIBRARY_OPT_IN_SKIP }))).toBe(true)
    expect(
      skippedByRequest(record('triage', 'skipped', { reason: 'no model invoker is available' })),
    ).toBe(false)
    expect(skippedByRequest(record('triage', 'complete'))).toBe(false)
  })
})

describe('deriveCounts', () => {
  test('reads the run\u2019s totals out of its stage records', () => {
    const counts = deriveCounts([
      record('ingestion', 'complete', {
        counts: { files: 12, symbols: 40, callSites: 90 },
      }),
      record('static-core', 'complete', { counts: { candidates: 3, variants: 2 } }),
      record('triage', 'complete', { counts: { processed: 4, rediscovery: 1 } }),
      record('verification', 'complete', {
        counts: { confirmed: 1, dropped: 2, escalated: 1 },
      }),
      record('reporting', 'complete', { counts: { findings: 1, excluded: 3 } }),
    ])

    expect(counts).toEqual({
      filesIndexed: 12,
      symbols: 40,
      callSites: 90,
      // `candidates` is the whole worklist: engine hits plus §4.4.1's patch-mined
      // sweep plus §4.4.3's check-to-use stage plus replayed variants. This record
      // has neither of the later two, which is what a pre-§4.4.1 run's metrics look
      // like.
      candidates: 5,
      replays: 2,
      patchMined: 0,
      patchPatterns: 0,
      toctou: 0,
      toctouRules: 0,
      toctouFsm: 0,
      toctouAtomicity: 0,
      toctouSignal: 0,
      toctouInterproc: 0,
      signalHandlers: 0,
      callEdges: 0,
      callSitesSeen: 0,
      callSitesUnattributed: 0,
      callSitesAmbiguous: 0,
      callerGuardedSites: 0,
      entryPoints: 0,
      reachCallables: 0,
      reachAttackerInput: 0,
      reachExposedApi: 0,
      reachUnreachable: 0,
      reachUnknown: 0,
      reachTaintRoots: 0,
      reachExternalCallees: 0,
      reachQualifiedCallees: 0,
      triaged: 4,
      confirmed: 1,
      dropped: 2,
      escalated: 1,
      rediscovery: 1,
      findings: 1,
      excluded: 3,
    })
  })

  test('stages that never ran leave zeros rather than stale numbers', () => {
    const counts = deriveCounts([record('ingestion', 'complete', { counts: { files: 7 } })])
    expect(counts.filesIndexed).toBe(7)
    expect(counts.candidates).toBe(0)
    expect(counts.findings).toBe(0)
  })

  test('a re-run supersedes the numbers it replaces', () => {
    const counts = deriveCounts([
      record('static-core', 'complete', { counts: { candidates: 9, variants: 0 } }),
      record('static-core', 'partial', { counts: { candidates: 4, variants: 1 } }),
    ])
    expect(counts.candidates).toBe(5)
    expect(counts.replays).toBe(1)
  })
})

describe('run metrics', () => {
  const fresh = (): Database => {
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('t1', '/tmp/t1')
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES ('r1', 't1', '{}', 'abc', 'running')`,
    ).run()
    return db
  }

  test('round-trips stages and counts', () => {
    const db = fresh()
    const stages = [record('ingestion', 'complete', { counts: { files: 2 }, detail: '2 files' })]

    writeRunMetrics({
      db,
      runId: 'r1',
      stages,
      counts: { filesIndexed: 2 },
      cacheHitRate: 0.5,
      models: [{ role: 'triage', modelId: 'm', provider: 'p' }],
    })

    const read = readRunMetrics(db, 'r1')
    expect(read.stages).toEqual(stages)
    expect(read.counts.filesIndexed).toBe(2)
    expect(read.cacheHitRate).toBe(0.5)
    expect(read.models).toEqual([{ role: 'triage', modelId: 'm', provider: 'p' }])
    db.close()
  })

  test('a run with no metrics row reports nothing rather than throwing', () => {
    const db = fresh()
    expect(readRunMetrics(db, 'missing')).toEqual({
      stages: [],
      counts: {},
      cacheHitRate: null,
      models: [],
    })
    db.close()
  })

  test('unreadable JSON degrades to empty instead of failing a resume', () => {
    const db = fresh()
    db.prepare(
      `INSERT INTO run_metrics (run_id, stage_json, counts_json, cache_hit_rate, models_json)
       VALUES ('r1', 'not json', 'not json', NULL, 'not json')`,
    ).run()

    expect(readRunMetrics(db, 'r1')).toEqual({
      stages: [],
      counts: {},
      cacheHitRate: null,
      models: [],
    })
    db.close()
  })

  test('models come from the run\u2019s verdicts, not from the config', () => {
    const db = fresh()
    db.prepare(
      `INSERT INTO candidates (id, run_id, source, pattern_id, file_path, start_line, end_line,
                               cwe, normalized_json, state)
       VALUES ('cand-1', 'r1', 'semgrep', 'p', 'src/a.c', 1, 1, NULL, '{}', 'triaged')`,
    ).run()

    const insertVerdict = db.prepare(
      `INSERT INTO verdicts
         (id, candidate_id, stage, role, model_id, provider, temperature, seed,
          seed_supported, cache_key, output_json)
       VALUES (?, 'cand-1', 'triage', ?, ?, ?, 0, NULL, 0, ?, '{}')`,
    )
    insertVerdict.run('v1', 'triage', 'model-a', 'vendor-a', 'k1')
    insertVerdict.run('v2', 'refuter', 'model-b', 'vendor-b', 'k2')
    insertVerdict.run('v3', 'triage', 'model-a', 'vendor-a', 'k3')

    expect(modelsUsedByRun(db, 'r1')).toEqual([
      { role: 'refuter', modelId: 'model-b', provider: 'vendor-b' },
      { role: 'triage', modelId: 'model-a', provider: 'vendor-a' },
    ])
    db.close()
  })
})
