/**
 * `scan` and `resume` — the orchestrator over §3.2's stages.
 */
export { defaultResolveInvoker, runScan } from './run'
/**
 * The launcher a screen uses (§20.33): the same orchestrator, with the database, the
 * target and the non-interactive decider resolved for a caller that has no shell.
 */
export { launchScan } from './launch'
export type { LaunchScanOptions, LaunchScanOutcome } from './launch'
export {
  formatInterproceduralCoverage,
  formatLanguageCoverage,
  readLanguageCoverage,
} from './coverage'
export {
  carriedElapsedSeconds,
  deriveCounts,
  firstIncompleteStage,
  LIBRARY_OPT_IN_SKIP,
  modelsUsedByRun,
  readRunMetrics,
  SCAN_STAGES,
  skippedByRequest,
  stageDefinition,
  STATIC_ONLY_SKIP,
  writeRunMetrics,
} from './stages'

/**
 * §18's account-level refusal, re-exported for the surfaces that print a `ScanResult`.
 *
 * `scan` and `pipeline` both print the result of a scan and both have to say this about it,
 * and neither should be the second place that knows what a depleted balance reads like.
 * Only the sentence is re-exported: the two short-name helpers have no caller outside
 * `provider-failure` itself, and the adjudication pane that used them is gone (§20.33
 * retired the screen for a chat session). The types stay because a caller naming
 * `ScanResult.providerFailure` needs them.
 */
export { describeProviderFailure } from '../provider-failure'
export type { ProviderFailure, ProviderFailureKind } from '../provider-failure'

export type { RunMetrics, ScanStageDefinition } from './stages'
export type { LanguageCoverage, LanguageCoverageEntry } from './coverage'
export type { ScanOptions, ScanResult, ScanStageId, ScanStatus, StageRecord, StageStatus } from './types'
export { EMPTY_COUNTS, SCAN_STAGE_IDS } from './types'
