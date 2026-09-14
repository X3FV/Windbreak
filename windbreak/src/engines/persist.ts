import { createHash } from 'crypto'

import type { Database } from 'bun:sqlite'
import type { Candidate, CandidateSource } from './types'

/**
 * Run and candidate persistence (spec §14.1).
 *
 * A run row is required before candidates can exist: `candidates.run_id`
 * references `runs(id)`, and the budget governor records `budget_events`
 * against the same run. Candidate ids include the run id, so re-running a stage
 * keeps both runs' candidates rather than one overwriting the other — §11.3
 * compares runs across invocations, which needs them to coexist.
 */

export const createRun = (input: {
  db: Database
  targetId: string
  commitSha: string
  config: unknown
  cacheDisabled?: boolean
}): string => {
  const startedAt = new Date().toISOString()
  const id = `run_${createHash('sha256')
    .update(`${input.targetId}:${input.commitSha}:${startedAt}`)
    .digest('hex')
    .slice(0, 24)}`

  input.db
    .prepare(
      `INSERT INTO runs
         (id, target_id, started_at, finished_at, config_json, commit_sha, cache_disabled, status)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.targetId,
      startedAt,
      JSON.stringify(input.config),
      input.commitSha,
      input.cacheDisabled ? 1 : 0,
      'running',
    )

  return id
}

export const finishRun = (
  db: Database,
  runId: string,
  status: string,
): void => {
  db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(
    status,
    new Date().toISOString(),
    runId,
  )
}

export interface PersistCandidatesResult {
  inserted: number
  bySource: Record<string, number>
}

export const persistCandidates = (input: {
  db: Database
  runId: string
  candidates: readonly Candidate[]
}): PersistCandidatesResult => {
  const statement = input.db.prepare(
    `INSERT OR REPLACE INTO candidates
       (id, run_id, source, pattern_id, origin_patch_sha, file_path, start_line, end_line,
        cwe, normalized_json, injection_signals_json, state, osv_match_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )

  const bySource: Record<string, number> = {}

  input.db.transaction(() => {
    for (const candidate of input.candidates) {
      statement.run(
        candidate.id,
        input.runId,
        candidate.source,
        candidate.patternId,
        // Engine candidates carry no originating patch; variant-hunt candidates
        // record the revision their pattern was mined from (§10).
        candidate.originPatchSha ?? null,
        candidate.filePath,
        candidate.startLine,
        candidate.endLine,
        candidate.cwe,
        JSON.stringify(candidate.normalized),
        candidate.injectionSignals.length > 0
          ? JSON.stringify(candidate.injectionSignals)
          : null,
        candidate.state,
      )
      bySource[candidate.source] = (bySource[candidate.source] ?? 0) + 1
    }
  })()

  return { inserted: input.candidates.length, bySource }
}

export interface CandidateSummary {
  total: number
  bySource: Array<{ source: CandidateSource; count: number }>
  withInjectionSignals: number
}

export const readCandidateSummary = (
  db: Database,
  runId: string,
): CandidateSummary => {
  const bySource = db
    .query<{ source: string; count: number }, [string]>(
      `SELECT source, COUNT(*) AS count FROM candidates WHERE run_id = ? GROUP BY source ORDER BY source`,
    )
    .all(runId)

  return {
    total: bySource.reduce((total, row) => total + row.count, 0),
    bySource: bySource.map((row) => ({
      source: row.source as CandidateSource,
      count: row.count,
    })),
    withInjectionSignals:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM candidates WHERE run_id = ? AND injection_signals_json IS NOT NULL`,
        )
        .get(runId)?.n ?? 0,
  }
}
