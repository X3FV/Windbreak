import fs from 'fs'
import path from 'path'

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

/**
 * The target a per-target command runs against by default (spec §7.3).
 *
 * `--target` stays a real option: a target is not optional to recon, engines or a scan,
 * and a command with no target must refuse rather than guess one. What this section
 * removes is the need to *repeat* the path. A researcher working through one repository
 * runs `windbreak scan`, not `windbreak scan --target /the/same/path` forty times, and
 * the failure it prevents is the quiet one — a scan accidentally pointed at a stale
 * checkout or at the wrong sibling directory, whose numbers then describe something
 * other than what the researcher thinks they do.
 */
export interface TargetConfig {
  /**
   * Default `--target`. `null` means there is none, and the per-target commands say so.
   *
   * A relative path resolves against the **config file's directory**, not the working
   * directory, so a configured target means the same checkout regardless of where the
   * command was run from. Resolving against the working directory would make the
   * default depend on which shell you happened to be in, which is the class of mistake
   * this section exists to remove.
   */
  location: string | null
  /**
   * Default state database. `null` means `<cwd>/.windbreak/state.db`, which stays the
   * default because it is the documented convention: state lives inside the target's
   * own `.windbreak`.
   */
  db: string | null
}

export const DEFAULT_TARGET_CONFIG: TargetConfig = { location: null, db: null }

export interface WindbreakConfig {
  models: ModelConfig
  budget: BudgetConfig
  engines: EnginesConfig
  investigator: InvestigatorConfig
  target: TargetConfig
}

export const DEFAULT_CONFIG: WindbreakConfig = {
  models: DEFAULT_MODEL_CONFIG,
  budget: DEFAULT_BUDGET_CONFIG,
  engines: DEFAULT_ENGINES_CONFIG,
  investigator: DEFAULT_INVESTIGATOR_CONFIG,
  target: DEFAULT_TARGET_CONFIG,
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

export const targetSectionSchema = z
  .object({
    location: z.string().min(1).nullable().optional(),
    db: z.string().min(1).nullable().optional(),
  })
  .optional()

const configSchema = z.object({
  models: modelConfigSchema.optional(),
  budget: budgetSectionSchema,
  engines: enginesSectionSchema,
  investigator: investigatorSectionSchema,
  target: targetSectionSchema,
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
  const directory = path.dirname(path.resolve(configPath))

  return {
    config: {
      models,
      ...mergeConfigSections(parsed),
      target: resolveTargetSection(parsed.target, directory),
    },
    sourcePath: configPath,
    violations: validateModelConfig(models),
  }
}

/**
 * The `target` section with its paths made absolute against the config's directory.
 *
 * The directory is the one holding the config file, so in the conventional location the
 * target is written `".."`: `<target>/.windbreak/config.json` sits one level inside the
 * checkout it describes. Resolving against that directory rather than the working
 * directory is what makes a configured target mean one checkout, not whichever one the
 * command happened to be run from.
 */
const resolveTargetSection = (
  raw: z.infer<typeof targetSectionSchema>,
  directory: string,
): TargetConfig => ({
  location:
    raw?.location === undefined || raw.location === null
      ? null
      : path.resolve(directory, raw.location),
  db:
    raw?.db === undefined || raw.db === null
      ? null
      : path.resolve(directory, raw.db),
})

/** The conventional config location, relative to the working directory. */
export const conventionalConfigPath = (): string =>
  path.resolve('.windbreak', 'config.json')

/**
 * Where WindBreak looks for a config when `--config` is not given.
 *
 * `$WINDBREAK_CONFIG` first, then `<cwd>/.windbreak/config.json`. Both are the same
 * convention the rest of the tool follows — state lives in the target's `.windbreak` —
 * and the working directory is the target in the intended workflow, which is what makes
 * a bare `windbreak scan` land on the right repository.
 *
 * **The rule that comes with that convenience:** a config found this way is read from a
 * directory that may be a scanned checkout, so a repository can influence the defaults
 * of the tool that scans it. Everything in this file is read-only to the scan — it
 * selects models, budgets, extra rule paths and the default target, and it cannot cause
 * code to run — but a target that ships its own `.windbreak/config.json` can redirect a
 * scan or widen its rule set. Point `$WINDBREAK_CONFIG` at a file outside the target if
 * that matters for what you are scanning.
 */
export const discoverConfigPath = (): string | null => {
  const fromEnv = process.env.WINDBREAK_CONFIG
  // An explicitly set variable is honoured even when the file is missing, so that a
  // typo is a `Config file not found` rather than a silent fall back to no defaults.
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv)

  const conventional = conventionalConfigPath()
  return fs.existsSync(conventional) ? conventional : null
}

/**
 * The config a command actually runs with: `--config`, else discovery, else defaults.
 *
 * Separate from `loadConfig` rather than folded into it so that "read exactly this file"
 * stays a different request from "read whatever is configured here". A caller that wants
 * the built-in defaults — `config show` in a fresh directory, most tests — still gets
 * them from `loadConfig()`.
 */
export const loadEffectiveConfig = (configPath?: string): LoadedConfig =>
  loadConfig(configPath ?? discoverConfigPath() ?? undefined)
