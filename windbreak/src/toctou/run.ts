/**
 * The TOCTOU / race stage (spec §4.4.3).
 *
 * The pipeline mirrors `patchmine/mine.ts`, because both are "read the target's own
 * history, mine a reusable statement from it, sweep the current tree for sites, emit
 * §4.5 candidates" — the difference is what is mined. Phase A mines *shapes* from fix
 * commits and sweeps for the same shape; §4.4.3 mines *atomicity rules* from
 * lock-adding patches and additionally drives four fixed state machines over every
 * indexed function.
 *
 * ## Why this reads the history itself
 *
 * It calls `readCommitHistory` rather than taking Phase A's commits as an input.
 * That is a second sandboxed `git log` walk over the same range, and it is a real,
 * recorded cost (§20.22) — but the alternative is worse: threading Phase A's parsed
 * history through the orchestrator would make §4.4.3 un-runnable on its own, and
 * every stage in this project is built to be runnable and observable alone. The two
 * also read the history for *disjoint* reasons, so sharing a parse would couple two
 * miners that have no other business with each other.
 *
 * ## Candidates, not findings
 *
 * Nothing here decides that a race is real. An FSM match is a statement that a
 * check and a use share a resource with something in between; a rule violation is a
 * statement that a mined pairing is not held somewhere. Both are §4.5 candidates,
 * and §4.4.3's own priority — logic flaw over memory corruption — is why they are
 * worth the model calls: a human confirming a race is the point of the flag, and
 * the `toctou-fsm` candidate source carries that framing into the prompt rather
 * than letting it read as a memory-safety engine hit.
 */

import { normalizeFinding, SourceCache } from '../engines/normalize'
import { persistCandidates } from '../engines/persist'
import { createSandboxGitRunner } from '../recon/run'
import { readCommitHistory } from '../patchmine/history'
import { FIX_SUBJECT } from '../patchmine/mine'
import { TOCTOU_FSMS, signalProducer } from './types'
import { mineRulesFromHunks, mergeRules } from './rules'
import { sweepFunctions } from './scan'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { Candidate, RawFinding } from '../engines/types'
import type { GitRunner } from '../patchmine/history'
import type { DetectOptions } from '../sandbox/backends'
import type { SandboxSpawn } from '../sandbox/run'
import type { SandboxBackendName } from '../sandbox/types'
import { describeSite } from './describe'

import type {
  AtomicityRule,
  ToctouCoverage,
  ToctouFsm,
  ToctouSite,
  ToctouSweepOutcome,
} from './types'

/** Below this much remaining static-core budget, sweeping is pointless. */
export const MIN_SWEEP_MS = 2_000

/** Everything the TOCTOU stage is asked for — all of it JSON (§20.17.3). */
export interface ToctouRequest {
  /** Target checkout root. */
  targetRoot: string
  targetId: string
  runId?: string
  maxCommits?: number
  maxSitesPerProducer?: number
  /** Restrict to a subset of the four FSMs. Default: all of them. */
  fsms?: ToctouFsm[]
  /**
   * Run the CWE-364 signal-handler producer. Default true.
   *
   * JSON-serializable, so it belongs on the request rather than the services — the
   * same split §20.17.3 draws for everything else here.
   */
  signalHandlers?: boolean
  /** Apply the "fix commit" subject heuristic to the rule mining. Off by default. */
  fixSubjectsOnly?: boolean
  /**
   * Run §4.4.3's interprocedural pass: the caller-lock annotation and the
   * cross-function check-to-use producer. Default true.
   *
   * Declinable because it is the expensive half — it reads every indexed function once
   * more to summarize parameters and lock holdings — and because a target with no lock
   * rules and no cross-function path handling gains nothing from it.
   */
  interprocedural?: boolean
  historyTimeLimitSeconds?: number
  preferredBackend?: SandboxBackendName
}

/** What the stage needs from the host — none of it serializable. */
export interface ToctouServices {
  db?: Database
  /** Shares `static-core` with the engines and patch mining; the clock is stage-wide. */
  governor?: BudgetGovernor
  runGit?: GitRunner
  sourceCache?: SourceCache
  detect?: DetectOptions
  spawn?: SandboxSpawn
  log?: (line: string) => void
  now?: () => number
}

export type ToctouOptions = ToctouRequest & ToctouServices

/**
 * The CWE a site is filed under, or null when there is no honest one.
 *
 * Per-shape rather than per-producer, because the shapes are different weaknesses
 * and one of them is a *child* of the other's parent. `unsafe-call` is CWE-828,
 * "Signal Handler with Functionality that is not Asynchronous-Safe" — MITRE makes it
 * a child of 364, and its own child 479 is the non-reentrant subset. Filing it as 364
 * would be a small overclaim in the one direction this module is careful about, so it
 * carries the id the table in `handlers.ts` was actually built to.
 *
 * The other three are CWE-364 itself. The four check-to-use FSMs and the atomicity
 * rules stay null: two of them are not memory-safety classes, and claiming one would
 * file a logic flaw under a memory-corruption category — the framing §4.4.3's priority
 * rule exists to avoid.
 */
const cweFor = (site: ToctouSite): string | null => {
  if (site.kind !== 'signal') return null
  return site.shape === 'unsafe-call' ? 'CWE-828' : 'CWE-364'
}

export interface ToctouResult {
  rules: AtomicityRule[]
  sites: ToctouSite[]
  outcomes: ToctouSweepOutcome[]
  coverage: ToctouCoverage
  fixesConsidered: number
  warnings: string[]
  /** Set when the governor stopped the stage early. */
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
}

export interface ToctouOutcome extends ToctouResult {
  /** Sites that became §4.5 candidates, after normalisation. */
  candidates: Candidate[]
  persisted: number
}

/**
 * A stable id for the producer that reported a site.
 *
 * Shared with the candidate's `ruleId`, so the run's per-producer counts and the
 * candidate rows name the same thing — an operator reading
 * `fsm:double-fetch 3` can find the three candidates it counted.
 */
export const producerId = (site: ToctouSite): string => {
  switch (site.kind) {
    case 'fsm':
      return `toctou:${site.fsm}`
    case 'atomicity':
      return `atomicity:${site.ruleId}`
    case 'signal':
      return signalProducer(site.shape)
    case 'interproc':
      // One producer rather than a family, so the id carries no variant. It matches the
      // `interproc` outcome the sweep reports, which is what lets an operator reading
      // `interproc 2` find the two candidates it counted.
      return 'interproc'
  }
}

/**
 * Mine atomicity rules, sweep for sites, and emit candidates.
 *
 * Never throws for a target that cannot be mined. A non-repository, an empty
 * history, or a missing program model each produce a warning and an empty result,
 * because §4.4.3 is one discovery path among several and the engines stage runs
 * regardless — the same reasoning `runPatchMining` uses.
 */
export const runToctou = async (options: ToctouOptions): Promise<ToctouOutcome> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const runId = options.runId ?? 'unpersisted'
  const fsms = options.fsms ?? TOCTOU_FSMS

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

  const coverage: ToctouCoverage = {
    commitsRead: history.commits.length,
    hunksAddingLock: 0,
    hunksWithoutResource: 0,
    functionsSwept: 0,
    functionsWithEvents: 0,
    signalHandlers: 0,
    sharedKeys: 0,
    noDetectorTables: 0,
    callerGuardedSites: 0,
    callEdges: 0,
    callSitesSeen: 0,
    callSitesUnattributed: 0,
    callSitesAmbiguous: 0,
  }

  const perCommit: AtomicityRule[][] = []
  let fixesConsidered = 0

  for (const commit of history.commits) {
    if (commit.hunks.length === 0) continue
    if (options.fixSubjectsOnly === true && !FIX_SUBJECT.test(commit.subject)) continue
    // The subject heuristic is available for parity with `patch-mine`, but here it
    // is *not* the default and does not need to be: what admits a rule is that the
    // patch added locking, which is a fact about the diff rather than about the
    // message.
    if (options.fixSubjectsOnly === true) fixesConsidered += 1

    const mined = mineRulesFromHunks({
      hunks: commit.hunks,
      originPatchSha: commit.sha,
    })
    coverage.hunksAddingLock += mined.hunksAddingLock
    coverage.hunksWithoutResource += mined.hunksWithoutResource
    if (mined.rules.length > 0) perCommit.push(mined.rules)
  }

  const rules = mergeRules(perCommit)

  log(
    `[toctou] ${coverage.commitsRead} commit(s) read, ${coverage.hunksAddingLock} hunk(s) ` +
      `added locking, ${rules.length} atomicity rule(s) mined`,
  )

  // §9: §4.4.3 is part of the static core, so it shares that stage's clock rather
  // than opening a second one (`session()` is a per-stage view, so this cannot
  // double-count the share).
  const session = options.governor?.session('static-core') ?? null
  if (session && (session.exhausted() || session.remainingMs() < MIN_SWEEP_MS)) {
    const action = await options.governor!.resolveOverrun(
      'static-core',
      session.elapsedSeconds(),
    )
    if (action !== 'continue') {
      const stoppedBy = action === 'abort' ? 'budget-abort' : 'budget-degrade'
      warnings.push(
        `Check-to-use sweep skipped: the static core is at the budget governor's ` +
          `${action} decision. ${rules.length} atomicity rule(s) were still mined.`,
      )
      return {
        rules,
        sites: [],
        outcomes: [],
        coverage,
        fixesConsidered,
        warnings,
        stoppedBy,
        candidates: [],
        persisted: 0,
      }
    }
  }

  const sourceCache = options.sourceCache ?? new SourceCache(options.targetRoot)

  // No database means no program model, which is a *missing input* rather than an
  // empty result — see `patchmine/mine.ts`'s note on the same distinction.
  let sites: ToctouSite[] = []
  let outcomes: ToctouSweepOutcome[] = []
  if (options.db) {
    const sweep = sweepFunctions({
      db: options.db,
      targetId: options.targetId,
      targetRoot: options.targetRoot,
      rules,
      fsms,
      sourceCache,
      ...(options.signalHandlers !== undefined
        ? { signalHandlers: options.signalHandlers }
        : {}),
      ...(options.maxSitesPerProducer !== undefined
        ? { maxSitesPerProducer: options.maxSitesPerProducer }
        : {}),
      ...(options.interprocedural !== undefined
        ? { interprocedural: options.interprocedural }
        : {}),
      log,
    })
    sites = sweep.sites
    outcomes = sweep.outcomes
    coverage.functionsSwept = sweep.coverage.functionsSwept
    coverage.functionsWithEvents = sweep.coverage.functionsWithEvents
    coverage.signalHandlers = sweep.coverage.signalHandlers
    coverage.sharedKeys = sweep.coverage.sharedKeys
    coverage.callerGuardedSites = sweep.coverage.callerGuardedSites
    coverage.callEdges = sweep.coverage.callEdges
    coverage.callSitesSeen = sweep.coverage.callSitesSeen
    coverage.callSitesUnattributed = sweep.coverage.callSitesUnattributed
    coverage.callSitesAmbiguous = sweep.coverage.callSitesAmbiguous
    warnings.push(...sweep.warnings)
  } else {
    warnings.push(
      'No state database, so there is no program model to validate check-to-use ' +
        'patterns against. Atomicity rules were still mined and are reported below.',
    )
  }

  const findings: RawFinding[] = sites.map((site) => ({
    engine: site.kind === 'signal' ? 'toctou-signal' : 'toctou-fsm',
    ruleId: producerId(site),
    level: 'warning',
    message: describeSite(site),
    filePath: site.filePath,
    startLine: site.matchLine,
    endLine: site.matchLine,
    // The slice is read from the file by the normaliser, which is what makes the
    // candidate's hash authoritative rather than a copy of a diff offset.
    snippet: null,
    cwe: cweFor(site),
    precision: null,
  }))

  const candidates = findings.map((finding) =>
    normalizeFinding(finding, {
      runId,
      targetRoot: options.targetRoot,
      sourceCache,
    }),
  )

  let persisted = 0
  if (options.db && options.runId && candidates.length > 0) {
    const result = persistCandidates({
      db: options.db,
      runId: options.runId,
      candidates,
    })
    persisted = result.inserted
    log(`[toctou] persisted ${persisted} toctou candidate(s)`)
  }

  return {
    rules,
    sites,
    outcomes,
    coverage,
    fixesConsidered,
    warnings,
    stoppedBy: null,
    candidates,
    persisted,
  }
}
