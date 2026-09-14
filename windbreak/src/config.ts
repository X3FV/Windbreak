import fs from 'fs'

import { z } from 'zod'

import { DEFAULT_TOTAL_BUDGET_SECONDS } from './budget'
import {
  DEFAULT_ENGINE_CAP_SECONDS,
  DEFAULT_SEMGREP_JOBS,
  DEFAULT_SEMGREP_TIMEOUT_SECONDS,
} from './engines'
import {
  DEFAULT_INVESTIGATOR_STEPS,
  DEFAULT_MAX_CONVERSATION_CALLS,
} from './investigate/limits'
import {
  DEFAULT_MODEL_CONFIG,
  modelConfigSchema,
  validateModelConfig,
} from './models'

import type { StageName } from './budget'
import type { ModelConfig, ModelConfigViolation } from './models'

export interface BudgetConfig {
  /** Total seconds for a target (spec §9: default one hour). */
  totalSeconds: number
  /** Per-stage share overrides; absent stages use §9's defaults. */
  shares: Partial<Record<StageName, number>>
}

export interface EnginesConfig {
  /**
   * Engines the stage requires. A configured-but-missing engine stops the
   * stage (spec §4.3): a silently thinner net is the §3 recall failure.
   */
  required: string[]
  /** Extra rule paths, appended to the committed `rules/` set. */
  rulePaths: string[]
  /** Per-engine wall-clock ceiling, capped by the stage's remaining quota. */
  engineCapSeconds: number
  jobs: number
  timeoutSeconds: number
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  totalSeconds: DEFAULT_TOTAL_BUDGET_SECONDS,
  shares: {},
}

export const DEFAULT_ENGINES_CONFIG: EnginesConfig = {
  required: ['semgrep'],
  rulePaths: [],
  engineCapSeconds: DEFAULT_ENGINE_CAP_SECONDS,
  jobs: DEFAULT_SEMGREP_JOBS,
  timeoutSeconds: DEFAULT_SEMGREP_TIMEOUT_SECONDS,
}

/**
 * The investigator's own limits (spec §20.29.6).
 *
 * Separate from §9's `budget` section because the units are different and so is what
 * they bound: `budget` divides a target's *time* across the pipeline's stages, and these
 * bound one *conversation* in the adjudication screen in model calls. Folding them into
 * `budget` would have made a per-stage share and a per-sitting call ceiling look like the
 * same kind of number.
 */
export interface InvestigatorConfig {
  /**
   * Model calls allowed in one conversation (spec §20.29.6).
   *
   * Per *conversation*, not per run: leaving the screen and returning starts a fresh one,
   * which is the honest bound — the target's §9 budget is what spans runs.
   */
  maxConversationCalls: number
  /** Agent steps allowed in one turn. The ceiling the conversation is made of. */
  maxSteps: number
}

export const DEFAULT_INVESTIGATOR_CONFIG: InvestigatorConfig = {
  maxConversationCalls: DEFAULT_MAX_CONVERSATION_CALLS,
  maxSteps: DEFAULT_INVESTIGATOR_STEPS,
}

export interface WindbreakConfig {
  models: ModelConfig
  budget: BudgetConfig
  engines: EnginesConfig
  investigator: InvestigatorConfig
}

export const DEFAULT_CONFIG: WindbreakConfig = {
  models: DEFAULT_MODEL_CONFIG,
  budget: DEFAULT_BUDGET_CONFIG,
  engines: DEFAULT_ENGINES_CONFIG,
  investigator: DEFAULT_INVESTIGATOR_CONFIG,
}

/**
 * Sections other than `models` are optional in the file and are merged over the
 * defaults, so a config written before a section existed keeps working.
 */
const budgetSectionSchema = z
  .object({
    totalSeconds: z.number().int().positive().optional(),
    shares: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .optional()

const enginesSectionSchema = z
  .object({
    required: z.array(z.string().min(1)).optional(),
    rulePaths: z.array(z.string().min(1)).optional(),
    engineCapSeconds: z.number().int().positive().optional(),
    jobs: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .optional()

export const investigatorSectionSchema = z
  .object({
    maxConversationCalls: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional(),
  })
  .optional()

const configSchema = z.object({
  models: modelConfigSchema.optional(),
  budget: budgetSectionSchema,
  engines: enginesSectionSchema,
  investigator: investigatorSectionSchema,
})

export interface LoadedConfig {
  config: WindbreakConfig
  /** Path the config was read from, or null when defaults were used. */
  sourcePath: string | null
  violations: ModelConfigViolation[]
}

export const mergeConfigSections = (raw: {
  budget?: z.infer<typeof budgetSectionSchema>
  engines?: z.infer<typeof enginesSectionSchema>
  investigator?: z.infer<typeof investigatorSectionSchema>
}): Pick<WindbreakConfig, 'budget' | 'engines' | 'investigator'> => ({
  budget: {
    totalSeconds:
      raw.budget?.totalSeconds ?? DEFAULT_BUDGET_CONFIG.totalSeconds,
    shares: (raw.budget?.shares ?? {}) as Partial<Record<StageName, number>>,
  },
  engines: {
    required: raw.engines?.required ?? [...DEFAULT_ENGINES_CONFIG.required],
    rulePaths: raw.engines?.rulePaths ?? [...DEFAULT_ENGINES_CONFIG.rulePaths],
    engineCapSeconds:
      raw.engines?.engineCapSeconds ?? DEFAULT_ENGINES_CONFIG.engineCapSeconds,
    jobs: raw.engines?.jobs ?? DEFAULT_ENGINES_CONFIG.jobs,
    timeoutSeconds:
      raw.engines?.timeoutSeconds ?? DEFAULT_ENGINES_CONFIG.timeoutSeconds,
  },
  investigator: {
    maxConversationCalls:
      raw.investigator?.maxConversationCalls ?? DEFAULT_INVESTIGATOR_CONFIG.maxConversationCalls,
    maxSteps: raw.investigator?.maxSteps ?? DEFAULT_INVESTIGATOR_CONFIG.maxSteps,
  },
})

/**
 * Load a config file, falling back to defaults when no path is given.
 *
 * Structural problems throw (they are a broken file); semantic problems come
 * back as `violations` so `config validate` can report all of them at once and
 * `scan` can refuse with the same list.
 */
export const loadConfig = (configPath?: string): LoadedConfig => {
  if (!configPath) {
    return {
      config: DEFAULT_CONFIG,
      sourcePath: null,
      violations: validateModelConfig(DEFAULT_CONFIG.models),
    }
  }

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const parsed = configSchema.parse(raw)

  const models = parsed.models ?? DEFAULT_MODEL_CONFIG

  return {
    config: {
      models,
      ...mergeConfigSections(parsed),
    },
    sourcePath: configPath,
    violations: validateModelConfig(models),
  }
}
