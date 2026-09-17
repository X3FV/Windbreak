/**
 * Reporting persistence (spec §14.1: `findings`, `ledger`).
 *
 * Readers resolve recorded state into what reporting renders; writers record the
 * artifacts and the disclosure bookkeeping. §12.5's ledger exists "so the
 * Fedora-migration-class bookkeeping loss cannot recur", so a report creates a
 * `drafted` row and the status can be moved on afterwards — a ledger nothing can
 * update would not prevent any loss.
 */

import { createHash } from 'crypto'

import { readCandidatesForTriage, readCandidate } from '../pipeline/persist'
import { readCandidateReachability } from '../reach'

import type { Database } from 'bun:sqlite'
import type { CandidateRecord, PipelineProgramContext } from '../pipeline'
import type { ReportableInput } from './findings'
import type { RediscoveryInfo, VerdictSummary } from './types'

/**
 * Candidate states reporting has anything to say about.
 *
 * `rediscovery` is included because §4.2 routes it to reporting; `new`,
 * `triaged`, `verifying` and `dropped` are not findings and are excluded here
 * rather than filtered later, so nothing can reach a writeup by accident.
 */
export const REPORTABLE_STATES = ['confirmed', 'escalated', 'rediscovery'] as const

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

const parseStringArray = (json: string | null): string[] => {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export const readReportableCandidates = (
  db: Database,
  runId: string,
): CandidateRecord[] => {
  const placeholders = REPORTABLE_STATES.map(() => '?').join(', ')
  const rows = db
    .query<CandidateRow, [string, ...string[]]>(
      `SELECT c.id, c.run_id, r.target_id, c.source, c.pattern_id, c.origin_patch_sha,
              c.file_path, c.start_line, c.end_line, c.cwe, c.normalized_json,
              c.injection_signals_json, c.state, c.triage
         FROM candidates c JOIN runs r ON r.id = c.run_id
        WHERE c.run_id = ? AND c.state IN (${placeholders})
        ORDER BY c.file_path, c.start_line`,
    )
    .all(runId, ...REPORTABLE_STATES)

  return rows.map((row) => ({
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
    injectionSignals: parseStringArray(row.injection_signals_json),
    state: row.state,
    triage: (row.triage as CandidateRecord['triage']) ?? null,
  }))
}

export const readVerdictsForCandidate = (
  db: Database,
  candidateId: string,
): VerdictSummary[] =>
  db
    .query<
      {
        role: string
        output_json: string
        model_id: string
        provider: string
      },
      [string]
    >(
      `SELECT role, output_json, model_id, provider FROM verdicts
        WHERE candidate_id = ? ORDER BY rowid`,
    )
    .all(candidateId)
    .map((row) => {
      let answer: string | null = null
      let reasoning = ''
      try {
        const parsed: unknown = JSON.parse(row.output_json)
        if (parsed && typeof parsed === 'object') {
          const record = parsed as Record<string, unknown>
          const candidate =
            typeof record.verdict === 'string'
              ? record.verdict
              : typeof record.label === 'string'
                ? record.label
                : null
          answer = candidate
          const text = typeof record.reasoning === 'string' ? record.reasoning : record.rationale
          if (typeof text === 'string') reasoning = text
        }
      } catch {
        reasoning = ''
      }
      return {
        role: row.role,
        answer,
        reasoning,
        modelId: row.model_id,
        provider: row.provider,
      }
    })

export const readAdjudicationDecisions = (
  db: Database,
  runId: string,
): Map<string, 'real' | 'benign'> => {
  const rows = db
    .query<{ candidate_id: string; decision: string | null }, [string]>(
      `SELECT candidate_id, decision FROM adjudication_queue WHERE run_id = ?`,
    )
    .all(runId)

  const decisions = new Map<string, 'real' | 'benign'>()
  for (const row of rows) {
    if (row.decision === 'real' || row.decision === 'benign') {
      decisions.set(row.candidate_id, row.decision)
    }
  }
  return decisions
}

export const readRediscoveryMatch = (
  db: Database,
  candidateId: string,
): RediscoveryInfo | null => {
  const row = db
    .query<{ osv_match_json: string | null }, [string]>(
      'SELECT osv_match_json FROM candidates WHERE id = ?',
    )
    .get(candidateId)
  if (!row?.osv_match_json) return null

  try {
    const parsed: unknown = JSON.parse(row.osv_match_json)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (typeof record.vulnId === 'string' && typeof record.basis === 'string') {
        return {
          vulnId: record.vulnId,
          basis: record.basis,
          signals: Array.isArray(record.signals)
            ? record.signals.filter((s): s is string => typeof s === 'string')
            : [],
        }
      }
    }
  } catch {
    return null
  }
  return null
}

/** The candidate's snippet, out of its stored evidence bundle. */
export const snippetOf = (candidate: CandidateRecord): string | null => {
  try {
    const parsed: unknown = JSON.parse(candidate.normalizedJson)
    if (parsed && typeof parsed === 'object') {
      const snippet = (parsed as { snippet?: unknown }).snippet
      if (typeof snippet === 'string') return snippet
    }
  } catch {
    return null
  }
  return null
}

/**
 * Assemble everything reporting needs about one candidate.
 *
 * The call path comes from the symbol index via the pipeline's program context,
 * so a finding's "call path" is a tool query rather than a model's reading of a
 * comment (§5.1 rule 3).
 */
export const collectReportableInputs = (input: {
  db: Database
  runId: string
  programContext?: PipelineProgramContext | undefined
}): ReportableInput[] => {
  const decisions = readAdjudicationDecisions(input.db, input.runId)
  const candidates = readReportableCandidates(input.db, input.runId)

  return candidates.map((candidate) => {
    const enclosing =
      input.programContext && candidate.filePath && candidate.startLine !== null
        ? input.programContext.enclosingFunction(candidate.filePath, candidate.startLine)
        : null

    let callPath: string | null = null
    if (enclosing) {
      const callers = input.programContext!.callers(enclosing.name)
      callPath =
        callers.length > 0
          ? `${enclosing.name} <- ${callers
              .slice(0, 3)
              .map((site) => `${site.name} (${site.filePath}:${site.line})`)
              .join(', ')}`
          : `${enclosing.name} (no recorded call sites)`
    }

    return {
      candidate,
      verdicts: readVerdictsForCandidate(input.db, candidate.id),
      queueDecision: decisions.get(candidate.id) ?? null,
      rediscovery: readRediscoveryMatch(input.db, candidate.id),
      callPath,
      enclosingFunction: enclosing?.name ?? null,
      snippet: snippetOf(candidate),
      language: input.programContext?.languageFor(candidate.filePath) ?? null,
      // §4.4.4's conclusion, read from the row rather than recomputed: the report makes
      // no model calls and should not need a call graph to state one line.
      reachability: readCandidateReachability(input.db, candidate.id),
    }
  })
}

/** re-exported so callers do not need to reach into the pipeline for one lookup */
export { readCandidate, readCandidatesForTriage }

export interface PersistFindingInput {
  db: Database
  findingId: string
  candidateId: string
  evidenceTier: string
  sarifPath: string | null
  writeupPath: string | null
  now?: () => number
}

export const persistFinding = (input: PersistFindingInput): void => {
  input.db
    .prepare(
      `INSERT OR REPLACE INTO findings
         (id, candidate_id, evidence_tier, sarif_path, writeup_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.findingId,
      input.candidateId,
      input.evidenceTier,
      input.sarifPath,
      input.writeupPath,
      new Date((input.now ?? Date.now)()).toISOString(),
    )
}

export const ledgerEntryId = (findingId: string): string =>
  `led_${createHash('sha256').update(findingId).digest('hex').slice(0, 24)}`

export const DISCLOSURE_STATUSES = [
  'drafted',
  'submitted',
  'acknowledged',
  'fixed',
  'declined',
  'duplicate',
] as const

export type DisclosureStatus = (typeof DISCLOSURE_STATUSES)[number]

/**
 * Record that a finding has been drafted (§12.5).
 *
 * `INSERT OR IGNORE` on purpose: re-running reporting must not reset a status
 * the researcher already moved on — that would be exactly the bookkeeping loss
 * the ledger exists to prevent.
 */
export const ensureLedgerEntry = (input: {
  db: Database
  findingId: string
  now?: () => number
}): void => {
  input.db
    .prepare(
      `INSERT OR IGNORE INTO ledger (finding_id, status, channel, notes, updated_at)
       VALUES (?, 'drafted', NULL, NULL, ?)`,
    )
    .run(input.findingId, new Date((input.now ?? Date.now)()).toISOString())
}

export interface LedgerRow {
  findingId: string
  status: DisclosureStatus
  channel: string | null
  notes: string | null
  updatedAt: string
}

export const readLedger = (db: Database): LedgerRow[] =>
  db
    .query<
      { finding_id: string; status: string; channel: string | null; notes: string | null; updated_at: string },
      []
    >(`SELECT finding_id, status, channel, notes, updated_at FROM ledger ORDER BY rowid`)
    .all()
    .map((row) => ({
      findingId: row.finding_id,
      status: row.status as DisclosureStatus,
      channel: row.channel,
      notes: row.notes,
      updatedAt: row.updated_at,
    }))

export const updateLedgerStatus = (input: {
  db: Database
  findingId: string
  status: DisclosureStatus
  channel?: string | null
  notes?: string | null
  now?: () => number
}): boolean => {
  const result = input.db
    .prepare(
      `UPDATE ledger SET status = ?, channel = COALESCE(?, channel), notes = COALESCE(?, notes),
              updated_at = ?
        WHERE finding_id = ?`,
    )
    .run(
      input.status,
      input.channel ?? null,
      input.notes ?? null,
      new Date((input.now ?? Date.now)()).toISOString(),
      input.findingId,
    )

  return result.changes > 0
}
