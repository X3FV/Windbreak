/**
 * Cross-model verification (spec §5.2) and the disagreement policy (§5.3).
 *
 * Proposer argues the finding is real; Refuter tries to kill it. They run on
 * different providers and neither self-report is trusted, so only their
 * *agreement* produces an automatic outcome. Disagreement is not resolved by a
 * third model — §5.2/D6 makes the tiebreak a human, because a third model adds
 * one more blind spot and spends the recall the MVP bar needs.
 *
 * §5.1 rule 4 is enforced structurally here: the evidence bundle is built and
 * rendered **once**, and the identical `evidence.text` is interpolated into both
 * prompts. The two roles differ only in their task text, so their disagreement
 * cannot be an artefact of framing.
 */

import { createStageBudget, describeStopped } from './budget'
import {
  buildEvidenceBundle,
  describeCandidateProvenance,
  renderEvidence,
  PROMPT_TEMPLATE_VERSION,
} from './context'
import {
  enqueueAdjudication,
  parseNormalized,
  setCandidateState,
} from './persist'
import { buildRoleSystemPrompt, buildUserPrompt, VERIFICATION_OUTPUT_SPEC } from './prompt'
import { invokeCached } from './step'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { BudgetGate } from './budget'
import type { PipelineProgramContext } from './program-context'
import type {
  CandidateRecord,
  Disposition,
  ModelInvoker,
} from './types'

export const VERIFICATION_TIMEOUT_MS = 300_000
export const MIN_VERIFICATION_MS = 10_000

/**
 * What verification is being asked to judge — all of it JSON (§20.17.3).
 *
 * Note what is *not* here: the evidence bundle. §5.1 rule 4 requires both roles
 * to see the identical bundle, and it is built from `candidates` inside the
 * stage so that a transport cannot deliver two different ones to the two roles.
 */
export interface VerificationRequest {
  runId: string
  candidates: readonly CandidateRecord[]
  cacheDisabled?: boolean
}

/** What verification needs from the host to answer — none of it serializable. */
export interface VerificationServices {
  db: Database
  invoker: ModelInvoker
  programContext?: PipelineProgramContext | undefined
  governor?: BudgetGovernor | undefined
  log?: (line: string) => void
  now?: () => number
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type RunVerificationOptions = VerificationRequest & VerificationServices

export interface RunVerificationResult {
  verified: number
  byDisposition: Record<Disposition, number>
  cached: number
  failed: number
  escapedLines: number
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
  warnings: string[]
}

const emptyDispositions = (): Record<Disposition, number> => ({
  'likely-real': 0,
  dropped: 0,
  escalated: 0,
})

export const runVerification = async (
  options: RunVerificationOptions,
): Promise<RunVerificationResult> => {
  const log = options.log ?? (() => {})
  const budget = createStageBudget('verification', options.governor)

  const proposerSystem = buildRoleSystemPrompt('proposer')
  const refuterSystem = buildRoleSystemPrompt('refuter')

  const byDisposition = emptyDispositions()
  const warnings: string[] = []
  let verified = 0
  let cached = 0
  let failed = 0
  let escapedLines = 0
  let stoppedBy: RunVerificationResult['stoppedBy'] = null

  for (let index = 0; index < options.candidates.length; index += 1) {
    const candidate = options.candidates[index]!

    const gate: BudgetGate = await budget.gate(MIN_VERIFICATION_MS)
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
        `${candidate.id}: evidence bundle is unreadable; not verified rather than assumed benign.`,
      )
      continue
    }

    // Built once, rendered once, used verbatim by both roles (§5.1 rule 4).
    const evidence = renderEvidence(
      buildEvidenceBundle({
        filePath: candidate.filePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        language: options.programContext?.languageFor(candidate.filePath) ?? null,
        normalized,
        programContext: options.programContext,
        enrich: true,
      }),
    )
    escapedLines += evidence.escapedLines

    const provenance = describeCandidateProvenance({
      source: candidate.source,
      patternId: candidate.patternId,
      cwe: candidate.cwe,
      ruleMessage: normalized.message ?? null,
    })

    setCandidateState(options.db, candidate.id, 'verifying')

    const ask = async (role: 'proposer' | 'refuter') =>
      invokeCached({
        db: options.db,
        candidateId: candidate.id,
        stage: 'verification',
        role,
        normalizedJson: candidate.normalizedJson,
        escapedInput: evidence.text,
        systemPrompt: role === 'proposer' ? proposerSystem : refuterSystem,
        userPrompt: buildUserPrompt({ role, provenance, evidence }),
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        timeoutMs: VERIFICATION_TIMEOUT_MS,
        invoker: options.invoker,
        output: VERIFICATION_OUTPUT_SPEC,
        ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
        ...(options.now ? { now: options.now } : {}),
      })

    const proposer = await ask('proposer')
    const refuter = await ask('refuter')

    if (proposer.cached) cached += 1
    if (refuter.cached) cached += 1

    if (!proposer.ok || !proposer.value || !refuter.ok || !refuter.value) {
      failed += 1
      // Revert: 'verifying' would claim work is still in flight.
      setCandidateState(options.db, candidate.id, 'triaged')
      const reasons = [proposer.error, refuter.error].filter(Boolean).join('; ')
      warnings.push(
        `${candidate.id}: verification incomplete (${reasons || 'no output'}); left triaged, not treated as benign.`,
      )
      continue
    }

    const proposerReal = proposer.value.verdict === 'real'
    const refuterReal = refuter.value.verdict === 'real'

    let disposition: Disposition
    if (proposerReal && refuterReal) {
      disposition = 'likely-real'
      setCandidateState(options.db, candidate.id, 'confirmed')
    } else if (!proposerReal && !refuterReal) {
      disposition = 'dropped'
      setCandidateState(options.db, candidate.id, 'dropped')
    } else {
      disposition = 'escalated'
      setCandidateState(options.db, candidate.id, 'escalated')
      enqueueAdjudication({
        db: options.db,
        candidateId: candidate.id,
        runId: options.runId,
        proposerVerdictId: proposer.verdictId!,
        refuterVerdictId: refuter.verdictId!,
      })
    }

    byDisposition[disposition] += 1
    verified += 1

    log(
      `[verify] ${candidate.filePath ?? candidate.id}:${candidate.startLine ?? '?'} ` +
        `proposer=${proposerReal ? 'real' : 'benign'} refuter=${refuterReal ? 'real' : 'benign'} -> ${disposition}`,
    )
  }

  return {
    verified,
    byDisposition,
    cached,
    failed,
    escapedLines,
    stoppedBy,
    warnings,
  }
}
