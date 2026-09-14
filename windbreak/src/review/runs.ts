/**
 * The run listing (§20.33).
 *
 * §5.3's screen reads one queue, and until §20.33 the queue was the only way in. A start
 * menu needs the other fact a state database holds — *which runs exist* — because
 * "resume a previous run" is a question about runs and the queue cannot answer it: a run
 * with nothing escalated produces no queue rows at all, and a run that never finished
 * produces only some.
 *
 * ## Why the counters are computed rather than a column
 *
 * `runs` records no disagreement count, and it should not: the count is a property of the
 * candidates a run escalated, and a stored copy would be a second place for the two to
 * disagree — including the case §5.3's queue exists for, where a disagreement is decided
 * after the run finished. So the numbers are read with the rows, in the same query.
 *
 * Both halves are reported because they answer different questions: `queued` is what the
 * run produced, `resolved` is how much of it a researcher has already worked. A screen
 * that showed only `queued` would make a finished review look untouched.
 */

import type { Database } from 'bun:sqlite'
import type { ReviewRunSummary } from './types'

/**
 * Every run in the database, newest first.
 *
 * Ordered by `started_at` and not by rowid, because the rows are what the researcher
 * recognises — `resume` is chosen from a list of runs, and the run they want is the one
 * they started last. `rowid` is the tiebreak for the case `started_at` cannot separate:
 * two runs recorded in the same second, which a fast `resume` really can produce.
 */
export const readReviewRuns = (db: Database): ReviewRunSummary[] =>
  db
    .query<
      {
        id: string
        target_id: string
        target_location: string | null
        commit_sha: string
        started_at: string | null
        finished_at: string | null
        status: string
        queued: number
        resolved: number
      },
      []
    >(
      `SELECT r.id, r.target_id, r.commit_sha, r.started_at, r.finished_at, r.status,
              t.location AS target_location,
              COUNT(q.candidate_id) AS queued,
              COALESCE(SUM(CASE WHEN q.decision IS NOT NULL THEN 1 ELSE 0 END), 0) AS resolved
         FROM runs r
         LEFT JOIN targets t ON t.id = r.target_id
         LEFT JOIN adjudication_queue q ON q.run_id = r.id
        GROUP BY r.id
        ORDER BY r.started_at DESC, r.rowid DESC`,
    )
    .all()
    .map((row) => ({
      runId: row.id,
      targetId: row.target_id,
      targetLocation: row.target_location,
      commitSha: row.commit_sha,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      queued: row.queued,
      resolved: row.resolved,
    }))
