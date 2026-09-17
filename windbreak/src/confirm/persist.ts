/**
 * Recording confirmation attempts (spec §20.35).
 *
 * One row per candidate per run, replaced on a re-run, so the table answers "what
 * does this run know about this candidate" rather than accumulating a history
 * nobody reads. That matches how `findings` behaves when reporting is re-run.
 *
 * **Every outcome is stored, including the refusals.** A table of only the
 * confirmations could not answer the question a reader actually has — how often
 * this stage was *unable* to run — and `build-failed` is a fact about the machine
 * rather than about the finding, so dropping it would let a host missing its
 * headers look like a repository with clean code.
 */

import { createHash } from 'crypto'

import type { Database } from 'bun:sqlite'
import type { ConfirmationLocation, ConfirmationOutcome, ConfirmationResult } from './types'

/** Deterministic, so re-running replaces the previous answer for this pair. */
export const confirmationId = (runId: string, candidateId: string): string =>
  `cfm_${createHash('sha256').update(`${runId}:${candidateId}`).digest('hex').slice(0, 24)}`

export interface PersistConfirmationInput {
  db: Database
  runId: string
  result: ConfirmationResult
  now?: () => number
}

export const persistConfirmation = (input: PersistConfirmationInput): void => {
  const { result } = input
  input.db
    .prepare(
      `INSERT OR REPLACE INTO confirmations
         (id, candidate_id, run_id, outcome, detail, signature, location,
          fuzz_seconds, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      confirmationId(input.runId, result.candidateId),
      result.candidateId,
      input.runId,
      result.outcome,
      result.detail,
      result.signature,
      result.location ? JSON.stringify(result.location) : null,
      result.fuzzSeconds,
      result.durationMs,
      new Date((input.now ?? Date.now)()).toISOString(),
    )
}

export interface StoredConfirmation {
  candidateId: string
  outcome: ConfirmationOutcome
  detail: string
  signature: string | null
  location: ConfirmationLocation | null
  fuzzSeconds: number
  durationMs: number
}

interface ConfirmationDbRow {
  candidate_id: string
  outcome: string
  detail: string
  signature: string | null
  location: string | null
  fuzz_seconds: number
  duration_ms: number
}

const parseLocation = (raw: string | null): ConfirmationLocation | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ConfirmationLocation>
    if (typeof parsed.filePath !== 'string' || typeof parsed.line !== 'number') return null
    return { filePath: parsed.filePath, line: parsed.line }
  } catch {
    // A row that cannot be parsed is read as "no location" rather than crashing a
    // report over a field that is only ever supplementary.
    return null
  }
}

/** Every attempt recorded for a run. */
export const readConfirmations = (db: Database, runId: string): StoredConfirmation[] =>
  db
    .query<ConfirmationDbRow, [string]>(
      `SELECT candidate_id, outcome, detail, signature, location, fuzz_seconds, duration_ms
         FROM confirmations WHERE run_id = ? ORDER BY candidate_id`,
    )
    .all(runId)
    .map((row) => ({
      candidateId: row.candidate_id,
      outcome: row.outcome as ConfirmationOutcome,
      detail: row.detail,
      signature: row.signature,
      location: parseLocation(row.location),
      fuzzSeconds: row.fuzz_seconds,
      durationMs: row.duration_ms,
    }))

/**
 * The candidates this run actually confirmed.
 *
 * The one thing reporting may use to move an evidence tier, so it is a query of
 * its own rather than a filter a caller writes — a caller who filtered on
 * "outcome is not not-reproduced" would promote every candidate that failed to
 * build.
 */
export const readConfirmedCandidateIds = (db: Database, runId: string): string[] =>
  db
    .query<{ candidate_id: string }, [string]>(
      `SELECT candidate_id FROM confirmations WHERE run_id = ? AND outcome = 'confirmed'
         ORDER BY candidate_id`,
    )
    .all(runId)
    .map((row) => row.candidate_id)
