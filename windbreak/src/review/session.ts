/**
 * The review surface (spec §5.3, §12.3 contract, D32's interactive screen).
 *
 * This module exists so the adjudication UI never touches SQLite. §5.3 makes the
 * researcher's eventual disagreement the tiebreak, and §18's rule — never present
 * "not checked" as "clean" — applies to a screen just as much as to a report, so
 * the two questions the screen has to answer honestly are:
 *
 * 1. *Is there anything to review?* An empty queue and a missing database are
 *    different facts, and only one of them is good news.
 * 2. *What did each model actually say?* The queue row references the two verdict
 *    records by id, so the screen reads those records rather than a summary of
 *    them: the model, the provider, the answer, the reasoning, and the conditions
 *    the Proposer claims must hold.
 *
 * The batch command (`commands/review.ts`) keeps its own list/--decide contract.
 * This is the interactive one, and it is deliberately not a second source of
 * truth: the decision itself is written by the pipeline's own
 * `recordAdjudicationDecision`, so §5.3's state transition has one implementation.
 */

import fs from 'fs'
import path from 'path'

import {
  parseNormalized,
  readAdjudicationQueue,
  readCandidate,
  recordAdjudicationDecision,
} from '../pipeline'
import { openStateDatabase, SchemaVersionMismatchError } from '../state/db'

import { readRepoCodebase } from './repo'
import { readReviewRuns } from './runs'

import type { Database } from 'bun:sqlite'
import type { AdjudicationDecision } from '../pipeline'
import type {
  OpenReviewSessionResult,
  ReviewArgument,
  ReviewCodebase,
  ReviewCodebaseFile,
  ReviewCounts,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewQueueSource,
  ReviewSession,
} from './types'

/** A decision is §5.3's own vocabulary; re-exported so the UI names the same thing. */
export type ReviewDecision = AdjudicationDecision

const argumentFrom = (
  db: Database,
  verdictId: string,
  role: ReviewArgument['role'],
): ReviewArgument | null => {
  const row = db
    .query<
      { role: string; model_id: string; provider: string; output_json: string },
      [string]
    >(
      `SELECT role, model_id, provider, output_json FROM verdicts WHERE id = ?`,
    )
    .get(verdictId)

  if (!row) return null

  let verdict: string | null = null
  let reasoning = ''
  let preconditions: string[] = []

  try {
    const parsed: unknown = JSON.parse(row.output_json)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const answer =
        typeof record.verdict === 'string'
          ? record.verdict
          : typeof record.label === 'string'
            ? record.label
            : null
      verdict = answer
      const text =
        typeof record.reasoning === 'string'
          ? record.reasoning
          : record.rationale
      if (typeof text === 'string') reasoning = text
      if (Array.isArray(record.preconditions)) {
        preconditions = record.preconditions.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      }
    }
  } catch {
    // An unreadable verdict is shown as one with no argument rather than as an
    // absent disagreement: §5.3 only escalated because two answers existed.
    reasoning = ''
  }

  return {
    role,
    verdictId,
    verdict,
    reasoning,
    preconditions,
    modelId: row.model_id,
    provider: row.provider,
  }
}

const summaryFrom = (entry: {
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
}): ReviewEntrySummary => ({
  candidateId: entry.candidateId,
  runId: entry.runId,
  filePath: entry.filePath,
  startLine: entry.startLine,
  cwe: entry.cwe,
  source: entry.source,
  patternId: entry.patternId,
  decision:
    entry.decision === 'real' || entry.decision === 'benign'
      ? entry.decision
      : null,
  decidedAt: entry.decidedAt,
  rationale: entry.rationale,
})

/**
 * The run that owns a candidate, so the codebase pane can name its target.
 *
 * `candidates` carries `run_id` and not `target_id`, so this joins rather than
 * reading a column — the target is a property of the run, and duplicating it onto
 * every candidate would be a second place for the two to disagree.
 */
const targetIdForCandidate = (db: Database, candidateId: string): string | null =>
  db
    .query<{ target_id: string }, [string]>(
      `SELECT r.target_id FROM candidates c JOIN runs r ON r.id = c.run_id WHERE c.id = ?`,
    )
    .get(candidateId)?.target_id ?? null

const targetIdForRun = (db: Database, runId: string): string | null =>
  db
    .query<{ target_id: string }, [string]>('SELECT target_id FROM runs WHERE id = ?')
    .get(runId)?.target_id ?? null

/** The newest run's target, for when nothing is selected. */
const latestTargetId = (db: Database): string | null =>
  db
    .query<{ target_id: string }, []>(
      'SELECT target_id FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1',
    )
    .get()?.target_id ?? null

const createSession = (input: {
  db: Database
  /** True when this session opened the connection and must close it. */
  ownsConnection: boolean
  runId?: string | undefined
  source: ReviewQueueSource
  /**
   * Where to look when the database has no target to show (§20.31).
   *
   * The repository the researcher is standing in, resolved by the caller. Null
   * when there is no directory to fall back to, which is the only case that leaves
   * `codebase` returning null.
   */
  repoRoot: string | null
}): ReviewSession => {
  const queue = (): ReturnType<typeof readAdjudicationQueue> =>
    readAdjudicationQueue(input.db, input.runId)

  /**
   * The fallback listing, walked once per session.
   *
   * Memoised, and not as an optimisation detail: `codebase` is called from the
   * screen's render path and its result is re-read whenever the selection changes,
   * so a walk on each call would stat and sniff every file in the checkout on every
   * keystroke. The walk is ~170ms on a 1,958-file tree, which is fine once and not
   * fine fifty times. A value rather than a flag, so an absent root and an empty
   * walk stay distinguishable.
   */
  let filesystemCodebase: ReviewCodebase | null = null
  let filesystemComputed = false

  const filesystemListing = (): ReviewCodebase | null => {
    if (!filesystemComputed && input.repoRoot !== null) {
      filesystemCodebase = readRepoCodebase(input.repoRoot)
      filesystemComputed = true
    }
    return filesystemCodebase
  }

  return {
    source: input.source,

    list: (options = {}) =>
      queue()
        .filter((entry) => options.includeResolved === true || entry.decision === null)
        .map(summaryFrom),

    detail: (candidateId) => {
      const entry = queue().find((row) => row.candidateId === candidateId)
      if (!entry) return null

      const candidate = readCandidate(input.db, candidateId)
      const normalized = candidate ? parseNormalized(candidate.normalizedJson) : null

      const target = candidate
        ? (input.db
            .query<
              {
                id: string
                location: string
                build_model: string | null
                scope_class: string | null
                commit_sha: string | null
              },
              [string]
            >(
              `SELECT id, location, build_model, scope_class, commit_sha
                 FROM targets WHERE id = ?`,
            )
            .get(candidate.targetId) ?? null)
        : null

      const detail: ReviewEntryDetail = {
        summary: summaryFrom(entry),
        candidateState: candidate?.state ?? '(missing)',
        target: target
          ? {
              id: target.id,
              location: target.location,
              buildModel: target.build_model,
              scopeClass: target.scope_class,
              commitSha: target.commit_sha,
            }
          : null,
        evidence: normalized
          ? {
              engine: normalized.engine,
              ruleId: normalized.ruleId,
              message: normalized.message,
              level: normalized.level,
              filePath: normalized.filePath,
              startLine: normalized.startLine,
              endLine: normalized.endLine,
              snippet: normalized.snippet,
              injectionSignals: candidate?.injectionSignals ?? [],
            }
          : null,
        proposer: argumentFrom(input.db, entry.proposerVerdictId, 'proposer'),
        refuter: argumentFrom(input.db, entry.refuterVerdictId, 'refuter'),
      }

      return detail
    },

    decide: (decision) => {
      const entry = queue().find((row) => row.candidateId === decision.candidateId)
      if (!entry) {
        throw new Error(
          `${decision.candidateId} is not in the adjudication queue; nothing was recorded.`,
        )
      }

      const previous =
        entry.decision === 'real' || entry.decision === 'benign'
          ? (entry.decision as ReviewDecision)
          : null

      recordAdjudicationDecision({
        db: input.db,
        candidateId: decision.candidateId,
        decision: decision.decision,
        rationale: decision.rationale ?? null,
        ...(decision.now ? { now: decision.now } : {}),
      })

      return { previous }
    },

    codebase: (candidateId): ReviewCodebase | null => {
      // The selected candidate first, then an explicit run filter, then the newest
      // run. Each step is more specific than the next, and the last is what makes a
      // hunt-like "nothing is selected" case still answerable.
      const targetId =
        (candidateId === null ? null : targetIdForCandidate(input.db, candidateId)) ??
        (input.runId === undefined ? null : targetIdForRun(input.db, input.runId)) ??
        latestTargetId(input.db)

      // No target to show, so the pane falls back to the checkout itself (§20.31)
      // rather than saying there is no codebase to list. The two are *different
      // listings* and the pane labels which one it drew; what it must not do is
      // present a walk as though it were the inventory, which is why `source`
      // travels with the rows.
      if (targetId === null) return filesystemListing()

      const target = input.db
        .query<{ location: string; commit_sha: string | null }, [string]>(
          'SELECT location, commit_sha FROM targets WHERE id = ?',
        )
        .get(targetId)
      if (!target) return null

      const files = input.db
        .query<
          { path: string; language: string | null; bytes: number; binary: number },
          [string]
        >(
          `SELECT path, language, bytes, binary FROM recon_files
            WHERE target_id = ? ORDER BY path`,
        )
        .all(targetId)
        .map(
          (row): ReviewCodebaseFile => ({
            path: row.path,
            language: row.language,
            bytes: row.bytes,
            binary: row.binary === 1,
          }),
        )

      return {
        source: 'inventory',
        targetId,
        location: target.location,
        commitSha: target.commit_sha,
        files,
      }
    },

    counts: (): ReviewCounts => {
      const entries = queue()
      const resolved = entries.filter((entry) => entry.decision !== null).length
      return {
        total: entries.length,
        resolved,
        pending: entries.length - resolved,
      }
    },

    // Read per call rather than cached, for the reason `list` and `counts` are: the screen
    // answers "which runs are there" after a scan it just started, and a memo built before
    // that scan would offer the researcher every run except the one they just created.
    runs: () => readReviewRuns(input.db),

    close: () => {
      if (input.ownsConnection) input.db.close()
    },
  }
}

/**
 * Open the queue for review.
 *
 * A missing database **opens the screen**, and does not create anything on the
 * way. Both halves of that matter:
 *
 * - It is not created on demand. An empty queue and a missing database are
 *   different facts, and creating one would turn "nothing has been scanned here"
 *   into "no disagreements" — the substitution of absent for clean §18 exists to
 *   prevent.
 * - It is not refused either. Refusing was the earlier reading of the same rule,
 *   and it is the less useful one: an operator who ran the command in the wrong
 *   directory got a one-line error and no way forward, when the screen can say
 *   which directory it looked in and how to point it somewhere else.
 *
 * So the queue is read from an in-memory schema with nothing in it, and
 * `source.absent` is what tells the screen that this particular nothing means
 * "not checked". The rule is upheld by the screen naming the state, not by
 * withholding the screen.
 */
export const openReviewSession = (input: {
  dbPath: string
  runId?: string | undefined
  /**
   * The repository to list when the database has no target (§20.31).
   *
   * Resolved by the caller rather than here: the entry point already knows the
   * working directory it resolved the database path from, and a second resolution
   * inside the session would be a second answer to "which repository is this".
   */
  repoRoot?: string | null
}): OpenReviewSessionResult => {
  const resolved = path.resolve(input.dbPath)
  const absent = resolved !== ':memory:' && !fs.existsSync(resolved)

  let db: Database
  try {
    db = openStateDatabase(absent ? ':memory:' : resolved)
  } catch (error) {
    if (error instanceof SchemaVersionMismatchError) {
      return { ok: false, reason: error.message }
    }
    return {
      ok: false,
      reason: `could not open ${resolved}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  return {
    ok: true,
    session: createSession({
      db,
      ownsConnection: true,
      runId: input.runId,
      source: { path: resolved, absent },
      repoRoot: input.repoRoot ?? null,
    }),
  }
}

/**
 * The same surface over a connection the caller already owns.
 *
 * Exists for tests and for callers that are already inside a database (the
 * pipeline does not use it). A session built this way never closes the
 * connection: the caller opened it, so the caller closes it.
 */
export const reviewSessionFor = (
  db: Database,
  runId?: string,
  repoRoot?: string | null,
): ReviewSession =>
  createSession({
    db,
    ownsConnection: false,
    runId,
    // No file to name and nothing missing: the caller opened this connection, so
    // it is a database by construction.
    source: { path: null, absent: false },
    // Only a caller that names one gets the fallback: `reviewSessionFor` is mostly
    // tests, and a test that got a walk of *its own checkout* by default would be a
    // test whose expectations depend on where it was run from.
    repoRoot: repoRoot ?? null,
  })
