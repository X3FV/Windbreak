import fs from 'fs'
import path from 'path'

import { loadConfig } from '@codebuff/windbreak/config'

/**
 * Which state database the screen opens (§20.33, §7.3).
 *
 * The batch commands resolve their default from the config discovered at the *working
 * directory*, and `scripts/windbreak-cli` makes those coincide by running from the target.
 * The screen cannot assume that. It is opened from wherever the researcher is — including
 * deep inside a checkout — and it resolves the repository it shows by walking up to `.git`
 * (§20.31). So its database has to be resolved the same way: against that repository,
 * rather than against the directory the command happened to be typed in.
 *
 * Resolution order, first match wins:
 *
 *   1. `--db` — the caller's explicit choice, already resolved by `args.ts`.
 *   2. The `target.db` of the config belonging to the repository on screen.
 *   3. `<repoRoot>/.windbreak/state.db` — the convention every command writes to.
 *
 * Step 2 is the one worth stating: **a configured database outranks the convention.** That is
 * what makes `"db": "…"` mean anything to the screen. Before this it resolved the conventional
 * path only, so a checkout whose state had been moved elsewhere opened an *absent* database and
 * drew an empty queue over a run sitting in the file it was told to use. An empty queue
 * standing in for an unread one is the substitution §18 exists to prevent.
 *
 * ## Why the config is looked for at the repository root
 *
 * `discoverConfigPath` reads `<cwd>/.windbreak/config.json`, and the batch commands want
 * precisely that, because they run from the target. The screen does not: opened from
 * `<repo>/src/deep`, the conventional path is a directory the config is not in, and a
 * configured database would be silently ignored from every subdirectory. Anchoring the lookup
 * at the repository root makes "which config" agree with "which repository" and "which
 * database" — the same single-answer rule the screen's own comment states for `repoRoot`.
 *
 * `$WINDBREAK_CONFIG` still names a file outright, and `--config` still wins over both, so
 * nothing reachable before this is unreachable now.
 *
 * ## What this deliberately does not do
 *
 * It reads the config for one field. The rest of the document selects models and budgets, and
 * `target.db` is a path rather than a spend limit, so reading it from a *scanned checkout* — a
 * directory that may be untrusted — decides only where the queue is read from. The chat pane's
 * ceilings stay on the explicitly named `--config` in `index.tsx` for that reason: a target
 * repository should not be able to raise the ceiling on the researcher's model calls.
 */

/** The conventional database inside a checkout: what a scan writes when nothing says otherwise. */
export const checkoutDatabasePath = (repoRoot: string): string =>
  path.join(repoRoot, '.windbreak', 'state.db')

/** The conventional config inside a checkout. */
export const checkoutConfigPath = (repoRoot: string): string =>
  path.join(repoRoot, '.windbreak', 'config.json')

export interface ScreenDatabaseInput {
  /** `--db`, as `args.ts` resolved it. Absent means the caller named no database. */
  named?: string | undefined
  /** `--config`, as `args.ts` resolved it. Absent means the caller named no config file. */
  configPath?: string | undefined
  /** The checkout on screen, from `resolveRepoRoot`. */
  repoRoot: string
}

export interface ScreenDatabaseDeps {
  exists?: (candidate: string) => boolean
  env?: Record<string, string | undefined>
  readConfig?: typeof loadConfig
}

/**
 * The config file this screen reads, or null when there is none.
 *
 * Exported because it is the answer to "which config is in effect" for the screen, and both
 * the database and anything else anchored at the checkout need to give the same one.
 */
export const configPathForScreen = (
  input: Pick<ScreenDatabaseInput, 'configPath' | 'repoRoot'>,
  deps: ScreenDatabaseDeps = {},
): string | null => {
  const exists = deps.exists ?? fs.existsSync
  const env = deps.env ?? process.env

  if (input.configPath !== undefined && input.configPath.length > 0) return input.configPath

  const fromEnv = env.WINDBREAK_CONFIG
  // An explicitly set variable is honoured even when the file is missing, so a typo is a
  // `Config file not found` rather than a silent fall back to the convention. That is the rule
  // `discoverConfigPath` follows, and two answers to "did you mean to name a config" would
  // make a typo invisible on this surface only.
  if (fromEnv !== undefined && fromEnv.length > 0) return path.resolve(fromEnv)

  const conventional = checkoutConfigPath(input.repoRoot)
  return exists(conventional) ? conventional : null
}

/**
 * The database the screen opens.
 *
 * Throws when a config it found cannot be read, for the caller to report and stop on — the same
 * rule `commands/defaults.ts` follows on the batch side. A config that exists and cannot be read
 * is a problem to fix; quietly opening state nobody named is the failure this exists to prevent.
 */
export const resolveScreenDatabase = (
  input: ScreenDatabaseInput,
  deps: ScreenDatabaseDeps = {},
): string => {
  if (input.named !== undefined && input.named.length > 0) return input.named

  const configPath = configPathForScreen(input, deps)
  if (configPath !== null) {
    let loaded: ReturnType<typeof loadConfig>
    try {
      loaded = (deps.readConfig ?? loadConfig)(configPath)
    } catch (error) {
      // The file is named here, because the failure alone does not identify it: a zod or
      // `JSON.parse` message is about the *contents*, and on this surface the researcher may
      // not know that a config was found at all. The batch side wraps it the same way
      // (`commands/defaults.ts`).
      throw new Error(
        `could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const configured = loaded.config.target.db
    // `null` is the absence of a default, not a path — the section's own rule.
    if (configured !== null) return configured
  }

  return checkoutDatabasePath(input.repoRoot)
}
