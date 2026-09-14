/**
 * Candidate pipeline types (spec §4.6 triage, §5.2 cross-model verification).
 *
 * This stage is the first one that sends target text to a model, so it is also
 * where §5 becomes real: every role sees the same escaped evidence bundle, and
 * no model's self-report is trusted on its own.
 */

import type { z } from 'zod'

import type { ModelRole } from '../models'
import type { InjectionSignal } from '../trust/injection'

/** §4.6. Deliberately not a confidence score: numbers from a cheap model are not calibrated. */
export const TRIAGE_LABELS = ['likely-real', 'likely-noise', 'needs-context'] as const
export type TriageLabel = (typeof TRIAGE_LABELS)[number]

/** §5.2. Both roles answer one binary question, so disagreement is meaningful. */
export const VERIFICATION_VERDICTS = ['real', 'benign'] as const
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number]

/**
 * `synthesis` is the pattern library's one call (§10, §20.12). It lives in this
 * union rather than getting its own cache because a synthesized pattern must be
 * cached and recorded exactly like a verdict: same key derivation, same
 * replayability, same failure semantics.
 */
export type PipelineStage = 'triage' | 'verification' | 'synthesis'

/**
 * §5.3 dispositions. These map onto `candidates.state` as: likely-real ->
 * `confirmed`, dropped -> `dropped`, escalated -> `escalated`. The evidence
 * tier that separates "statically verified" from "human reproduced" is recorded
 * with the finding (§13.2), not in the state.
 */
export type Disposition = 'likely-real' | 'dropped' | 'escalated'

/**
 * A structured-output contract for one role.
 *
 * The JSON Schema is hand-written rather than derived: the three shapes are
 * tiny and fixed, and deriving it would add a dependency for no gain. The zod
 * schema is the authority on what came back — a model that returns a plausible
 * object with the wrong shape is a failure, not a result.
 */
export interface StructuredOutputSpec<T> {
  name: string
  jsonSchema: Record<string, unknown>
  schema: z.ZodType<T>
}

export interface ModelInvocation {
  role: ModelRole
  systemPrompt: string
  userPrompt: string
  promptTemplateVersion: string
  /**
   * Wall-clock ceiling for this single call. The budget governor's unit is the
   * stage, so without a per-call ceiling one hung provider request would consume
   * the whole stage before the governor ever saw a chance to ask.
   */
  timeoutMs: number
}

export interface ModelIdentity {
  modelId: string
  provider: string
  temperature: number
  seed: number | null
  /**
   * False on the agent path. `AgentDefinition` exposes no seed and the SDK sets
   * no temperature, so §8.4's "temperature 0 + seed per provider" cannot be
   * asserted there. Recorded on every verdict so eval metrics can flag runs
   * where reproducibility rests on the cache alone (spec §18).
   */
  seedSupported: boolean
}

export type InvokeOutcome<T> =
  | ({ ok: true; value: T } & ModelIdentity)
  | ({ ok: false; error: string } & ModelIdentity)

/**
 * The single seam between the pipeline and model routing.
 *
 * Every stage depends on this interface, never on the SDK, so the pipeline is
 * testable without a provider and swapping the call surface later is one file.
 */
export interface ModelInvoker {
  /** The identity a role will report, available before any call is made. */
  identity(role: ModelRole): ModelIdentity
  invoke<T>(
    request: ModelInvocation,
    output: StructuredOutputSpec<T>,
  ): Promise<InvokeOutcome<T>>
}

/** A call site as the program model recorded it, used for §4.6 enrichment. */
export interface CallSite {
  name: string
  filePath: string
  line: number
}

/**
 * Everything a role is allowed to see about one candidate.
 *
 * §5.1 rule 4: triage and both verification roles receive byte-identical input,
 * so a disagreement is about reasoning rather than about framing. This is why
 * the bundle is built once and rendered once, rather than assembled per role.
 */
export interface EvidenceBundle {
  filePath: string
  startLine: number
  endLine: number | null
  language: string | null
  snippet: string | null
  /** Enclosing function, resolved from the program model — never from a comment. */
  enclosingFunction: string | null
  /** Callers of the enclosing function, from the symbol index. */
  callers: CallSite[]
  injectionSignals: InjectionSignal[]
}

export interface TriageVerdictValue {
  label: TriageLabel
  rationale: string
  /** True when the label came from a second call with an enriched bundle. */
  enriched: boolean
}

export interface VerificationVerdictValue {
  verdict: VerificationVerdict
  reasoning: string
  /** Preconditions the role claims must hold for the finding to be real. */
  preconditions: string[]
}

export interface CandidateRecord {
  id: string
  runId: string
  targetId: string
  source: string
  patternId: string | null
  originPatchSha: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  cwe: string | null
  normalizedJson: string
  injectionSignals: string[]
  state: string
  triage: TriageLabel | null
}
