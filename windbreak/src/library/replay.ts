/**
 * Variant hunting — library replay (spec §4.8, §10, §12.2).
 *
 * One sweep answers: "of everything this researcher has already confirmed
 * somewhere, what does *this* target contain?" That is the payoff §4.8 describes
 * — a confirmed bug stops being a single finding and becomes a corpus-wide
 * search — and it is why replay is gated so hard at the other end. A pattern
 * that is wrong does not produce one wrong finding; it produces one per site, in
 * every target it is ever pointed at.
 *
 * The sweep is therefore three filters deep, in order:
 *
 * 1. `condition = 'confirmed'` (D15), or an explicit
 *    `--allow-statically-verified` opt-in for a pattern whose seeding finding
 *    was only model-verified.
 * 2. Revalidation against the site it was mined from (§10) — skipped, not
 *    tuned, when it has drifted.
 * 3. A per-pattern candidate cap, so a broad pattern degrades into a bounded
 *    batch with a warning instead of flooding triage.
 */

import { normalizeFindings, SourceCache } from '../engines/normalize'
import { describeFingerprint } from './fingerprint'
import { matchFingerprint } from './match'
import { revalidateChecker } from './revalidate'
import { measurePatternPrecision, readLibrary, recordReplay, updateReplayStatistics } from './store'

import type { Database } from 'bun:sqlite'
import type { Candidate, RawFinding } from '../engines/types'
import type { LibraryEntry, ReplayOutcome, VariantHuntResult } from './types'

/**
 * A broad pattern on a large target can match thousands of sites. Capping keeps
 * the sweep's *cost* bounded and, more importantly, keeps triage's input
 * reviewable: a batch of ten thousand candidates is functionally the same as no
 * answer at all.
 */
export const DEFAULT_MAX_CANDIDATES_PER_PATTERN = 200

/**
 * What the variant hunt is asked to sweep — all of it JSON (§20.17.3).
 *
 * The patterns themselves are not in the request: they are read from the library
 * rows, which is what makes the sweep's input the library rather than an
 * argument. A transport would have to decide whether that is a request field or
 * a service call; today it is neither, because replay is the stage that owns the
 * read.
 */
export interface VariantHuntRequest {
  /** The target being swept. */
  targetId: string
  /** Its checkout, for reading the snippets candidates carry. */
  targetRoot: string
  runId: string
  targetCommitSha?: string | null
  /** A post-image target, when §10's silence check can actually run. */
  postImageTargetId?: string | undefined
  /** Permit replay of patterns whose seeding finding was not human-reproduced. */
  allowStaticallyVerified?: boolean
  /** Restrict the sweep to one pattern id (§12.2's `patternId`). */
  patternId?: string
  maxCandidatesPerPattern?: number
}

/** What the variant hunt needs from the host — none of it serializable. */
export interface VariantHuntServices {
  db: Database
  /** Injectable so tests can fix timestamps. */
  now?: () => number
  log?: (line: string) => void
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type VariantHuntOptions = VariantHuntRequest & VariantHuntServices

const findingFor = (checker: LibraryEntry, hit: { filePath: string; line: number }): RawFinding => ({
  engine: 'variant-hunt',
  // The library entry's pattern id *is* the rule id, so a replayed candidate's
  // `pattern_id` points straight back at the entry that produced it.
  ruleId: checker.patternId,
  // A replayed match is a candidate for triage, not a confirmed finding, so it
  // never claims engine severity it has not earned.
  level: 'warning',
  message: describeFingerprint(checker.fingerprint),
  filePath: hit.filePath,
  startLine: hit.line,
  endLine: hit.line,
  snippet: null,
  cwe: checker.fingerprint.cwe,
  precision: null,
})

/**
 * Replay every eligible pattern against one target.
 *
 * Never throws on a per-pattern problem: one unreadable row or one drifted
 * pattern must not abort a sweep, because the sweep's output is what the
 * researcher is waiting for.
 */
export const runVariantHunt = (options: VariantHuntOptions): VariantHuntResult => {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const cap = options.maxCandidatesPerPattern ?? DEFAULT_MAX_CANDIDATES_PER_PATTERN
  const warnings: string[] = []
  const outcomes: ReplayOutcome[] = []

  const entries = readLibrary(options.db, {
    ...(options.patternId ? { patternId: options.patternId } : {}),
  })

  if (entries.length === 0) {
    warnings.push(
      options.patternId
        ? `no live library entry has pattern id "${options.patternId}"`
        : 'the pattern library is empty; nothing to replay',
    )
  }

  const sourceCache = new SourceCache(options.targetRoot)
  const candidates: Candidate[] = []

  for (const checker of entries) {
    // --- gate 1: D15, with an explicit opt-in ---
    if (checker.condition !== 'confirmed' && !options.allowStaticallyVerified) {
      const reason =
        `seeding finding's evidence tier is ${checker.evidenceTier ?? 'unrecorded'}, ` +
        'so this pattern is not confirmed for replay (§10). Pass ' +
        '--allow-statically-verified to replay it anyway.'
      outcomes.push({
        checkerId: checker.id,
        patternId: checker.patternId,
        revalidated: false,
        skippedReason: reason,
        candidatesFound: 0,
      })
      recordReplay({
        db: options.db,
        checkerId: checker.id,
        targetId: options.targetId,
        revalidated: false,
        candidatesFound: 0,
        skippedReason: reason,
        targetCommitSha: options.targetCommitSha ?? null,
        now,
      })
      log(`[library] ${checker.patternId}: refused — ${reason}`)
      continue
    }

    // --- gate 2: §10 revalidation ---
    const validation = revalidateChecker({
      db: options.db,
      checker,
      ...(options.postImageTargetId ? { postImageTargetId: options.postImageTargetId } : {}),
    })

    if (!validation.revalidated) {
      outcomes.push({
        checkerId: checker.id,
        patternId: checker.patternId,
        revalidated: false,
        skippedReason: validation.reason,
        candidatesFound: 0,
      })
      recordReplay({
        db: options.db,
        checkerId: checker.id,
        targetId: options.targetId,
        revalidated: false,
        candidatesFound: 0,
        skippedReason: validation.reason,
        targetCommitSha: options.targetCommitSha ?? null,
        now,
      })
      updateReplayStatistics({
        db: options.db,
        checkerId: checker.id,
        preImageHits: validation.preImageHits,
        postImageClean: validation.postImageClean,
        precisionObserved: checker.precisionObserved,
      })
      log(`[library] ${checker.patternId}: skipped — ${validation.reason}`)
      continue
    }

    // --- gate 3: match, with a bounded batch ---
    const hits = matchFingerprint({
      db: options.db,
      targetId: options.targetId,
      fingerprint: checker.fingerprint,
    })

    let used = hits
    if (hits.length > cap) {
      used = hits.slice(0, cap)
      warnings.push(
        `${checker.patternId} matched ${hits.length} site(s) in this target; only the ` +
          `first ${cap} became candidates. The pattern is broader than the bug it came from.`,
      )
    }

    const normalized = normalizeFindings(
      used.map((hit) => findingFor(checker, hit)),
      { runId: options.runId, targetRoot: options.targetRoot, sourceCache },
    )

    for (const candidate of normalized.candidates) {
      candidate.originPatchSha = checker.originPatchSha
    }

    candidates.push(...normalized.candidates)

    outcomes.push({
      checkerId: checker.id,
      patternId: checker.patternId,
      revalidated: true,
      skippedReason: null,
      candidatesFound: normalized.candidates.length,
    })

    recordReplay({
      db: options.db,
      checkerId: checker.id,
      targetId: options.targetId,
      revalidated: true,
      candidatesFound: normalized.candidates.length,
      skippedReason: null,
      targetCommitSha: options.targetCommitSha ?? null,
      now,
    })

    updateReplayStatistics({
      db: options.db,
      checkerId: checker.id,
      preImageHits: validation.preImageHits,
      postImageClean: validation.postImageClean,
      // Precision is measured over the candidates the pattern has produced
      // *including* this sweep, so it is recomputed after persisting them — see
      // the caller. Until then the previous value is carried forward unchanged.
      precisionObserved: checker.precisionObserved,
    })

    log(
      `[library] ${checker.patternId}: ${normalized.candidates.length} candidate(s) ` +
        `from ${hits.length} site(s)`,
    )
  }

  return {
    candidates,
    checkersConsidered: entries.length,
    outcomes,
    warnings,
  }
}

/**
 * Refresh each replayed pattern's §10 precision figure.
 *
 * Called by the CLI *after* the candidates are persisted, because the
 * denominator is the candidate rows themselves — measuring before the insert
 * would record a precision that is always one sweep stale.
 */
export const refreshPatternPrecision = (input: {
  db: Database
  patternIds: readonly string[]
}): Record<string, number | null> => {
  const measured: Record<string, number | null> = {}

  for (const patternId of new Set(input.patternIds)) {
    const precision = measurePatternPrecision(input.db, patternId)
    measured[patternId] = precision.precision

    input.db
      .prepare('UPDATE checkers SET precision_observed = ? WHERE pattern_id = ?')
      .run(precision.precision, patternId)
  }

  return measured
}
