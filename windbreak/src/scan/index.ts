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
export { formatLanguageCoverage, readLanguageCoverage } from './coverage'
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

export type { RunMetrics, ScanStageDefinition } from './stages'
export type { LanguageCoverage, LanguageCoverageEntry } from './coverage'
export type { ScanOptions, ScanResult, ScanStageId, ScanStatus, StageRecord, StageStatus } from './types'
export { EMPTY_COUNTS, SCAN_STAGE_IDS } from './types'
