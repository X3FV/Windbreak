/**
 * `scan` and `resume` (spec §3.2, §7.3, §9, §11.3).
 *
 * The orchestrator exists because the stages were built to be run and observed
 * one at a time, and the researcher's actual unit of work is a target. Chaining
 * them raises questions the individual commands never had to answer: one run or
 * many, one budget or many, and what happens to a half-finished target when a
 * stage refuses or the budget runs out. Those answers live here rather than
 * being re-derived by every caller.
 */

import type { Database } from 'bun:sqlite'
import type { WindbreakConfig } from '../config'
import type { ReportResult } from '../report'
import type { SandboxBackendName } from '../sandbox/types'
import type { ModelInvoker } from '../pipeline'
import type { LanguageCoverage } from './coverage'
import type { ScanDeps } from './run'

/**
 * §3.2's normative order. `id` is what `run_metrics.stage_json` records, so it
 * is also what `resume` keys off — renaming one would orphan a resumable run.
 */
export const SCAN_STAGE_IDS = [
  'ingestion',
  'known-vuln',
  'static-core',
  'triage',
  'verification',
  'reporting',
  'library-update',
] as const

export type ScanStageId = (typeof SCAN_STAGE_IDS)[number]

export type StageStatus = 'complete' | 'partial' | 'skipped' | 'failed' | 'aborted'

/** One stage's outcome, persisted into `run_metrics.stage_json`. */
export interface StageRecord {
  stage: ScanStageId
  status: StageStatus
  durationMs: number
  /** One line for the operator, e.g. `2 candidates`. */
  detail: string | null
  counts: Record<string, number>
  /** Why it was skipped or failed. Null when it ran. */
  reason: string | null
}

export type ScanStatus = 'complete' | 'partial' | 'aborted' | 'failed'

/** Aggregate counters, persisted into `run_metrics.counts_json`. */
export interface ScanCounts {
  filesIndexed: number
  symbols: number
  callSites: number
  candidates: number
  replays: number
  /** §4.4.1 candidates, kept separate from engine ones in the record. */
  patchMined: number
  /** Validated patch-mined patterns, whether or not they found a sibling. */
  patchPatterns: number
  /** §4.4.3 candidates, from all of its producers. */
  toctou: number
  /** Atomicity rules mined from the target's own history. */
  toctouRules: number
  /** Sites the four check-to-use FSMs reported. */
  toctouFsm: number
  /** Sites that touched a mined rule's resource without its lock. */
  toctouAtomicity: number
  /** Sites the four CWE-364 signal-handler shapes reported. */
  toctouSignal: number
  /** Function(s) the pre-pass identified as signal handlers. */
  signalHandlers: number
  triaged: number
  confirmed: number
  dropped: number
  escalated: number
  rediscovery: number
  findings: number
  excluded: number
}

export const EMPTY_COUNTS: ScanCounts = {
  filesIndexed: 0,
  symbols: 0,
  callSites: 0,
  candidates: 0,
  replays: 0,
  patchMined: 0,
  patchPatterns: 0,
  toctou: 0,
  toctouRules: 0,
  toctouFsm: 0,
  toctouAtomicity: 0,
  toctouSignal: 0,
  signalHandlers: 0,
  triaged: 0,
  confirmed: 0,
  dropped: 0,
  escalated: 0,
  rediscovery: 0,
  findings: 0,
  excluded: 0,
}

/**
 * How the model transport was (or was not) obtained.
 *
 * Modelling this as an outcome rather than a thrown error is the whole of the
 * chosen credential policy: a missing model environment must degrade a scan to
 * discovery-only, not abort it. Making it a return value means the degradation
 * is a case the orchestrator handles, not an exception it accidentally
 * swallows.
 */
export type InvokerOutcome =
  | { ok: true; invoker: ModelInvoker }
  | { ok: false; reason: string }

export interface ScanOptions {
  db: Database
  targetRoot: string
  targetId: string
  commitSha: string
  config: WindbreakConfig
  /** Skip every model stage; the scan ends after discovery. */
  staticOnly?: boolean
  /** §3.2 step 8. Off by default: it spends one synthesis call per finding. */
  updateLibrary?: boolean
  cacheDisabled?: boolean
  /** OSV re-query for the rediscovery pre-check. Default true. */
  refresh?: boolean
  /** The `needs-context` enrichment pass. Default true. */
  enrich?: boolean
  /** Run the sandboxed build during recon. Default true. */
  build?: boolean
  scratchDir?: string
  preferredBackend?: SandboxBackendName
  /** Total target budget; §9's one hour by default. */
  budgetSeconds?: number
  yes?: boolean
  /** Where report artifacts go. Defaults to the report stage's own default. */
  outDir?: string
  version: string
  /** Continue this run from its first incomplete stage (`resume`). */
  runId?: string
  /** Inject the model transport; otherwise one is resolved from the environment. */
  resolveInvoker?: () => Promise<InvokerOutcome>
  /**
   * Override the environment-touching stage entry points. Only tests supply
   * this; the pipeline stages are driven by `resolveInvoker` instead. The type
   * is a type-only import from `run.ts`, so there is no runtime cycle.
   */
  deps?: Partial<ScanDeps>
  log?: (line: string) => void
  now?: () => number
}

export interface ScanResult {
  runId: string
  targetId: string
  commitSha: string
  status: ScanStatus
  stages: StageRecord[]
  counts: ScanCounts
  /** Where a `resume` would pick up. Null when nothing is left to run. */
  resumeFrom: ScanStageId | null
  report: ReportResult | null
  /**
   * How much of the program model the C-shaped sweeps reached (§20.24.5). On the
   * result rather than only in `warnings`, because the summary prints it beside
   * the candidate counts — a `0 candidates` line must not be readable without the
   * `not swept` number next to it.
   */
  languageCoverage: LanguageCoverage
  warnings: string[]
}
