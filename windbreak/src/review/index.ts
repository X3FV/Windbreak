/**
 * The review surface (spec §5.3, §20.29.4, D32).
 *
 * Exported as its own entry point (`@codebuff/windbreak/review`) so the
 * adjudication screen can consume it without importing the CLI program in
 * `src/index.ts`, which parses `process.argv` as a side effect of being loaded.
 *
 * `createReviewInvestigator` is here rather than somewhere in the pipeline because the
 * screen is its only consumer, and it is a *bridge* rather than an
 * implementation: the screen calls `ask` and renders the result, and everything with a
 * model client, a target root, or a sandbox in it stays on this side of the line.
 */
export { openReviewSession, reviewSessionFor } from './session'
/**
 * §5.3's vocabulary, reachable through this entry point rather than only from `session.ts`.
 *
 * A screen has to *name* a decision to offer one — `r` and `b` are a value, not a string the
 * renderer invents — and `ReviewSession.decide` already takes this type, so a caller that could
 * name the decision only by importing the module it is declared in was reaching past the boundary
 * this file exists to draw.
 */
export type { ReviewDecision } from './session'
export { createReviewInvestigator, unscannedScratchDir } from './investigator'
/**
 * §20.31's two answers: which repository a directory is, and what is in it when
 * nothing has scanned it.
 *
 * Exported here rather than living in the CLI because the *session* uses the second
 * one — the fallback listing is a property of the queue surface, not of the screen
 * that happens to draw it — and the entry point uses the first to decide which
 * repository to hand the session and the bridge.
 */
export { readRepoCodebase, resolveRepoRoot, REPO_WALK_MAX_FILES } from './repo'
/**
 * §20.33's run listing, exported for the same reason the walk is: it is a property of
 * the queue's database, and the screen that draws the list is not the place that should
 * know the queue's schema.
 */
export { readReviewRuns } from './runs'

export type {
  CreateReviewInvestigatorOptions,
  ReviewInvestigator,
  ReviewInvestigatorTurn,
  ReviewWorkingCopyInfo,
} from './investigator'

export type {
  OpenReviewSessionResult,
  ReviewArgument,
  ReviewCodebase,
  ReviewCodebaseFile,
  ReviewFilesystemCodebase,
  ReviewInventoryCodebase,
  ReviewCounts,
  ReviewDatabase,
  ReviewDecisionResult,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewEvidence,
  ReviewQueueSource,
  ReviewRunSummary,
  ReviewSession,
} from './types'

/**
 * The shapes the chat pane renders, re-exported here rather than deep-imported.
 *
 * `@codebuff/windbreak/review` is the boundary the screen already consumes, and the pane
 * needs to name a mode, a proposal, and an injection signal to draw them. Reaching past
 * this entry point into `investigate/` would make the screen depend on the investigator's
 * internals, which is the coupling the bridge exists to avoid — the whole reason the
 * screen takes a `ReviewInvestigator` instead of a client.
 */
export type { InvestigatorMode } from '../investigate/persist'
/**
 * §18's account-level refusal, named here because it is part of the shape this boundary
 * hands a caller — `ReviewInvestigator.refusal` is one of these — so it has to be nameable
 * without reaching into `provider-failure`.
 *
 * The two short-name helpers used to be re-exported as *values* beside it, for the
 * adjudication pane: that surface put the refusal in its own words, and the copy saying
 * what the operator does about it belongs where the classification does rather than being
 * restated in the CLI, where it would drift. The pane is gone (§20.33 retired the screen
 * for a chat session) and nothing else asked for them, so they are no longer exported
 * here — a caller that needs them reads `provider-failure` directly, which is the one
 * module that decides what a refusal is.
 */
export type { ProviderFailure, ProviderFailureKind } from '../provider-failure'
/**
 * The refusal's own sentence, exported as a *value* because a pane has to draw it.
 *
 * This is the half of §18 that was deliberately withdrawn when the adjudication screen retired:
 * the two short-name helpers went with the pane that put a refusal in its own words, and §20.38
 * is that pane's successor, so the copy saying what the operator does about it belongs back where
 * the classification is rather than restated in the CLI, where it would drift.
 */
export { describeProviderFailure } from '../provider-failure'
export type { ProposedSite, ProposalRejection } from '../investigate/propose'
export type { InjectionSignal } from '../trust/injection'
export type { ConversationBudgetState } from '../investigate/conversation'
/**
 * §20.30's two agents, re-exported for the same reason the shapes above are: the pane
 * names the agent it is talking to, and reaching into `investigate/` for the union
 * would make the screen depend on the investigator's internals.
 */
export { AGENT_LABELS, DEFAULT_INVESTIGATOR_AGENT, INVESTIGATOR_AGENTS } from '../investigate/agents'
export type { InvestigatorAgentName } from '../investigate/agents'
export type { CopyWriteRecord } from '../investigate/tools'
