/**
 * The reads §11 scores over.
 *
 * Two of these columns are load-bearing and easy to get wrong:
 *
 * - `rediscovery` is `state = 'rediscovery'`, which is exactly what
 *   `markRediscovery` writes. Deriving it instead from `osv_match_json` would
 *   work today and break the moment §4.2 tags something without routing it away
 *   from verification, and the difference would show up only as a slightly
 *   flattering recall figure.
 * - `queuedForAdjudication` comes from `adjudication_queue`, not from state.
 *   §5.3 sets `confirmed` both when a human agrees with an escalation and when
 *   two models simply agreed, so state cannot say whether the human stage
 *   existed at all.
 */

import { isModelProposed } from '../engines/types'

import type { Database } from 'bun:sqlite'
import type { AdjudicationDecision } from '../pipeline'
import type { EvalCandidate, EvalRun } from './types'

interface RunRow {
  id: string
  target_id: string
  commit_sha: string
  status: string
  started_at: string | null
  config_json: string
  candidates: number
}

/**
 * `staticOnly` out of a run's recorded config.
 *
 * Null rather than false when the key is absent, because a run made by one of
 * the individual stage commands records `{ stage: 'triage' }` and never
 * considered the flag at all — and "the run did not say" must not be read as
 * "the run was full-pipeline".
 */
const staticOnlyFrom = (configJson: string): boolean | null => {
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (parsed === null || typeof parsed !== 'object') return null
    const value = (parsed as Record<string, unknown>).staticOnly
    return typeof value === 'boolean' ? value : null
  } catch {
    return null
  }
}

export const readEvalRuns = (db: Database): EvalRun[] =>
  db
    .query<RunRow, []>(
      `SELECT r.id, r.target_id, r.commit_sha, r.status, r.started_at, r.config_json,
              (SELECT COUNT(*) FROM candidates c WHERE c.run_id = r.id) AS candidates
         FROM runs r
        ORDER BY r.started_at DESC, r.id DESC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      targetId: row.target_id,
      commitSha: row.commit_sha,
      status: row.status,
      startedAt: row.started_at,
      candidates: row.candidates,
      staticOnly: staticOnlyFrom(row.config_json),
    }))

interface CandidateRow {
  id: string
  source: string
  file_path: string | null
  start_line: number | null
  end_line: number | null
  state: string
  triage: string | null
  queued: number
  decision: string | null
}

export const readEvalCandidates = (db: Database, runId: string): EvalCandidate[] =>
  db
    .query<CandidateRow, [string]>(
      `SELECT c.id, c.source, c.file_path, c.start_line, c.end_line, c.state, c.triage,
              CASE WHEN q.candidate_id IS NULL THEN 0 ELSE 1 END AS queued,
              q.decision AS decision
         FROM candidates c
         LEFT JOIN adjudication_queue q ON q.candidate_id = c.id
        WHERE c.run_id = ?
        ORDER BY c.file_path, c.start_line, c.id`,
    )
    .all(runId)
    .map((row) => ({
      id: row.id,
      source: row.source,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      state: row.state,
      triage: row.triage,
      rediscovery: row.state === 'rediscovery',
      modelProposed: isModelProposed(row.source),
      queuedForAdjudication: row.queued === 1,
      adjudication: (row.decision as AdjudicationDecision | null) ?? null,
    }))
