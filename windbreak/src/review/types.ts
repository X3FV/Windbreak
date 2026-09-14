/**
 * The review surface's data contract (spec §5.3, D32).
 *
 * Shaped for a screen rather than for a report: the list needs one line per
 * disagreement, and the detail needs both arguments in full, because resolving a
 * disagreement is exactly the act of reading two model answers and deciding
 * which one the code supports.
 */

import type { AdjudicationDecision } from '../pipeline'
import type { Database } from 'bun:sqlite'

/** One row of the queue, as the list renders it. */
export interface ReviewEntrySummary {
  candidateId: string
  runId: string
  filePath: string | null
  startLine: number | null
  cwe: string | null
  source: string
  patternId: string | null
  /** Null while the disagreement is unresolved. */
  decision: AdjudicationDecision | null
  decidedAt: string | null
  rationale: string | null
}

/**
 * One model's side of the disagreement.
 *
 * `verdict` is the model's own answer verbatim (`real` / `benign`), kept separate
 * from `role` because §5.2 records what a model said, not what it was asked to
 * conclude — and the two disagreeing is the whole reason the row exists.
 */
export interface ReviewArgument {
  role: 'proposer' | 'refuter'
  verdictId: string
  verdict: string | null
  reasoning: string
  /** §5.2's conditions "that must hold for the finding to be real". */
  preconditions: string[]
  modelId: string
  provider: string
}

/**
 * The candidate's evidence bundle, as escaped by the §5.1 pre-pass.
 *
 * Null when the stored bundle is unreadable. It is never an empty bundle: a
 * candidate whose evidence cannot be rendered is one a researcher must not be
 * shown as if it had no evidence.
 */
export interface ReviewEvidence {
  engine: string
  ruleId: string
  message: string
  level: string
  filePath: string
  startLine: number
  endLine: number | null
  snippet: string | null
  /**
   * Instruction-like lines neutralized before the model saw them (§5.1). Shown to
   * the researcher: the fact that the target tried to steer a model is evidence
   * about the finding.
   */
  injectionSignals: string[]
}

export interface ReviewEntryDetail {
  summary: ReviewEntrySummary
  candidateState: string
  target: {
    id: string
    location: string
    buildModel: string | null
    scopeClass: string | null
    commitSha: string | null
  } | null
  evidence: ReviewEvidence | null
  proposer: ReviewArgument | null
  refuter: ReviewArgument | null
}

export interface ReviewCounts {
  total: number
  pending: number
  resolved: number
}

/**
 * One run in the state database, for §20.33's resume screen.
 *
 * A run is what a researcher recognises — they started it, and the checkout and revision
 * it was pinned to are what they remember about it — so the target's *location* travels
 * with the row rather than only its id. `targetLocation` is null for a run whose target
 * row is gone, which is a state the screen says rather than one it fills in with the
 * current directory.
 *
 * The two counters are disagreements, not candidates: `queued` is what this run escalated
 * to §5.3 and `resolved` is how much of it has been decided. `queued` with a status that
 * never completed is what makes an interrupted run recognisable as one.
 */
export interface ReviewRunSummary {
  runId: string
  targetId: string
  targetLocation: string | null
  commitSha: string
  /** Null for a run whose start was never recorded; `resume` still lists it. */
  startedAt: string | null
  finishedAt: string | null
  /** §7.3's run status: `running`, `complete`, `partial`, `aborted` or `failed`. */
  status: string
  /** Disagreements this run escalated, decided or not. */
  queued: number
  /** Of `queued`, the ones a researcher has already decided. */
  resolved: number
}

/**
 * A decision, and what it replaced.
 *
 * `previous` is non-null when the entry had already been resolved, so a screen
 * can say "changing this from benign" instead of silently overwriting. §5.3 does
 * not forbid a second look; it forbids one happening out of sight.
 */
export interface ReviewDecisionResult {
  previous: AdjudicationDecision | null
}

/**
 * Where the queue on screen came from.
 *
 * §18's rule reaches the screen: an empty queue and a missing database are
 * different facts, and only one of them is good news. Both now open the screen,
 * so this is the field that keeps them distinguishable *inside* it — a screen
 * that cannot tell them apart has replaced "not checked" with "clean", which is
 * the substitution the rule exists to prevent.
 */
export interface ReviewQueueSource {
  /**
   * Absolute path the queue was read from, or null when the caller handed over
   * its own connection (`reviewSessionFor`), so there is no file to name.
   */
  path: string | null
  /**
   * True when nothing exists at `path` and the screen is showing an empty queue
   * *for that reason*. False for a database that exists and has nothing queued.
   */
  absent: boolean
}

/**
 * One row of the target's file inventory (§4.1's `recon_files`).
 *
 * The inventory recon records, not a directory walk: it is what the rest of the
 * pipeline reasons over, so listing it is listing *what was scanned* rather than
 * what happens to be on disk. Paths are relative to the target root, which is how
 * every stage refers to a file and how a candidate's `filePath` reads.
 */
export interface ReviewCodebaseFile {
  path: string
  language: string | null
  bytes: number
  binary: boolean
}

/**
 * The common half of the two listings the pane can draw (§20.30, §20.31).
 *
 * Three states reach `ReviewSession.codebase` and the pane says which one it is
 * in rather than collapsing them: an **inventory** (recon indexed these files, so
 * they are what the findings are about), a **filesystem listing** (a walk of a
 * checkout nothing has scanned), and **null** (no target on record *and* no
 * directory to fall back to). An empty `files` is a fourth fact and keeps the
 * recon case's own sentence — recon ran and indexed nothing, which is a statement
 * about recon and not about the repository. §18 applies to a file listing as much
 * as to a candidate list, and there are now four sentences rather than two.
 */
interface ReviewCodebaseBase {
  /** Absolute checkout path, so the pane names what it is listing. */
  location: string
  commitSha: string | null
  files: ReviewCodebaseFile[]
}

/**
 * What recon indexed for a target (§4.1's `recon_files`).
 *
 * The pane's preferred source, because these are the files the pipeline actually
 * reasons over: a finding's `filePath` is one of these rows and nothing else.
 */
export interface ReviewInventoryCodebase extends ReviewCodebaseBase {
  source: 'inventory'
  /** The target these rows belong to. */
  targetId: string
}

/**
 * A walk of the checkout, for a repository nothing has scanned (§20.31).
 *
 * The same shape as an inventory and deliberately not the same claim: nothing
 * here has been parsed, so no candidate cites any of it, no detector has run over
 * it, and it is not the set of files a finding is about. The pane labels it as
 * what it is rather than letting the two read alike.
 */
export interface ReviewFilesystemCodebase extends ReviewCodebaseBase {
  source: 'filesystem'
  /** True when the walk stopped at its file cap, so this listing is partial. */
  truncated: boolean
}

/**
 * The codebase behind the queue, for the screen's file pane (§20.30, §20.31).
 *
 * Nesting the same `location`/`commitSha`/`files` under a `source` discriminator
 * is what keeps the two claims apart while letting the pane draw both: a reader
 * that only wants rows is unchanged, and a reader that wants to know *what was
 * read* has to name which one it means.
 */
export type ReviewCodebase = ReviewInventoryCodebase | ReviewFilesystemCodebase

export interface ReviewSession {
  /** How this queue was obtained. See `ReviewQueueSource`. */
  readonly source: ReviewQueueSource
  list(options?: { includeResolved?: boolean }): ReviewEntrySummary[]
  detail(candidateId: string): ReviewEntryDetail | null
  decide(input: {
    candidateId: string
    decision: AdjudicationDecision
    rationale?: string | null
    now?: () => number
  }): ReviewDecisionResult
  counts(): ReviewCounts
  /**
   * Every run this database holds, newest first (§20.33).
   *
   * On the session rather than read by the caller, because the session already holds the
   * connection: a screen that opened its own would be a second reader of the same file
   * and a second place that has to know the queue's schema.
   */
  runs(): ReviewRunSummary[]
  /**
   * The target's file inventory, for the candidate's run (spec §20.30).
   *
   * The candidate decides *which* target: a queue can hold disagreements from more
   * than one run, and listing the newest run's codebase while the researcher is
   * looking at an older one's disagreement would name the wrong repository. With no
   * selection it falls back to the newest run, which is the same choice the
   * investigator's bridge already makes for a hunt.
   *
   * Falls back to a walk of the session's repository when no target is on record
   * (§20.31), so a checkout nothing has scanned still has a codebase to show —
   * carrying `source: 'filesystem'` so the pane says which listing it is. Null only
   * when there is neither a target nor a repository to walk. An empty `files` is
   * returned rather than null for a target recon never indexed: those are different
   * states and the pane exists to keep them apart.
   */
  codebase(candidateId: string | null): ReviewCodebase | null
  close(): void
}

/**
 * The outcome of opening a queue.
 *
 * A return value rather than a thrown error, because a database that cannot be
 * *used* — the wrong schema version, a file that is not a database — is a state
 * the screen has to render with its own message rather than a crash that leaves
 * the operator looking at an empty or partial screen.
 *
 * A database that is merely *absent* is not one of these: it opens, and
 * `session.source.absent` is what stops its empty queue from reading as an empty
 * queue. The distinction is the whole reason `source` exists.
 */
export type OpenReviewSessionResult =
  | { ok: true; session: ReviewSession }
  | { ok: false; reason: string }

/** Re-exported so a caller can type a connection it hands to `reviewSessionFor`. */
export type ReviewDatabase = Database
