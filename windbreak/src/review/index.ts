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
