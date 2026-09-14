/**
 * Candidate pipeline orchestration (spec §4.6 -> §5.2 -> §5.3).
 *
 * Order matters and is deliberate: rediscovery is checked **first**, before any
 * model call, because §4.2 routes a rediscovery to reporting instead of
 * verification to avoid re-deriving a bug that is already known and patched.
 * That check is free, so it must come before the expensive stages.
 */

import { markRediscovery, readCandidatesForTriage, readCandidatesForVerification, readKnownVulns, readPipelineSummary } from './persist'
import { findRediscovery } from './rediscovery'
import { runTriage } from './triage'
import { runVerification } from './verify'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { PipelineProgramContext } from './program-context'
import type { KnownVulnRecord } from './rediscovery'
import type { PipelineSummary } from './persist'
import type { CandidateRecord, ModelInvoker } from './types'
import type { RunTriageResult } from './triage'
import type { RunVerificationResult } from './verify'

/**
 * The whole pipeline's serializable request (§20.17.3).
 *
 * This is the composite stage, so its request is the union of what the three
 * stages it drives need — deliberately flat rather than `{ triage: TriageRequest,
 * verify: VerificationRequest }`, because `runPipeline` threads one set of flags
 * (`--no-cache`, `--no-enrich`) across both and splitting them would invent two
 * places for one CLI option to be wrong.
 */
export interface PipelineRequest {
  runId: string
  targetId: string
  candidates: readonly CandidateRecord[]
  cacheDisabled?: boolean
  enrich?: boolean
}

/** What the pipeline needs from the host — none of it serializable. */
export interface PipelineServices {
  db: Database
  invoker: ModelInvoker
  programContext?: PipelineProgramContext | undefined
  governor?: BudgetGovernor | undefined
  /**
   * Optional §4.2 lookup-3 refresh: re-query the commit so advisories published
   * after the OSV stage are present. OSV has no path or symbol query, so this is
   * the only part of "re-query OSV" the API can actually do; the matching itself
   * is the pure function in `./rediscovery`.
   */
  refreshKnownVulns?: (() => Promise<KnownVulnRecord[]>) | undefined
  log?: (line: string) => void
  now?: () => number
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type RunPipelineOptions = PipelineRequest & PipelineServices

export interface RunPipelineResult {
  rediscovery: number
  triage: RunTriageResult
  verification: RunVerificationResult
  summary: PipelineSummary
  warnings: string[]
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
}

const mergeKnownVulns = (
  base: readonly KnownVulnRecord[],
  extra: readonly KnownVulnRecord[],
): KnownVulnRecord[] => {
  const byId = new Map<string, KnownVulnRecord>()
  for (const record of [...base, ...extra]) byId.set(record.vulnId, record)
  return [...byId.values()]
}

/** What the §4.2 rediscovery check is asked to judge — all of it JSON. */
export interface RediscoveryCheckRequest {
  targetId: string
  candidates: readonly CandidateRecord[]
}

/** What the rediscovery check needs from the host — none of it serializable. */
export interface RediscoveryCheckServices {
  db: Database
  programContext?: PipelineProgramContext | undefined
  refreshKnownVulns?: (() => Promise<KnownVulnRecord[]>) | undefined
  log?: (line: string) => void
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type RunRediscoveryCheckOptions = RediscoveryCheckRequest & RediscoveryCheckServices

export interface RediscoveryCheckResult {
  /** Candidates routed away from verification. */
  count: number
  warnings: string[]
}

/**
 * §4.2 lookup 3.
 *
 * Extracted so `scan` can run it as the free pre-pass of its triage stage
 * without going through `runPipeline`, which would collapse triage and
 * verification into one indivisible step and make a resumed scan unable to stop
 * between them. Behaviour here is unchanged from when it lived inside
 * `runPipeline`.
 */
export const runRediscoveryCheck = async (
  options: RunRediscoveryCheckOptions,
): Promise<RediscoveryCheckResult> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []

  let knownVulns = readKnownVulns(options.db, options.targetId)
  if (options.refreshKnownVulns) {
    try {
      const refreshed = await options.refreshKnownVulns()
      knownVulns = mergeKnownVulns(knownVulns, refreshed)
      log(`[pipeline] refreshed known vulnerabilities: ${refreshed.length} record(s)`)
    } catch (error) {
      // A refresh failure must not stop the check: the recorded set is still
      // usable, and the failure is surfaced rather than swallowed.
      warnings.push(
        `OSV refresh for rediscovery failed (${
          error instanceof Error ? error.message : String(error)
        }); matching against the previously recorded set only.`,
      )
    }
  }

  let count = 0
  for (const candidate of options.candidates) {
    if (candidate.triage !== null || candidate.state === 'rediscovery') continue

    const normalized = candidate.normalizedJson
    let snippet: string | null = null
    try {
      const parsed: unknown = JSON.parse(normalized)
      if (parsed && typeof parsed === 'object') {
        const value = (parsed as { snippet?: unknown }).snippet
        if (typeof value === 'string') snippet = value
      }
    } catch {
      snippet = null
    }

    const range =
      options.programContext && candidate.filePath && candidate.startLine !== null
        ? options.programContext.enclosingFunction(candidate.filePath, candidate.startLine)
        : null

    const symbols = options.programContext
      ? options.programContext.symbolsFor({
          filePath: candidate.filePath,
          range,
          snippet,
        })
      : []

    const match = findRediscovery({
      filePath: candidate.filePath,
      cwe: candidate.cwe,
      symbols,
      records: knownVulns,
    })

    if (match) {
      markRediscovery(options.db, candidate.id, match)
      count += 1
      log(
        `[pipeline] ${candidate.filePath ?? candidate.id}: ${match.basis} -> rediscovery, not verified`,
      )
    }
  }

  if (count > 0) {
    log(`[pipeline] ${count} candidate(s) routed to reporting as rediscovery`)
  }

  return { count, warnings }
}

export const runPipeline = async (
  options: RunPipelineOptions,
): Promise<RunPipelineResult> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []

  // --- §4.2 lookup 3: rediscovery, before any model budget is spent ---
  const rediscoveryCheck = await runRediscoveryCheck({
    db: options.db,
    targetId: options.targetId,
    candidates: options.candidates,
    programContext: options.programContext,
    refreshKnownVulns: options.refreshKnownVulns,
    log,
  })
  const rediscovery = rediscoveryCheck.count
  warnings.push(...rediscoveryCheck.warnings)

  // --- §4.6 triage ---
  const triageCandidates = readCandidatesForTriage(options.db, options.runId)
  const triage = await runTriage({
    db: options.db,
    runId: options.runId,
    candidates: triageCandidates,
    invoker: options.invoker,
    programContext: options.programContext,
    governor: options.governor,
    cacheDisabled: options.cacheDisabled,
    enrich: options.enrich,
    log,
    now: options.now,
  })

  // --- §5.2 verification ---
  // An abort stops the pipeline; a degrade skips only this stage's remainder and
  // the pipeline continues (§9.1), so verification still runs over whatever
  // triage managed to label.
  let verification: RunVerificationResult = {
    verified: 0,
    byDisposition: { 'likely-real': 0, dropped: 0, escalated: 0 },
    cached: 0,
    failed: 0,
    escapedLines: 0,
    stoppedBy: null,
    warnings: [],
  }

  if (triage.stoppedBy === 'budget-abort') {
    warnings.push(
      'Triage aborted at the budget governor; verification did not run.',
    )
  } else {
    verification = await runVerification({
      db: options.db,
      runId: options.runId,
      candidates: readCandidatesForVerification(options.db, options.runId),
      invoker: options.invoker,
      programContext: options.programContext,
      governor: options.governor,
      cacheDisabled: options.cacheDisabled,
      log,
      now: options.now,
    })
  }

  return {
    rediscovery,
    triage,
    verification,
    summary: readPipelineSummary(options.db, options.runId),
    warnings: [...warnings, ...triage.warnings, ...verification.warnings],
    stoppedBy: verification.stoppedBy ?? triage.stoppedBy,
  }
}
