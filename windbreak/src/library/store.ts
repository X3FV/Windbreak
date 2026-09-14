/**
 * Pattern library persistence (spec §10, §14.1).
 *
 * The `checkers` and `checker_replays` tables already existed in §14.1; §20.12
 * extended them with the provenance and drift columns this stage actually
 * needs. Nothing here deletes: a noisy pattern is *retired* so the record of
 * what it found survives for §11.3's across-run comparison.
 */

import { createHash } from 'crypto'

import { canonicalFingerprintJson, parseFingerprint } from './fingerprint'

import type { Database } from 'bun:sqlite'
import type {
  CheckerCondition,
  CheckerReplay,
  Fingerprint,
  LibraryEntry,
  OriginSite,
} from './types'

/**
 * A pattern id in the same family as the committed rule ids
 * (`wb-c-unbounded-string-op`), so a replayed candidate's `pattern_id` says
 * which library entry produced it without a join.
 */
export const libraryPatternId = (fingerprint: Fingerprint): string => {
  const digest = createHash('sha256')
    .update(canonicalFingerprintJson(fingerprint))
    .digest('hex')
    .slice(0, 8)
  const tag = fingerprint.cwe
    ? fingerprint.cwe.toLowerCase().replace('cwe-', 'c')
    : 'unclassified'
  return `wb-lib-${tag}-${digest}`
}

/**
 * Checker id is the pattern id plus the fingerprint digest, so an edited
 * fingerprint is a *new* checker rather than a silent in-place change. §10's
 * "skipped, not tuned" depends on that: tuning produces a new row with its own
 * validation record, while the old one keeps its history.
 */
export const checkerIdFor = (patternId: string, fingerprint: Fingerprint): string =>
  `chk_${createHash('sha256')
    .update(`${patternId}:${canonicalFingerprintJson(fingerprint)}`)
    .digest('hex')
    .slice(0, 24)}`

export const replayId = (checkerId: string, targetId: string, ranAt: string): string =>
  `rep_${createHash('sha256')
    .update(`${checkerId}:${targetId}:${ranAt}`)
    .digest('hex')
    .slice(0, 24)}`

interface CheckerRow {
  id: string
  pattern_id: string
  origin_patch_sha: string
  condition: string
  source: string
  pre_image_hits: number | null
  post_image_clean: number | null
  precision_observed: number | null
  finding_id: string | null
  candidate_id: string | null
  target_id: string | null
  cwe: string | null
  evidence_tier: string | null
  origin_site_json: string | null
  model_id: string | null
  provider: string | null
  prompt_template_version: string | null
  retired_at: string | null
  created_at: string
}

const parseOriginSite = (json: string | null): OriginSite | null => {
  if (!json) return null
  try {
    const value = JSON.parse(json) as Partial<OriginSite>
    if (typeof value.filePath !== 'string' || typeof value.line !== 'number') return null
    return {
      filePath: value.filePath,
      functionName: typeof value.functionName === 'string' ? value.functionName : null,
      line: value.line,
    }
  } catch {
    return null
  }
}

/**
 * A row whose stored fingerprint no longer parses is treated as absent rather
 * than as a partially-usable pattern. A stored pattern is data that came from a
 * model and a human; if it does not satisfy the current schema, replaying some
 * of it would produce candidates nobody can explain.
 */
const toEntry = (row: CheckerRow): LibraryEntry | null => {
  let fingerprint: Fingerprint
  try {
    fingerprint = parseFingerprint(JSON.parse(row.source) as unknown)
  } catch {
    return null
  }

  return {
    id: row.id,
    patternId: row.pattern_id,
    originPatchSha: row.origin_patch_sha,
    condition: (row.condition === 'confirmed' ? 'confirmed' : 'unconfirmed') as CheckerCondition,
    fingerprint,
    preImageHits: row.pre_image_hits,
    postImageClean: row.post_image_clean,
    precisionObserved: row.precision_observed,
    findingId: row.finding_id,
    candidateId: row.candidate_id,
    targetId: row.target_id,
    cwe: row.cwe,
    evidenceTier: row.evidence_tier,
    originSite: parseOriginSite(row.origin_site_json),
    modelId: row.model_id,
    provider: row.provider,
    promptTemplateVersion: row.prompt_template_version,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  }
}

export interface InsertCheckerInput {
  db: Database
  patternId: string
  originPatchSha: string
  condition: CheckerCondition
  fingerprint: Fingerprint
  findingId: string | null
  candidateId: string | null
  targetId: string | null
  evidenceTier: string | null
  originSite: OriginSite | null
  modelId: string | null
  provider: string | null
  promptTemplateVersion: string | null
  preImageHits: number | null
  postImageClean: number | null
  now?: () => number
}

export const insertChecker = (input: InsertCheckerInput): string => {
  const id = checkerIdFor(input.patternId, input.fingerprint)

  input.db
    .prepare(
      `INSERT OR REPLACE INTO checkers
         (id, pattern_id, origin_patch_sha, condition, source, pre_image_hits,
          post_image_clean, precision_observed, finding_id, candidate_id, target_id,
          cwe, evidence_tier, origin_site_json, model_id, provider,
          prompt_template_version, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.patternId,
      input.originPatchSha,
      input.condition,
      // The stored artifact is the fingerprint JSON, written canonically so a
      // re-insert of the same pattern is byte-identical.
      JSON.stringify(input.fingerprint),
      input.preImageHits,
      input.postImageClean,
      input.findingId,
      input.candidateId,
      input.targetId,
      input.fingerprint.cwe,
      input.evidenceTier,
      input.originSite ? JSON.stringify(input.originSite) : null,
      input.modelId,
      input.provider,
      input.promptTemplateVersion,
      new Date((input.now ?? Date.now)()).toISOString(),
    )

  return id
}

export const readChecker = (db: Database, checkerId: string): LibraryEntry | null => {
  const row = db
    .query<CheckerRow, [string]>('SELECT * FROM checkers WHERE id = ?')
    .get(checkerId)
  return row ? toEntry(row) : null
}

export interface ReadLibraryOptions {
  /** Include patterns the researcher retired (§10). Default false. */
  includeRetired?: boolean
  /** Restrict to one pattern id. */
  patternId?: string
}

export const readLibrary = (
  db: Database,
  options: ReadLibraryOptions = {},
): LibraryEntry[] => {
  const clauses: string[] = []
  const params: string[] = []

  if (!options.includeRetired) clauses.push('retired_at IS NULL')
  if (options.patternId) {
    clauses.push('pattern_id = ?')
    params.push(options.patternId)
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .query<CheckerRow, string[]>(`SELECT * FROM checkers${where} ORDER BY created_at, id`)
    .all(...params)

  // A row that no longer parses is skipped here and counted by the caller via
  // `unreadableCheckers`, so it is visible rather than silent.
  return rows.map((row) => toEntry(row)).filter((entry): entry is LibraryEntry => entry !== null)
}

/** Checker rows that exist but whose stored fingerprint no longer parses. */
export const countUnreadableCheckers = (db: Database): number => {
  const rows = db.query<CheckerRow, []>('SELECT * FROM checkers').all()
  return rows.filter((row) => toEntry(row) === null).length
}

export const retireChecker = (
  db: Database,
  checkerId: string,
  now: () => number = Date.now,
): number => {
  const result = db
    .prepare('UPDATE checkers SET retired_at = ? WHERE id = ? AND retired_at IS NULL')
    .run(new Date(now()).toISOString(), checkerId)
  return result.changes
}

export interface RecordReplayInput {
  db: Database
  checkerId: string
  targetId: string
  revalidated: boolean
  candidatesFound: number
  skippedReason: string | null
  targetCommitSha: string | null
  now?: () => number
}

export const recordReplay = (input: RecordReplayInput): string => {
  const ranAt = new Date((input.now ?? Date.now)()).toISOString()
  const id = replayId(input.checkerId, input.targetId, ranAt)

  input.db
    .prepare(
      `INSERT OR REPLACE INTO checker_replays
         (id, checker_id, target_id, revalidated, candidates_found, skipped_reason,
          target_commit_sha, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.checkerId,
      input.targetId,
      input.revalidated ? 1 : 0,
      input.candidatesFound,
      input.skippedReason,
      input.targetCommitSha,
      ranAt,
    )

  return id
}

export const readReplays = (db: Database, checkerId: string): CheckerReplay[] =>
  db
    .query<
      {
        id: string
        checker_id: string
        target_id: string
        revalidated: number
        candidates_found: number
        skipped_reason: string | null
        target_commit_sha: string | null
        ran_at: string
      },
      [string]
    >('SELECT * FROM checker_replays WHERE checker_id = ? ORDER BY ran_at')
    .all(checkerId)
    .map((row) => ({
      id: row.id,
      checkerId: row.checker_id,
      targetId: row.target_id,
      revalidated: row.revalidated === 1,
      candidatesFound: row.candidates_found,
      skippedReason: row.skipped_reason,
      targetCommitSha: row.target_commit_sha,
      ranAt: row.ran_at,
    }))

/**
 * §10's per-checker precision, measured over the candidates the pattern has
 * actually produced.
 *
 * The numerator is candidates that later reached `confirmed`; the denominator
 * is every candidate the pattern produced, *including* the ones still in
 * flight. That choice makes the number pessimistic while a sweep is being
 * triaged, which is the safe direction for a figure whose only job is to help
 * the researcher decide what to retire.
 */
export interface PatternPrecision {
  patternId: string
  produced: number
  confirmed: number
  precision: number | null
}

export const measurePatternPrecision = (
  db: Database,
  patternId: string,
): PatternPrecision => {
  const row = db
    .query<{ produced: number; confirmed: number }, [string]>(
      `SELECT COUNT(*) AS produced,
              SUM(CASE WHEN state = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
         FROM candidates
        WHERE source = 'variant-hunt' AND pattern_id = ?`,
    )
    .get(patternId)

  const produced = row?.produced ?? 0
  const confirmed = row?.confirmed ?? 0

  return {
    patternId,
    produced,
    confirmed,
    precision: produced > 0 ? confirmed / produced : null,
  }
}

export const updateReplayStatistics = (input: {
  db: Database
  checkerId: string
  preImageHits: number | null
  postImageClean: number | null
  precisionObserved: number | null
}): void => {
  input.db
    .prepare(
      `UPDATE checkers
          SET pre_image_hits = ?, post_image_clean = ?, precision_observed = ?
        WHERE id = ?`,
    )
    .run(
      input.preImageHits,
      input.postImageClean,
      input.precisionObserved,
      input.checkerId,
    )
}
