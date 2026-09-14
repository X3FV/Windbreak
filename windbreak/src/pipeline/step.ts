/**
 * One cached model call, with its verdict recorded (spec §8.4, §14.1).
 *
 * Triage and both verification roles all go through here so that the cache key,
 * the `verdicts` row, and the failure semantics cannot drift between them. In
 * particular, every path that does *not* produce a usable answer returns
 * `ok: false` and writes no verdict — a failed call never becomes a quiet
 * "no finding" (spec §18).
 */

import { readVerdictCache, verdictCacheKey, writeVerdictCache } from './cache'
import { insertVerdict } from './persist'

import type { Database } from 'bun:sqlite'
import type { ModelRole } from '../models'
import type {
  ModelIdentity,
  ModelInvoker,
  PipelineStage,
  StructuredOutputSpec,
} from './types'

export interface InvokeCachedInput<T> {
  db: Database
  candidateId: string
  stage: PipelineStage
  role: ModelRole
  /** The candidate's `normalized_json`, verbatim, for the cache key. */
  normalizedJson: string
  /** The escaped evidence the role is shown, verbatim, for the cache key. */
  escapedInput: string
  systemPrompt: string
  userPrompt: string
  promptTemplateVersion: string
  timeoutMs: number
  invoker: ModelInvoker
  output: StructuredOutputSpec<T>
  cacheDisabled?: boolean
  now?: () => number
}

export interface InvokeCachedResult<T> {
  ok: boolean
  value: T | null
  /** True when the answer came from `verdict_cache` rather than a call. */
  cached: boolean
  error: string | null
  cacheKey: string
  verdictId: string | null
  identity: ModelIdentity
}

export const invokeCached = async <T>(
  input: InvokeCachedInput<T>,
): Promise<InvokeCachedResult<T>> => {
  const identity = input.invoker.identity(input.role)

  const cacheKey = verdictCacheKey({
    normalizedJson: input.normalizedJson,
    promptTemplateVersion: input.promptTemplateVersion,
    escapedInput: input.escapedInput,
    modelId: identity.modelId,
    temperature: identity.temperature,
    seed: identity.seed,
    role: input.role,
  })

  if (!input.cacheDisabled) {
    const hit = readVerdictCache(input.db, cacheKey)
    if (hit) {
      const parsed = input.output.schema.safeParse(hit.output)
      if (parsed.success) {
        const verdictId = insertVerdict({
          db: input.db,
          candidateId: input.candidateId,
          stage: input.stage,
          role: input.role,
          identity,
          cacheKey,
          output: parsed.data,
          ...(input.now ? { now: input.now } : {}),
        })
        return {
          ok: true,
          value: parsed.data,
          cached: true,
          error: null,
          cacheKey,
          verdictId,
          identity,
        }
      }
      // A cached row that no longer satisfies its schema means the contract
      // changed under a stale key. Fall through and re-ask rather than return
      // something the schema rejects.
    }
  }

  const outcome = await input.invoker.invoke(
    {
      role: input.role,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      promptTemplateVersion: input.promptTemplateVersion,
      timeoutMs: input.timeoutMs,
    },
    input.output,
  )

  if (!outcome.ok) {
    return {
      ok: false,
      value: null,
      cached: false,
      error: outcome.error,
      cacheKey,
      verdictId: null,
      identity: outcome,
    }
  }

  writeVerdictCache(input.db, {
    cacheKey,
    role: input.role,
    modelId: outcome.modelId,
    provider: outcome.provider,
    promptTemplateVersion: input.promptTemplateVersion,
    output: outcome.value,
    ...(input.now ? { now: input.now } : {}),
  })

  const verdictId = insertVerdict({
    db: input.db,
    candidateId: input.candidateId,
    stage: input.stage,
    role: input.role,
    identity: outcome,
    cacheKey,
    output: outcome.value,
    ...(input.now ? { now: input.now } : {}),
  })

  return {
    ok: true,
    value: outcome.value,
    cached: false,
    error: null,
    cacheKey,
    verdictId,
    identity: outcome,
  }
}
