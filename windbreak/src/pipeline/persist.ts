/**
 * Pipeline persistence (spec §14.1: `verdicts`, `candidates`, `adjudication_queue`).
 *
 * Two invariants drive this module:
 *
 * 1. Every model answer is recorded verbatim with the identity that produced it
 *    (`verdicts`), because §5.2 forbids trusting a self-report and §11.3 needs to
 *    compare runs later.
 * 2. A candidate's `state` only moves on a *recorded* decision. Nothing is
 *    dropped by omission.
 */

import { createHash } from 'crypto'

import { knownVulnFromRow } from './rediscovery'

import type { Database } from 'bun:sqlite'
import type { ModelRole } from '../models'
import type { NormalizedCandidate } from '../engines/types'
import type { KnownVulnRecord } from './rediscovery'
import type {
  CandidateRecord,
  ModelIdentity,
  PipelineStage,
  TriageLabel,
} from './types'

export const verdictId = (
  candidateId: string,
  role: ModelRole,
  cacheKey: string,
): string =>
  `ver_${createHash('sha256')
    .update(`${candidateId}:${role}:${cacheKey}`)
    .digest('hex')
    .slice(0, 24)}`

export interface InsertVerdictInput {
  db: Database
  candidateId: string
  stage: PipelineStage
  role: ModelRole
  identity: ModelIdentity
  cacheKey: string
  output: unknown
  now?: () => number
}

export const insertVerdict = (input: InsertVerdictInput): string => {
  const id = verdictId(input.candidateId, input.role, input.cacheKey)

  input.db
    .prepare(
      `INSERT OR REPLACE INTO verdicts
         (id, candidate_id, stage, role, model_id, provider, temperature, seed,
          seed_supported, cache_key, output_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.candidateId,
      input.stage,
      input.role,
      input.identity.modelId,
      input.identity.provider,
      input.identity.temperature,
      input.identity.seed,
      input.identity.seedSupported ? 1 : 0,
      input.cacheKey,
      JSON.stringify(input.output),
      new Date((input.now ?? Date.now)()).toISOString(),
    )

  return id
}

/**
 * Read a candidate's evidence bundle.
 *
 * Returns null rather than throwing: a malformed row must show up as "no
 * evidence" and be counted, never as a clean verdict on missing data.
 */
export const parseNormalized = (json: string): NormalizedCandidate | null => {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as NormalizedCandidate
  } catch {
    return null
  }
  return null
}

const CANDIDATE_COLUMNS = `
  c.id, c.run_id, r.target_id, c.source, c.pattern_id, c.origin_patch_sha,
  c.file_path, c.start_line, c.end_line, c.cwe, c.normalized_json,
  c.injection_signals_json, c.state, c.triage`

interface CandidateRow {
  id: string
  run_id: string
  target_id: string
  source: string
  pattern_id: string | null
  origin_patch_sha: string | null
  file_path: string | null
  start_line: number | null
  end_line: number | null
  cwe: string | null
  normalized_json: string
  injection_signals_json: string | null
  state: string
  triage: string | null
}

const toCandidate = (row: CandidateRow): CandidateRecord => {
  let injectionSignals: string[] = []
  if (row.injection_signals_json) {
    try {
      const parsed: unknown = JSON.parse(row.injection_signals_json)
      if (Array.isArray(parsed)) {
        injectionSignals = parsed.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      }
    } catch {
      injectionSignals = []
    }
  }

  return {
    id: row.id,
    runId: row.run_id,
    targetId: row.target_id,
    source: row.source,
    patternId: row.pattern_id,
    originPatchSha: row.origin_patch_sha,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    cwe: row.cwe,
    normalizedJson: row.normalized_json,
    injectionSignals,
    state: row.state,
    triage: (row.triage as TriageLabel | null) ?? null,
  }
}

/**
 * Candidates still to triage.
 *
 * `state <> 'rediscovery'` is load-bearing rather than defensive: the §4.2
 * pre-check runs *before* triage and marks a candidate without setting `triage`,
 * so a rediscovery is still `triage IS NULL`. Without this the candidate would
 * be routed to reporting *and* sent to a model.
 *
 * The `ORDER BY` is deliberate too: §4.6 asks for candidates to be batched by
 * file where possible, and keeping a file's candidates adjacent preserves the
 * provider's prompt-cache locality even though each candidate is one call.
 */
export const readCandidatesForTriage = (
  db: Database,
  runId: string,
): CandidateRecord[] =>
  db
    .query<CandidateRow, [string]>(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM candidates c JOIN runs r ON r.id = c.run_id
        WHERE c.run_id = ? AND c.triage IS NULL AND c.state <> 'rediscovery'
        ORDER BY c.file_path, c.start_line`,
    )
    .all(runId)
    .map(toCandidate)

/**
 * §4.6's gate: every `likely-real` candidate, plus every `needs-context` one
 * after its single enrichment attempt. §4.6's `likely-noise` stops here.
 */
export const readCandidatesForVerification = (
  db: Database,
  runId: string,
): CandidateRecord[] =>
  db
    .query<CandidateRow, [string]>(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM candidates c JOIN runs r ON r.id = c.run_id
        WHERE c.run_id = ? AND c.triage IN ('likely-real', 'needs-context')
        ORDER BY c.file_path, c.start_line`,
    )
    .all(runId)
    .map(toCandidate)

export const readCandidate = (
  db: Database,
  candidateId: string,
): CandidateRecord | null => {
  const row = db
    .query<CandidateRow, [string]>(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM candidates c JOIN runs r ON r.id = c.run_id
        WHERE c.id = ?`,
    )
    .get(candidateId)
  return row ? toCandidate(row) : null
}

export const setCandidateTriage = (
  db: Database,
  candidateId: string,
  label: TriageLabel,
): void => {
  db.prepare(`UPDATE candidates SET triage = ?, state = 'triaged' WHERE id = ?`).run(
    label,
    candidateId,
  )
}

export const setCandidateState = (
  db: Database,
  candidateId: string,
  state: string,
): void => {
  db.prepare('UPDATE candidates SET state = ? WHERE id = ?').run(state, candidateId)
}

/**
 * Route a rediscovery away from verification (§4.2).
 *
 * The match is written to `osv_match_json` so the decision is auditable: a
 * candidate that never reached a model still carries the reason it did not.
 */
export const markRediscovery = (
  db: Database,
  candidateId: string,
  match: { vulnId: string; signals: string[]; basis: string },
): void => {
  db.prepare(
    `UPDATE candidates SET state = 'rediscovery', osv_match_json = ? WHERE id = ?`,
  ).run(JSON.stringify(match), candidateId)
}

export interface RunRef {
  id: string
  commitSha: string
  status: string
  startedAt: string | null
}

/**
 * The run a pipeline invocation should attach to.
 *
 * §14.1's `runs` row is per target scan, and the §9 budget is per target, so the
 * candidate pipeline reuses the run the engines stage created rather than
 * starting a second one. Two runs for one scan would split the budget and make
 * §11.3's across-run comparison meaningless.
 */
export const latestRunForTarget = (db: Database, targetId: string): RunRef | null => {
  const row = db
    .query<
      { id: string; commit_sha: string; status: string; started_at: string | null },
      [string]
    >(
      `SELECT id, commit_sha, status, started_at FROM runs
        WHERE target_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(targetId)

  return row
    ? {
        id: row.id,
        commitSha: row.commit_sha,
        status: row.status,
        startedAt: row.started_at,
      }
    : null
}

export const readKnownVulns = (db: Database, targetId: string): KnownVulnRecord[] =>
  db
    .query<
      {
        vuln_id: string
        aliases_json: string | null
        summary: string | null
        raw_json: string | null
      },
      [string]
    >(
      `SELECT vuln_id, aliases_json, summary, raw_json
         FROM osv_matches WHERE target_id = ?
        GROUP BY vuln_id`,
    )
    .all(targetId)
    .map(knownVulnFromRow)

export interface EnqueueAdjudicationInput {
  db: Database
  candidateId: string
  runId: string
  proposerVerdictId: string
  refuterVerdictId: string
}

export const enqueueAdjudication = (input: EnqueueAdjudicationInput): void => {
  input.db
    .prepare(
      `INSERT OR REPLACE INTO adjudication_queue
         (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id, decision, decided_at, rationale)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(
      input.candidateId,
      input.runId,
      input.proposerVerdictId,
      input.refuterVerdictId,
    )
}

export interface QueueEntry {
  candidateId: string
  runId: string
  filePath: string | null
  startLine: number | null
  source: string
  patternId: string | null
  cwe: string | null
  decision: string | null
  decidedAt: string | null
  rationale: string | null
  proposerVerdictId: string
  refuterVerdictId: string
  proposerReasoning: string | null
  refuterReasoning: string | null
}

const reasoningFrom = (outputJson: string | null): string | null => {
  if (!outputJson) return null
  try {
    const parsed: unknown = JSON.parse(outputJson)
    if (parsed && typeof parsed === 'object') {
      const reasoning = (parsed as { reasoning?: unknown }).reasoning
      if (typeof reasoning === 'string') return reasoning
      const rationale = (parsed as { rationale?: unknown }).rationale
      if (typeof rationale === 'string') return rationale
    }
  } catch {
    return null
  }
  return null
}

export const readAdjudicationQueue = (
  db: Database,
  runId?: string,
): QueueEntry[] => {
  const sql = `
    SELECT q.candidate_id, q.run_id, q.proposer_verdict_id, q.refuter_verdict_id,
           q.decision, q.decided_at, q.rationale,
           c.file_path, c.start_line, c.source, c.pattern_id, c.cwe,
           pv.output_json AS proposer_output, rv.output_json AS refuter_output
      FROM adjudication_queue q
      JOIN candidates c ON c.id = q.candidate_id
      LEFT JOIN verdicts pv ON pv.id = q.proposer_verdict_id
      LEFT JOIN verdicts rv ON rv.id = q.refuter_verdict_id
     ${runId ? 'WHERE q.run_id = ?' : ''}
     ORDER BY q.rowid`

  const rows = runId
    ? db.query<Record<string, unknown>, [string]>(sql).all(runId)
    : db.query<Record<string, unknown>, []>(sql).all()

  return rows.map((row) => ({
    candidateId: String(row.candidate_id),
    runId: String(row.run_id),
    filePath: (row.file_path as string | null) ?? null,
    startLine: (row.start_line as number | null) ?? null,
    source: String(row.source),
    patternId: (row.pattern_id as string | null) ?? null,
    cwe: (row.cwe as string | null) ?? null,
    decision: (row.decision as string | null) ?? null,
    decidedAt: (row.decided_at as string | null) ?? null,
    rationale: (row.rationale as string | null) ?? null,
    proposerVerdictId: String(row.proposer_verdict_id),
    refuterVerdictId: String(row.refuter_verdict_id),
    proposerReasoning: reasoningFrom(row.proposer_output as string | null),
    refuterReasoning: reasoningFrom(row.refuter_output as string | null),
  }))
}

export type AdjudicationDecision = 'real' | 'benign'

/**
 * Record the researcher's resolution (§5.3).
 *
 * A resolved `real` candidate joins verification as confirmed; a resolved
 * `benign` one is dropped, and §5.3 keeps it as a negative example for tuning
 * Phase A patterns — which is why the row is updated rather than deleted.
 */
export const recordAdjudicationDecision = (input: {
  db: Database
  candidateId: string
  decision: AdjudicationDecision
  rationale: string | null
  now?: () => number
}): void => {
  const decidedAt = new Date((input.now ?? Date.now)()).toISOString()
  const state = input.decision === 'real' ? 'confirmed' : 'dropped'

  input.db.transaction(() => {
    input.db
      .prepare(
        `UPDATE adjudication_queue SET decision = ?, decided_at = ?, rationale = ?
          WHERE candidate_id = ?`,
      )
      .run(input.decision, decidedAt, input.rationale, input.candidateId)
    input.db
      .prepare('UPDATE candidates SET state = ? WHERE id = ?')
      .run(state, input.candidateId)
  })()
}

export interface PipelineSummary {
  candidates: number
  byTriage: Array<{ label: string; count: number }>
  byState: Array<{ state: string; count: number }>
  rediscovery: number
  queuePending: number
  queueResolved: number
  verdicts: number
}

/**
 * Cache-hit counts are *not* derived here. Every verdict writes a cache row, so
 * a join against `verdict_cache` would count every verdict and report a 100%
 * hit rate. The stages count real replays as they happen and report them in
 * their own result.
 */
export const readPipelineSummary = (
  db: Database,
  runId: string,
): PipelineSummary => {
  const byTriage = db
    .query<{ label: string | null; count: number }, [string]>(
      `SELECT triage AS label, COUNT(*) AS count FROM candidates
        WHERE run_id = ? GROUP BY triage ORDER BY triage`,
    )
    .all(runId)
    .map((row) => ({ label: row.label ?? '(untriaged)', count: row.count }))

  const byState = db
    .query<{ state: string; count: number }, [string]>(
      `SELECT state, COUNT(*) AS count FROM candidates
        WHERE run_id = ? GROUP BY state ORDER BY state`,
    )
    .all(runId)

  const candidates = byState.reduce((total, row) => total + row.count, 0)

  return {
    candidates,
    byTriage,
    byState,
    rediscovery: byState.find((row) => row.state === 'rediscovery')?.count ?? 0,
    queuePending:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM adjudication_queue
            WHERE run_id = ? AND decision IS NULL`,
        )
        .get(runId)?.n ?? 0,
    queueResolved:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM adjudication_queue
            WHERE run_id = ? AND decision IS NOT NULL`,
        )
        .get(runId)?.n ?? 0,
    verdicts:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM verdicts v
             JOIN candidates c ON c.id = v.candidate_id WHERE c.run_id = ?`,
        )
        .get(runId)?.n ?? 0,
  }
}
