/**
 * Triage (spec §4.6).
 *
 * One call per candidate through the cheapest capable model. The purpose is
 * speed and signal, not spend: §4.6 budgets it at 10% and explicitly forbids a
 * confidence score, so the output is one of three labels.
 *
 * `needs-context` gets exactly **one** enrichment attempt (§4.6): the same
 * candidate is re-asked with its enclosing function and callers added from the
 * symbol index. If the second pass still cannot decide, the candidate is still
 * forwarded to verification — §4.6's own words are that the label means the
 * prompt lacked context, not that the candidate is weak, and the MVP bar is
 * recall.
 */

import { createStageBudget, describeStopped } from './budget'
import { buildEvidenceBundle, describeCandidateProvenance, renderEvidence, PROMPT_TEMPLATE_VERSION } from './context'
import { parseNormalized, setCandidateTriage } from './persist'
import { buildRoleSystemPrompt, buildUserPrompt, TRIAGE_OUTPUT_SPEC } from './prompt'
import { invokeCached } from './step'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { PipelineProgramContext } from './program-context'
import type { BudgetGate } from './budget'
import type { CandidateRecord, ModelInvoker, TriageLabel } from './types'

/** Per-call ceiling. A cheap tier answer that takes longer than this is not useful. */
export const TRIAGE_TIMEOUT_MS = 120_000
/** Below this much remaining quota, triage stops rather than starting a call. */
export const MIN_TRIAGE_MS = 5_000

/**
 * What triage is being asked to judge — all of it JSON, none of it host state
 * (§20.17.3). This is the half that would cross a worker boundary.
 */
export interface TriageRequest {
  runId: string
  candidates: readonly CandidateRecord[]
  /** §8.4 `--no-cache`: force fresh calls. */
  cacheDisabled?: boolean
  /** Disable the second pass; used by tests and by `--no-enrich`. */
  enrich?: boolean
}

/**
 * What triage needs from the host to answer — none of it serializable.
 *
 * A worker cannot carry these across a pipe, so a transport must re-inject them
 * on the far side. That is the whole reason this half is named separately.
 */
export interface TriageServices {
  db: Database
  invoker: ModelInvoker
  programContext?: PipelineProgramContext | undefined
  governor?: BudgetGovernor | undefined
  log?: (line: string) => void
  now?: () => number
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type RunTriageOptions = TriageRequest & TriageServices

export interface TriageLabelCounts {
  'likely-real': number
  'likely-noise': number
  'needs-context': number
}

export interface RunTriageResult {
  processed: number
  byLabel: TriageLabelCounts
  /** Candidates the second pass was run for. */
  enriched: number
  /** Answers served from `verdict_cache`. */
  cached: number
  /** Calls that failed; these candidates keep `triage = NULL`. */
  failed: number
  /** Total instruction-like lines neutralized across all prompts. */
  escapedLines: number
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
  warnings: string[]
}

const emptyCounts = (): TriageLabelCounts => ({
  'likely-real': 0,
  'likely-noise': 0,
  'needs-context': 0,
})

export const runTriage = async (options: RunTriageOptions): Promise<RunTriageResult> => {
  const log = options.log ?? (() => {})
  const enrich = options.enrich ?? true
  const budget = createStageBudget('triage', options.governor)
  const systemPrompt = buildRoleSystemPrompt('triage')

  const byLabel = emptyCounts()
  const warnings: string[] = []
  let processed = 0
  let enriched = 0
  let cached = 0
  let failed = 0
  let escapedLines = 0
  let stoppedBy: RunTriageResult['stoppedBy'] = null

  for (let index = 0; index < options.candidates.length; index += 1) {
    const candidate = options.candidates[index]!

    const gate: BudgetGate = await budget.gate(MIN_TRIAGE_MS)
    if (gate !== 'ok') {
      stoppedBy = gate
      warnings.push(
        describeStopped(budget, gate, options.candidates.length - index),
      )
      break
    }

    const normalized = parseNormalized(candidate.normalizedJson)
    if (!normalized) {
      failed += 1
      warnings.push(
        `${candidate.id}: evidence bundle is unreadable; not triaged rather than assumed clean.`,
      )
      continue
    }

    const provenance = describeCandidateProvenance({
      source: candidate.source,
      patternId: candidate.patternId,
      cwe: candidate.cwe,
      ruleMessage: normalized.message ?? null,
    })

    const runPass = async (pass: 'base' | 'enriched') => {
      const bundle = buildEvidenceBundle({
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        language: options.programContext?.languageFor(candidate.filePath) ?? null,
        normalized,
        programContext: options.programContext,
        enrich: pass === 'enriched',
      })
      const evidence = renderEvidence(bundle)
      escapedLines += evidence.escapedLines

      const userPrompt = buildUserPrompt({ role: 'triage', provenance, evidence })

      return invokeCached({
        db: options.db,
        candidateId: candidate.id,
        stage: 'triage',
        role: 'triage',
        normalizedJson: candidate.normalizedJson,
        escapedInput: evidence.text,
        systemPrompt,
        userPrompt,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        timeoutMs: TRIAGE_TIMEOUT_MS,
        invoker: options.invoker,
        output: TRIAGE_OUTPUT_SPEC,
        ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    }

    let first = await runPass('base')
    if (!first.ok || !first.value) {
      failed += 1
      warnings.push(
        `${candidate.id}: triage failed (${first.error ?? 'no output'}); left untriaged.`,
      )
      continue
    }
    if (first.cached) cached += 1

    let label: TriageLabel = first.value.label
    let didEnrich = false

    if (label === 'needs-context' && enrich && options.programContext) {
      const second = await runPass('enriched')
      if (second.ok && second.value) {
        if (second.cached) cached += 1
        label = second.value.label
        didEnrich = true
        enriched += 1
      } else {
        // The enrichment call failing must not discard the first answer; the
        // candidate keeps `needs-context` and is still forwarded.
        warnings.push(
          `${candidate.id}: enrichment pass failed (${second.error ?? 'no output'}); keeping the first-pass label.`,
        )
      }
    }

    // The durable outcome is the column; the verdict rows keep the raw model
    // answers. `rationale` is visible there and in `windbreak review`.
    setCandidateTriage(options.db, candidate.id, label)
    byLabel[label] += 1
    processed += 1

    log(
      `[triage] ${candidate.filePath ?? candidate.id}:${candidate.startLine ?? '?'} ${label}` +
        `${didEnrich ? ' (enriched)' : ''}`,
    )
  }

  return {
    processed,
    byLabel,
    enriched,
    cached,
    failed,
    escapedLines,
    stoppedBy,
    warnings,
  }
}
