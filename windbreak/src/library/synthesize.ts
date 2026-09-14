/**
 * Checker synthesis — one cached model call (spec §10, §4.4.2, §8.4).
 *
 * The call goes through `invokeCached`, the same path triage and verification
 * use, so the pattern library inherits §8.4's cache key, the `verdicts` audit
 * row, and `seedSupported: false` rather than inventing a second, slightly
 * different way of asking a model a question. Re-adding the same pattern with
 * the same model therefore replays the recorded fingerprint instead of paying
 * for a fresh one.
 *
 * Synthesis failing is not a finding. It returns `ok: false` and stores nothing,
 * because a pattern that was never validated must not enter a library whose
 * entire purpose is to be trusted at cross-target scale.
 */

import {
  buildEvidenceBundle,
  describeCandidateProvenance,
  invokeCached,
  renderEvidence,
} from '../pipeline'
import { toFingerprint } from './fingerprint'
import {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  CHECKER_PROMPT_TEMPLATE_VERSION,
  CHECKER_SYNTH_OUTPUT_SPEC,
} from './prompt'

import type { Database } from 'bun:sqlite'
import type { NormalizedCandidate } from '../engines/types'
import type {
  CandidateRecord,
  ModelIdentity,
  ModelInvoker,
  PipelineProgramContext,
} from '../pipeline'
import type { Fingerprint } from './types'

/** One call, so a hung provider cannot stall an interactive command. */
export const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000

export interface SynthesizePatternInput {
  db: Database
  candidate: CandidateRecord
  /** The target the candidate came from, for the program-model lookups. */
  targetId: string
  programContext: PipelineProgramContext
  invoker: ModelInvoker
  cacheDisabled?: boolean
  timeoutMs?: number
  now?: () => number
}

export interface SynthesizePatternResult {
  ok: boolean
  /** Validated, but not yet checked against the origin site — see `capture.ts`. */
  fingerprint: Fingerprint | null
  cached: boolean
  error: string | null
  identity: ModelIdentity
}

/** `normalized_json` is model-adjacent data; a malformed row degrades to null. */
export const parseNormalized = (json: string): NormalizedCandidate | null => {
  try {
    const value = JSON.parse(json) as unknown
    if (typeof value !== 'object' || value === null) return null
    return value as NormalizedCandidate
  } catch {
    return null
  }
}

export const synthesizePattern = async (
  input: SynthesizePatternInput,
): Promise<SynthesizePatternResult> => {
  const { candidate } = input
  const normalized = parseNormalized(candidate.normalizedJson)

  // §5.1: the same escaped, fenced bundle the pipeline roles see. The synthesis
  // role is not exempt from the trust boundary.
  const bundle = buildEvidenceBundle({
    filePath: candidate.filePath,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    language: input.programContext.languageFor(candidate.filePath),
    normalized,
    programContext: input.programContext,
  })
  const evidence = renderEvidence(bundle)

  const enclosing =
    candidate.filePath && candidate.startLine !== null
      ? input.programContext.enclosingFunction(candidate.filePath, candidate.startLine)
      : null

  // The vocabulary the matcher can actually see, so the model does not name a
  // call that exists only in its imagination of the code.
  const observedCalls = input.programContext.symbolsFor({
    filePath: candidate.filePath,
    range: enclosing
      ? { startLine: enclosing.startLine, endLine: enclosing.endLine }
      : null,
    snippet: bundle.snippet,
  })

  const provenance = describeCandidateProvenance({
    source: candidate.source,
    patternId: candidate.patternId,
    cwe: candidate.cwe,
    ruleMessage: normalized?.message ?? null,
  })

  const result = await invokeCached({
    db: input.db,
    candidateId: candidate.id,
    stage: 'synthesis',
    role: 'checker-synth',
    normalizedJson: candidate.normalizedJson,
    escapedInput: evidence.text,
    systemPrompt: buildSynthesisSystemPrompt(),
    userPrompt: buildSynthesisUserPrompt({
      provenance,
      evidence: evidence.text,
      observedCalls,
      originSite: {
        filePath: candidate.filePath ?? '(unknown)',
        functionName: enclosing?.name ?? null,
      },
    }),
    promptTemplateVersion: CHECKER_PROMPT_TEMPLATE_VERSION,
    timeoutMs: input.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS,
    invoker: input.invoker,
    output: CHECKER_SYNTH_OUTPUT_SPEC,
    ...(input.cacheDisabled ? { cacheDisabled: true } : {}),
    ...(input.now ? { now: input.now } : {}),
  })

  if (!result.ok || result.value === null) {
    return {
      ok: false,
      fingerprint: null,
      cached: result.cached,
      error: result.error ?? 'synthesis produced no output',
      identity: result.identity,
    }
  }

  // The output schema already enforced the predicate rules; this adds the
  // discriminator and re-validates against the stored form, so nothing reaches
  // the library that the matcher would refuse to load later.
  try {
    return {
      ok: true,
      fingerprint: toFingerprint(result.value),
      cached: result.cached,
      error: null,
      identity: result.identity,
    }
  } catch (error) {
    return {
      ok: false,
      fingerprint: null,
      cached: result.cached,
      error: error instanceof Error ? error.message : String(error),
      identity: result.identity,
    }
  }
}
