/**
 * Verdict cache (spec §8.4).
 *
 * Determinism is an MVP gate (§2.1.3): re-running the same target with the same
 * config must reproduce identical stage outputs. Because the agent call path
 * can pin a model but not a seed, the cache — not the provider — is what makes
 * that true. A cache hit replays the recorded output.
 */

import { createHash } from 'crypto'

import type { Database } from 'bun:sqlite'
import type { ModelRole } from '../models'

export interface VerdictCacheKeyInput {
  /** The candidate's `normalized_json`, verbatim. */
  normalizedJson: string
  promptTemplateVersion: string
  /** The escaped evidence the role was shown, verbatim. */
  escapedInput: string
  modelId: string
  temperature: number
  seed: number | null
  role: ModelRole
}

/**
 * §8.4's key, plus the role.
 *
 * Adding `role` is not optional. The default config runs triage and the Refuter
 * on the *same* model (`z-ai/glm-5.3-flash`) over the *same* escaped evidence, so
 * §8.4's literal key — normalized candidate + template version + escaped input +
 * model + temperature + seed — is identical for both. Without the role the
 * Refuter would replay the triage label as its own verdict. That would at best
 * fail schema validation, and at worst hand a refutation the answer it was
 * supposed to challenge, which is precisely the §5.2 "no self-report" property
 * the cross-model gate exists to provide.
 */
export const verdictCacheKey = (input: VerdictCacheKeyInput): string =>
  `vc_${createHash('sha256')
    .update(
      JSON.stringify([
        input.normalizedJson,
        input.promptTemplateVersion,
        input.role,
        input.escapedInput,
        input.modelId,
        input.temperature,
        input.seed,
      ]),
    )
    .digest('hex')
    .slice(0, 40)}`

export interface CachedVerdict {
  output: unknown
  modelId: string
  provider: string
  promptTemplateVersion: string
}

export const readVerdictCache = (
  db: Database,
  cacheKey: string,
): CachedVerdict | null => {
  const row = db
    .query<
      {
        output_json: string
        model_id: string
        provider: string
        prompt_template_version: string
      },
      [string]
    >(
      `SELECT output_json, model_id, provider, prompt_template_version
         FROM verdict_cache WHERE cache_key = ?`,
    )
    .get(cacheKey)

  if (!row) return null

  try {
    return {
      output: JSON.parse(row.output_json) as unknown,
      modelId: row.model_id,
      provider: row.provider,
      promptTemplateVersion: row.prompt_template_version,
    }
  } catch {
    // An unreadable cache row must not become a silent miss that looks like a
    // fresh call either; treat it as absent and let the caller re-invoke.
    return null
  }
}

export const writeVerdictCache = (
  db: Database,
  input: {
    cacheKey: string
    role: ModelRole
    modelId: string
    provider: string
    promptTemplateVersion: string
    output: unknown
    now?: () => number
  },
): void => {
  db.prepare(
    `INSERT OR REPLACE INTO verdict_cache
       (cache_key, role, model_id, provider, prompt_template_version, output_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.cacheKey,
    input.role,
    input.modelId,
    input.provider,
    input.promptTemplateVersion,
    JSON.stringify(input.output),
    new Date((input.now ?? Date.now)()).toISOString(),
  )
}
