import { z } from 'zod'

/**
 * §8.1's three rows. These are the roles whose prompts live in `pipeline/` and
 * whose subjects are one candidate. Kept separate from `MODEL_ROLES` so a role
 * that does not fit that mould cannot be added to the wrong prompt table.
 */
export const PIPELINE_ROLES = ['triage', 'proposer', 'refuter'] as const
export type PipelineRole = (typeof PIPELINE_ROLES)[number]

/**
 * `checker-synth` is not one of §8.1's original rows: §10's pattern library
 * needs a role that turns a confirmed finding into a reusable pattern, and
 * inventing an unnamed model call would be worse than naming the row. Recorded
 * as a spec extension in §20.12.
 */
export const MODEL_ROLES = [...PIPELINE_ROLES, 'checker-synth'] as const
export type ModelRole = (typeof MODEL_ROLES)[number]

/**
 * §20.29's investigator — a configurable model row that is deliberately **not** a
 * `ModelRole`.
 *
 * The distinction is the invariant and not a naming preference. `ModelRole` is the set
 * of roles whose answers are cache-backed structured verdicts: `invokeCached`,
 * `insertVerdict`, `verdictId` and `verdict_cache` all take one, and `verdicts.role` is
 * written from it. Widening that union by one member is how an investigator turn would
 * end up as a `verdicts` row — which is precisely what §20.29.3 forbids, because
 * `runVerification`'s disposition must never count a better-informed third opinion. So
 * the investigator is configurable and recordable, and cannot be handed to the verdict
 * path at compile time.
 */
export const INVESTIGATOR_ROLE = 'investigator' as const
export type InvestigatorRole = typeof INVESTIGATOR_ROLE

/**
 * Every row a config file may set: the verdict roles plus the investigator.
 *
 * This is the union the *config* is validated against. It is wider than `ModelRole` on
 * purpose, and the direction matters — `CONFIGURABLE_ROLES` may grow, `ModelRole` must
 * not, because everything downstream of `ModelRole` writes verdicts.
 */
export const CONFIGURABLE_ROLES = [...MODEL_ROLES, INVESTIGATOR_ROLE] as const
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number]

/**
 * Models that cost no daily Freebuff *session*.
 *
 * The list is still the one to prefer, and the reason has changed (§20.41). A scan does
 * not consume a session because a scan does not get one: Windbreak is not the freebuff CLI,
 * so its calls are metered and bill the account's credits whatever is on this list. What
 * the list still buys is the cheapest per-token model that can do the work, and what it no
 * longer claims is that the work is free.
 *
 * `deepseek/deepseek-v4-pro` is deliberately absent: it was retired from the
 * catalog. DeepSeek V4.1 Flash replaces it here.
 */
export const UNMETERED_MODEL_IDS = [
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash',
] as const

export const GLM_53_FLASH_MODEL_ID = 'z-ai/glm-5.3-flash'
export const DEEPSEEK_V4_1_FLASH_MODEL_ID = 'deepseek/deepseek-v4-flash'

/**
 * Vendor is the first segment of a model id (`z-ai/glm-5.3-flash` -> `z-ai`).
 * Used for the cross-provider gate, so it must stay a pure function of the id
 * rather than a separately-declared field that could drift from it.
 */
export const modelVendor = (modelId: string): string => {
  const [vendor] = modelId.split('/')
  return vendor && vendor.length > 0 ? vendor : modelId
}

export const modelRoleSchema = z.object({
  model: z.string().min(1),
  /** Pinned to 0 for reproducible verdicts; the cache key includes it. */
  temperature: z.number().min(0).max(2).default(0),
  /** Sent where the provider supports it; recorded as unsupported otherwise. */
  seed: z.number().int().optional(),
})

export type ModelRoleConfig = z.infer<typeof modelRoleSchema>

export interface ModelConfig {
  triage: ModelRoleConfig
  proposer: ModelRoleConfig
  refuter: ModelRoleConfig
  'checker-synth': ModelRoleConfig
  /** §20.29. Not a `ModelRole`; see `INVESTIGATOR_ROLE`. */
  investigator: ModelRoleConfig
}

/**
 * The file schema is wider than the resolved config on purpose.
 *
 * `checker-synth` is optional in a config file and defaults, so a config written
 * before the pattern library existed keeps working — the same rule the `budget`
 * and `engines` sections follow. The transform is what makes the parsed value a
 * complete `ModelConfig`, so no caller has to handle a half-populated role table.
 */
export const modelConfigSchema = z
  .object({
    triage: modelRoleSchema,
    proposer: modelRoleSchema,
    refuter: modelRoleSchema,
    'checker-synth': modelRoleSchema.optional(),
    investigator: modelRoleSchema.optional(),
  })
  .transform(
    (raw): ModelConfig => ({
      triage: raw.triage,
      proposer: raw.proposer,
      refuter: raw.refuter,
      'checker-synth': raw['checker-synth'] ?? DEFAULT_MODEL_CONFIG['checker-synth'],
      investigator: raw.investigator ?? DEFAULT_MODEL_CONFIG.investigator,
    }),
  )

/**
 * Per the spec: Proposer argues the finding is real, Refuter tries to kill it,
 * and they must be different vendors so a shared blind spot cannot pass both
 * gates. Triage is unconstrained because it only filters noise.
 */
export interface ModelConfigViolation {
  role: ConfigurableRole | 'config'
  message: string
}

export const validateModelConfig = (
  config: ModelConfig,
): ModelConfigViolation[] => {
  const violations: ModelConfigViolation[] = []

  const proposerVendor = modelVendor(config.proposer.model)
  const refuterVendor = modelVendor(config.refuter.model)

  if (proposerVendor === refuterVendor) {
    violations.push({
      role: 'config',
      message:
        `proposer and refuter must use different providers, but both resolve to ` +
        `"${proposerVendor}" (${config.proposer.model} vs ${config.refuter.model}). ` +
        `Cross-model gating is the point of this stage, so this configuration is refused.`,
    })
  }

  // Over `CONFIGURABLE_ROLES`, not `MODEL_ROLES`: a vendor-less model id is wrong for
  // the investigator too, and a config row that is validated by nobody is a row whose
  // mistakes surface as a provider error at call time instead of at `config validate`.
  for (const role of CONFIGURABLE_ROLES) {
    const { model } = config[role]
    if (modelVendor(model) === model) {
      violations.push({
        role,
        message: `model "${model}" has no vendor prefix; expected "<vendor>/<model>"`,
      })
    }
  }

  return violations
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  triage: { model: GLM_53_FLASH_MODEL_ID, temperature: 0, seed: 42 },
  proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID, temperature: 0, seed: 42 },
  refuter: { model: GLM_53_FLASH_MODEL_ID, temperature: 0, seed: 42 },
  // Synthesis generalizes a confirmed finding into a pattern, which is
  // reasoning over code rather than classifying it, so it gets the stronger of
  // the two unmetered models. §5.2's cross-provider gate is proposer/refuter
  // only, so sharing DeepSeek here does not weaken it.
  'checker-synth': { model: DEEPSEEK_V4_1_FLASH_MODEL_ID, temperature: 0, seed: 42 },
  // §20.29's investigator. The stronger unmetered model for the same reason as
  // `checker-synth`: investigating is reasoning over a codebase across several steps
  // rather than classifying one snippet. It cannot vote in §5.2's gate — it is not a
  // `ModelRole` — so sharing DeepSeek with the Proposer does not weaken it.
  investigator: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID, temperature: 0, seed: 42 },
}

/**
 * Parse and validate a model config, throwing on the first structural problem.
 * Semantic violations are returned by `validateModelConfig` so callers can
 * choose between refusing and warning.
 */
export const parseModelConfig = (input: unknown): ModelConfig =>
  modelConfigSchema.parse(input)
