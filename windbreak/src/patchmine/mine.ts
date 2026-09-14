/**
 * Patch-mined discovery, Phase A (spec §4.4.1).
 *
 * The pipeline is: read the target's own history → classify each hunk into one of
 * §4.4.1's five shapes → validate that the shape detector discriminates that
 * patch's pre-image from its post-image → sweep the current tree for sibling sites
 * → emit §4.5 candidates with a `pattern_id` and the originating patch SHA.
 *
 * ## What is a pattern, and what is a candidate
 *
 * A pattern is keyed on **what its sweep is parameterised by**: the shape and the
 * operation. Not the subject (a local name that appears in no other function) and
 * not the commit that produced it. Two commits adding a null check around
 * `strcpy` are the same pattern; keying on the commit would produce two patterns
 * that sweep identically and emit the same candidate twice, and keying on the
 * subject would do the same thing via a different route. The multiplicity is kept
 * as `occurrences`, and the newest commit that exhibited it is the recorded
 * origin.
 *
 * ## Why the candidate goes through the engines' normaliser
 *
 * §4.5 says every candidate is normalised into one schema *regardless of which
 * stage produced it*, and patch-mined candidates are not an exception. Rather than
 * assemble the shape by hand, this builds a `RawFinding` and calls the engines'
 * `normalizeFinding`, which is what supplies the slice hash, the source text, and
 * the §5.1 injection signals. A second implementation of that would be a second
 * place for the slice hash to be wrong, and the slice hash is what binds a
 * candidate to the exact source a later stage reasons about.
 *
 * The commit subject is **recorded rather than used as a filter**, which is a
 * deliberate reading of §4.4.1's "for each historical FIX commit". What makes a
 * patch admissible is §4.4.1's validation, not its commit message: a feature
 * commit that added a null check genuinely records that this codebase used a
 * pointer unguarded, and it validates as cleanly as a bug fix would. Filtering on
 * the subject would therefore discard real patterns to honour a heuristic the spec
 * does not actually require — so the heuristic is available
 * (`fixSubjectsOnly`) and off by default.
 */

import { createHash } from 'crypto'

import { normalizeFinding, SourceCache } from '../engines/normalize'
import { persistCandidates } from '../engines/persist'
import { createSandboxGitRunner } from '../recon/run'
import { classifyHunk } from './shapes'
import { readCommitHistory } from './history'
import { findSiblingSites } from './siblings'
import { validateShape } from './validate'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { Candidate, RawFinding } from '../engines/types'
import type { DetectOptions } from '../sandbox/backends'
import type { SandboxSpawn } from '../sandbox/run'
import type { SandboxBackendName } from '../sandbox/types'
import type { GitRunner } from './history'
import type {
  CommitCoverage,
  FixShape,
  MinedPattern,
  PatchMineResult,
  RejectedPattern,
  SiblingSite,
} from './types'

/**
 * §4.4.1 says "for each historical FIX commit". This is the heuristic for what
 * that means when it is switched on; see the module note for why it is not the
 * default.
 */
export const FIX_SUBJECT =
  /\b(fix|fixes|fixed|bug|bugfix|patch|hotfix|issue|cve-\d{4}|sanitiz|guard|harden|bounds|null[- ]?check|overflow|underflow|use[- ]after[- ]free|uaf|leak|race|toctou|security|vuln)/i

/** Below this much remaining static-core budget, sweeping is pointless. */
export const MIN_SWEEP_MS = 2_000

/**
 * The pattern key: shape plus operation, and nothing else.
 *
 * Both parts are what `siblings.ts` acts on, so this is exactly the equivalence
 * "these two patches would sweep for the same thing" — which is the right notion
 * of pattern identity for a stage whose output is candidates.
 */
export const patternId = (shape: FixShape, operation: string | null): string =>
  `pm_${createHash('sha256')
    .update(`${shape}|${operation ?? ''}`)
    .digest('hex')
    .slice(0, 16)}`

/** Everything the mining stage is asked for — all of it JSON (§20.17.3). */
export interface PatchMineRequest {
  /** Target checkout root. */
  targetRoot: string
  targetId: string
  runId?: string
  maxCommits?: number
  maxSitesPerPattern?: number
  /** Apply §4.4.1's "fix commit" subject heuristic. Off by default (see above). */
  fixSubjectsOnly?: boolean
  historyTimeLimitSeconds?: number
  preferredBackend?: SandboxBackendName
}

/** What mining needs from the host — none of it serializable. */
export interface PatchMineServices {
  db?: Database
  /** Shares `static-core` with the engines stage; the clock is stage-wide. */
  governor?: BudgetGovernor
  runGit?: GitRunner
  sourceCache?: SourceCache
  detect?: DetectOptions
  spawn?: SandboxSpawn
  log?: (line: string) => void
  now?: () => number
}

export type PatchMineOptions = PatchMineRequest & PatchMineServices

export interface PatchMineOutcome extends PatchMineResult {
  /** Sites that became §4.5 candidates, after normalisation. */
  candidates: Candidate[]
  persisted: number
}

/**
 * Mine the target's history for validated patterns and sweep for sibling sites.
 *
 * Never throws for a target that cannot be mined: a non-repository, an empty
 * history, or a missing program model each produce a warning and an empty result,
 * because patch mining is one discovery path among several and the engines stage
 * runs regardless. Failing the whole static core because history was unreadable
 * would trade a thin net for no net.
 */
export const runPatchMining = async (
  options: PatchMineOptions,
): Promise<PatchMineOutcome> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const runId = options.runId ?? 'unpersisted'

  const runGit =
    options.runGit ??
    createSandboxGitRunner(options.targetRoot, {
      ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.historyTimeLimitSeconds !== undefined
        ? { timeLimitSeconds: options.historyTimeLimitSeconds }
        : {}),
    })

  const history = await readCommitHistory({
    runGit,
    ...(options.maxCommits !== undefined ? { maxCommits: options.maxCommits } : {}),
  })
  warnings.push(...history.warnings)

  const coverage: CommitCoverage = {
    commitsRead: history.commits.length,
    commitsWithPatches: 0,
    hunksExamined: 0,
    hunksUnrecognised: 0,
  }

  const patterns = new Map<string, MinedPattern>()
  const rejected: RejectedPattern[] = []
  let commitsConsidered = 0

  for (const commit of history.commits) {
    if (commit.hunks.length === 0) continue
    coverage.commitsWithPatches += 1

    if (options.fixSubjectsOnly === true && !FIX_SUBJECT.test(commit.subject)) continue
    commitsConsidered += 1

    for (const hunk of commit.hunks) {
      coverage.hunksExamined += 1

      const classified = classifyHunk(hunk)
      if (classified === null) {
        coverage.hunksUnrecognised += 1
        continue
      }

      const subject = classified.hint.subject ?? null
      const operation = classified.hint.operation ?? null
      const validation = validateShape(hunk, classified.shape, classified.hint)

      if (!validation.accepted) {
        rejected.push({
          shape: classified.shape,
          originPatchSha: commit.sha,
          originFile: hunk.filePath,
          subject,
          operation,
          validation,
        })
        continue
      }

      const id = patternId(classified.shape, operation)
      const existing = patterns.get(id)
      if (existing) {
        existing.occurrences += 1
        continue
      }

      patterns.set(id, {
        id,
        shape: classified.shape,
        originPatchSha: commit.sha,
        originFile: hunk.filePath,
        originSubject: commit.subject,
        subject,
        operation,
        description: classified.description,
        validation,
        occurrences: 1,
      })
    }
  }

  const mined = [...patterns.values()].sort(
    (left, right) =>
      right.occurrences - left.occurrences || left.id.localeCompare(right.id),
  )

  log(
    `[patch-mine] ${coverage.commitsRead} commit(s) read, ${coverage.hunksExamined} hunk(s) ` +
      `examined, ${mined.length} validated pattern(s), ${rejected.length} hunk(s) dropped`,
  )

  // §9: mining is part of the static core, so it shares that stage's clock with
  // the engines rather than opening a second one. `session()` returns a per-stage
  // view, so this cannot double-count the share.
  const session = options.governor?.session('static-core') ?? null
  let stoppedBy: PatchMineResult['stoppedBy'] = null

  if (session && (session.exhausted() || session.remainingMs() < MIN_SWEEP_MS)) {
    const action = await options.governor!.resolveOverrun(
      'static-core',
      session.elapsedSeconds(),
    )
    if (action !== 'continue') {
      stoppedBy = action === 'abort' ? 'budget-abort' : 'budget-degrade'
      warnings.push(
        `Sibling sweep skipped: the static core is at the budget governor's ${action} ` +
          `decision. ${mined.length} pattern(s) were still recorded.`,
      )
      return {
        patterns: mined,
        rejected,
        sites: [],
        commitsConsidered,
        coverage,
        warnings,
        stoppedBy,
        candidates: [],
        persisted: 0,
      }
    }
  }

  const sourceCache =
    options.sourceCache ?? new SourceCache(options.targetRoot)

  // The sweep reads the program model, which lives in the database. No database
  // means no indexed functions, which is a *missing input* rather than an empty
  // result — the difference between "nothing to search" and "searched nothing" is
  // the whole reason the patterns are returned either way.
  let sites: SiblingSite[] = []
  if (options.db) {
    const sweep = findSiblingSites({
      db: options.db,
      targetId: options.targetId,
      targetRoot: options.targetRoot,
      patterns: mined,
      sourceCache,
      ...(options.maxSitesPerPattern !== undefined
        ? { maxSitesPerPattern: options.maxSitesPerPattern }
        : {}),
      log,
    })
    sites = sweep.sites
    warnings.push(...sweep.warnings)
  } else {
    warnings.push(
      'No state database, so there is no program model to sweep for sibling sites. ' +
        'Patterns were still mined and are reported below.',
    )
  }

  const byId = new Map(mined.map((pattern) => [pattern.id, pattern]))
  const candidates = sites.flatMap((site) => {
    const pattern = byId.get(site.patternId)
    if (!pattern) return []

    const finding: RawFinding = {
      engine: 'patch-mined',
      ruleId: pattern.id,
      level: 'warning',
      message:
        `${pattern.description} — ${site.evidence} ` +
        `[${pattern.shape} pattern ${pattern.id}, mined from ${pattern.originPatchSha.slice(0, 12)}]`,
      filePath: site.filePath,
      startLine: site.matchLine,
      endLine: site.matchLine,
      // The slice is read from the file by the normaliser, which is what makes
      // the candidate's hash authoritative rather than a copy of a diff offset.
      snippet: null,
      cwe: null,
      precision: null,
    }

    const candidate = normalizeFinding(finding, {
      runId,
      targetRoot: options.targetRoot,
      sourceCache,
    })

    // §4.4.1: the candidate carries the originating patch SHA.
    return [{ ...candidate, originPatchSha: pattern.originPatchSha }]
  })

  let persisted = 0
  if (options.db && options.runId && candidates.length > 0) {
    const result = persistCandidates({
      db: options.db,
      runId: options.runId,
      candidates,
    })
    persisted = result.inserted
    log(`[patch-mine] persisted ${persisted} patch-mined candidate(s)`)
  }

  return {
    patterns: mined,
    rejected,
    sites,
    commitsConsidered,
    coverage,
    warnings,
    stoppedBy,
    candidates,
    persisted,
  }
}
