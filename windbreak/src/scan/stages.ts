/**
 * Stage table and progress persistence (spec §3.2, §9, §11.3).
 *
 * Progress is written to `run_metrics` **after every stage**, not once at the
 * end. That is what makes `resume` work for the case it actually exists for: a
 * scan that was interrupted (Ctrl-C, a hard failure, a budget abort) leaves
 * records for the stages that finished, so the next invocation knows where it
 * stopped. Writing only on completion would make `resume` useless precisely
 * when it is needed.
 *
 * §11.3 asks for exactly this shape — stage durations and per-stage counts on
 * every run — so the resume bookkeeping and the metrics share one row rather
 * than growing a second table.
 */

import type { Database } from 'bun:sqlite'
import type { StageName } from '../budget'
import { EMPTY_COUNTS } from './types'
import type { ScanCounts, ScanStageId, StageRecord } from './types'

/**
 * The two reasons a stage is skipped *because it was not asked for*, as opposed
 * to skipped because the environment refused it.
 *
 * The distinction carries the run's status, so it is a constant rather than two
 * loose strings at the call site: a `--static-only` scan ran everything that was
 * requested and must not report itself as partial, whereas a scan that skipped
 * triage because no model environment was reachable is genuinely narrower than
 * the one that was asked for.
 */
export const STATIC_ONLY_SKIP = '--static-only'
export const LIBRARY_OPT_IN_SKIP = 'not requested; pass --update-library'

/** True when the stage was skipped by the operator's own request. */
export const skippedByRequest = (record: StageRecord): boolean =>
  record.status === 'skipped' &&
  record.reason !== null &&
  (record.reason === STATIC_ONLY_SKIP || record.reason === LIBRARY_OPT_IN_SKIP)

export interface ScanStageDefinition {
  id: ScanStageId
  /** Short label for the CLI. */
  label: string
  spec: string
  /** The §9 budget stage this consumes, when it consumes one. */
  budgetStage: StageName | null
  /** True when the stage belongs to discovery, i.e. runs under `--static-only`. */
  discovery: boolean
  /** True when the stage cannot run without the model transport. */
  needsModel: boolean
  /**
   * True for a stage that is only attempted when explicitly requested, so a
   * plain `resume` does not start one the first invocation never ran.
   */
  optIn?: boolean
}

/** §3.2's normative order, with §9's budget stage attached to each. */
export const SCAN_STAGES: readonly ScanStageDefinition[] = [
  {
    id: 'ingestion',
    label: 'recon',
    spec: '§4.1',
    budgetStage: 'ingestion',
    discovery: true,
    needsModel: false,
  },
  {
    id: 'known-vuln',
    label: 'osv',
    spec: '§4.2',
    // Host-side and nearly free: §9's table does not give it a share, and it is
    // the reason the table's first row exists for ingestion rather than for
    // correlation.
    budgetStage: null,
    discovery: true,
    needsModel: false,
  },
  {
    id: 'static-core',
    label: 'engines + library replay',
    spec: '§4.3, §4.8',
    budgetStage: 'static-core',
    discovery: true,
    needsModel: false,
  },
  {
    id: 'triage',
    label: 'triage',
    spec: '§4.2, §4.6',
    budgetStage: 'triage',
    discovery: false,
    needsModel: true,
  },
  {
    id: 'verification',
    label: 'verification',
    spec: '§5.2, §5.3',
    budgetStage: 'verification',
    discovery: false,
    needsModel: true,
  },
  {
    id: 'reporting',
    label: 'report',
    spec: '§4.7, §13',
    budgetStage: 'reporting',
    discovery: true,
    needsModel: false,
  },
  {
    id: 'library-update',
    label: 'library update',
    spec: '§3.2 step 8, §10',
    budgetStage: null,
    discovery: false,
    needsModel: true,
    optIn: true,
  },
]

export const stageDefinition = (id: ScanStageId): ScanStageDefinition =>
  SCAN_STAGES.find((stage) => stage.id === id)!

/**
 * The first stage still worth running.
 *
 * Only `complete` counts as done. `partial` (OSV was unreachable, a model call
 * failed), `skipped`, `failed`, and `aborted` are all retried, because each is
 * a statement about the previous invocation's circumstances — an unreachable
 * network, a missing credential, a spent budget — and not about the target.
 * Retrying is also cheap where it matters: the pipeline selects its input by
 * `triage IS NULL` and `state = 'triaged'`, so work already done is not redone.
 */
export const firstIncompleteStage = (
  records: readonly StageRecord[],
  options: { includeOptIn: boolean },
): ScanStageId | null => {
  const byId = new Map(records.map((record) => [record.stage, record]))

  for (const stage of SCAN_STAGES) {
    if (stage.optIn && !options.includeOptIn) continue
    const record = byId.get(stage.id)
    if (!record || record.status !== 'complete') return stage.id
  }

  return null
}

/**
 * Seconds already spent per §9 stage, so a resumed governor continues each
 * stage's clock instead of restarting it.
 */
export const carriedElapsedSeconds = (
  records: readonly StageRecord[],
): Partial<Record<StageName, number>> => {
  const elapsed: Partial<Record<StageName, number>> = {}

  for (const record of records) {
    const definition = SCAN_STAGES.find((stage) => stage.id === record.stage)
    if (!definition?.budgetStage) continue
    elapsed[definition.budgetStage] =
      (elapsed[definition.budgetStage] ?? 0) + record.durationMs / 1000
  }

  return elapsed
}

export interface RunMetrics {
  stages: StageRecord[]
  counts: Partial<ScanCounts>
  cacheHitRate: number | null
  models: Array<{ role: string; modelId: string; provider: string }>
}

/** Upsert the run's metrics. Called after every stage, not only at the end. */
export const writeRunMetrics = (input: {
  db: Database
  runId: string
  stages: readonly StageRecord[]
  counts: Partial<ScanCounts>
  cacheHitRate: number | null
  models: RunMetrics['models']
}): void => {
  input.db
    .prepare(
      `INSERT OR REPLACE INTO run_metrics
         (run_id, stage_json, counts_json, cache_hit_rate, models_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      JSON.stringify(input.stages),
      JSON.stringify(input.counts),
      input.cacheHitRate,
      JSON.stringify(input.models),
    )
}

export const readRunMetrics = (db: Database, runId: string): RunMetrics => {
  const row = db
    .query<
      {
        stage_json: string
        counts_json: string
        cache_hit_rate: number | null
        models_json: string | null
      },
      [string]
    >(
      `SELECT stage_json, counts_json, cache_hit_rate, models_json
         FROM run_metrics WHERE run_id = ?`,
    )
    .get(runId)

  if (!row) return { stages: [], counts: {}, cacheHitRate: null, models: [] }

  const parse = <T>(json: string, fallback: T): T => {
    try {
      return JSON.parse(json) as T
    } catch {
      return fallback
    }
  }

  return {
    stages: parse<StageRecord[]>(row.stage_json, []),
    counts: parse<Partial<ScanCounts>>(row.counts_json, {}),
    cacheHitRate: row.cache_hit_rate,
    models: row.models_json
      ? parse<RunMetrics['models']>(row.models_json, [])
      : [],
  }
}

/**
 * Which models this run actually used, read from its verdicts rather than from
 * the config (§11.3). A config change mid-run must not be able to rewrite the
 * record of what produced the recorded verdicts.
 */
export const modelsUsedByRun = (
  db: Database,
  runId: string,
): RunMetrics['models'] =>
  db
    .query<
      { role: string; model_id: string; provider: string },
      [string]
    >(
      `SELECT DISTINCT v.role AS role, v.model_id AS model_id, v.provider AS provider
         FROM verdicts v JOIN candidates c ON c.id = v.candidate_id
        WHERE c.run_id = ?
        ORDER BY v.role`,
    )
    .all(runId)
    .map((row) => ({ role: row.role, modelId: row.model_id, provider: row.provider }))

/**
 * Derive the run's aggregate counters from its stage records.
 *
 * Derived rather than accumulated while running, because a run can be executed
 * across several invocations: `resume` re-runs only the stages that are not
 * complete, yet §11.3's numbers are about the *run*. An accumulator would
 * therefore report zeros for every stage some earlier invocation performed. The
 * stage records are the record of what each stage found, so they are the right
 * source, and they are already persisted after every stage.
 *
 * Later records win, so a re-run's numbers replace the numbers they supersede.
 */
export const deriveCounts = (records: readonly StageRecord[]): ScanCounts => {
  const counts: ScanCounts = { ...EMPTY_COUNTS }

  for (const record of records) {
    const at = record.counts
    switch (record.stage) {
      case 'ingestion':
        counts.filesIndexed = at.files ?? counts.filesIndexed
        counts.symbols = at.symbols ?? counts.symbols
        counts.callSites = at.callSites ?? counts.callSites
        break
      case 'static-core':
        counts.replays = at.variants ?? 0
        counts.patchMined = at.patchMined ?? 0
        counts.patchPatterns = at.patchPatterns ?? 0
        counts.toctou = at.toctou ?? 0
        counts.toctouRules = at.toctouRules ?? 0
        counts.toctouFsm = at.toctouFsm ?? 0
        counts.toctouAtomicity = at.toctouAtomicity ?? 0
        counts.toctouSignal = at.toctouSignal ?? 0
        counts.signalHandlers = at.signalHandlers ?? 0
        // Four producers feed the same candidate set: the engines, §4.4.1's
        // patch-mined sweep, §4.4.3's check-to-use stage, and §4.8's library replay.
        // They are counted separately in the stage record because they answer
        // different questions, and summed here because §11.3's candidate count is
        // about the run.
        counts.candidates =
          (at.candidates ?? 0) + counts.replays + counts.patchMined + counts.toctou
        break
      case 'triage':
        counts.triaged = at.processed ?? 0
        counts.rediscovery = at.rediscovery ?? 0
        break
      case 'verification':
        counts.confirmed = at.confirmed ?? 0
        counts.dropped = at.dropped ?? 0
        counts.escalated = at.escalated ?? 0
        break
      case 'reporting':
        counts.findings = at.findings ?? 0
        counts.excluded = at.excluded ?? 0
        break
      default:
        break
    }
  }

  return counts
}
