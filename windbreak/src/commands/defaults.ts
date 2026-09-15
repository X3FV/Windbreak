/**
 * The target and state database a command uses when it is not told (spec §7.3).
 *
 * `--target` remains a required *fact* — recon, engines and a scan cannot run without
 * one — but it no longer has to be a required *argument*. What this module reads is the
 * discovered config (`config.discoverConfigPath`), and what the per-target commands get
 * from it is a default that appears in `--help`, can always be overridden on the command
 * line, and is reported verbatim when there is none.
 *
 * ## Why this is resolved once, before the commands are built
 *
 * Commander evaluates an option's default at **registration** time, so anything that
 * comes from a file has to be read before `createProgram()` runs. Resolving it there
 * also concentrates the failure mode: a malformed config is one error at startup rather
 * than a different error from whichever command happened to run first. This is the same
 * "read the environment before anything else" shape as `pre-init/client-env`, and it is
 * the reason `initCommandDefaults` is called from `index.ts` rather than from each
 * command.
 *
 * What it keeps afterwards is the whole resolved config, not just the two paths, so a
 * command that needs models, budgets or extra rule paths reads the same document
 * `--target` came from — see `effectiveConfig`. Two answers to "which config is in effect"
 * is the discrepancy this avoids: `config show` reporting built-ins while a scan runs the
 * file would be the tool disagreeing with itself.
 *
 * The consequence worth knowing: nothing initializes this in a test process, so a test
 * that builds the program — or asks for the effective config — sees the built-in defaults.
 * That is the honest default for a harness: a suite that silently picked up the
 * developer's own `.windbreak/config.json` would be testing that file.
 */

import path from 'path'

import { conventionalConfigPath, discoverConfigPath, loadConfig } from '../config'

import type { LoadedConfig } from '../config'

/** Where state lives when nothing overrides it: the target's own `.windbreak`. */
export const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

export const TARGET_OPTION_DESCRIPTION =
  'path to the target checkout; defaults to the configured target'

export const DB_OPTION_DESCRIPTION =
  'state database path; defaults to the configured one, else <cwd>/.windbreak/state.db'

export interface CommandDefaults {
  /** The configured default target, or undefined when none is configured. */
  target: string | undefined
  dbPath: string
  /** The config these came from, for messages. Null when they are built-in. */
  sourcePath: string | null
}

const BUILT_IN: CommandDefaults = {
  target: undefined,
  dbPath: DEFAULT_DB_PATH,
  sourcePath: null,
}

/** The config this process resolved, or null for the built-ins. Read once, at startup. */
let resolved: LoadedConfig | null = null

/** The two defaults a loaded config implies, in the shape the commands ask for. */
const summarize = (loaded: LoadedConfig | null): CommandDefaults =>
  loaded === null
    ? BUILT_IN
    : {
        target: loaded.config.target.location ?? undefined,
        dbPath: loaded.config.target.db ?? DEFAULT_DB_PATH,
        sourcePath: loaded.sourcePath,
      }

/**
 * The defaults a given config implies. Pure, so the resolution rules can be tested
 * without a process or a working directory.
 *
 * An unreadable config throws here rather than degrading to the built-ins: a config that
 * exists and cannot be read is a problem to fix, and quietly running against the wrong
 * (or no) target because of it is the failure this module exists to prevent.
 */
export const readCommandDefaults = (configPath: string | null): CommandDefaults =>
  summarize(configPath === null ? null : loadConfig(configPath))

/**
 * Read the discovered config and remember it for the process.
 *
 * Returns a message instead of throwing so the CLI can report it and stop before
 * parsing, which is the only point where "your config is broken" can be said once
 * rather than per command.
 */
export const initCommandDefaults = (): { ok: true } | { ok: false; message: string } => {
  const configPath = discoverConfigPath()

  try {
    resolved = configPath === null ? null : loadConfig(configPath)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message:
        `Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}\n` +
        'Fix it or move it aside; windbreak will not fall back to defaults while a config is present.',
    }
  }
}

const current = (): CommandDefaults => summarize(resolved)

/** The configured default target, or undefined when none is configured. */
export const defaultTargetPath = (): string | undefined => current().target

/** The state database to use when `--db` is not given. */
export const defaultDbPath = (): string => current().dbPath

/** The config the defaults came from, for messages. Null when there is none. */
export const defaultConfigSource = (): string | null => current().sourcePath

/**
 * The whole configuration a command runs with: `--config` when one is named, else the
 * discovered one resolved at startup, else the built-in defaults.
 *
 * The same resolution `--target` and `--db` already get, for the commands that need more
 * than those two fields. An explicitly named file is read *here* rather than at startup,
 * so naming one always means exactly that file and never a merge.
 *
 * Callers that already load the effective config themselves (`scan`) keep doing so; this
 * exists for the ones that only ever needed the model and budget sections.
 */
export const effectiveConfig = (configPath?: string): LoadedConfig =>
  configPath ? loadConfig(configPath) : (resolved ?? loadConfig())

/**
 * Forget the resolved defaults.
 *
 * A test seam, and only that: `initCommandDefaults` writes module state, and one bun
 * process runs every file of a suite, so a file that initializes it has to put it back.
 * Nothing in the shipping path calls this. It clears the whole config, including the half
 * `effectiveConfig` returns, so a file that sets it also stops leaking models.
 */
export const resetCommandDefaults = (): void => {
  resolved = null
}

/**
 * Resolve `--target`, or report why there is none and mark the command failed.
 *
 * Returns null once it has reported, so a command reads:
 *
 *   const targetPath = requireTargetOption(options.target)
 *   if (targetPath === null) return
 *
 * Both halves of the fix are named, because the two ways to supply a target are not
 * discoverable from the error alone — and the config file may not exist yet, which is
 * worth saying rather than pointing at a path a first-time user has never created.
 */
export const requireTargetOption = (value: string | undefined): string | null => {
  if (value !== undefined) return value

  const source = defaultConfigSource()
  const where = source ?? conventionalConfigPath()
  console.error(
    `No target. Pass --target <path>, or set "target": { "location": "<path>" } in ${where}` +
      (source === null ? ', which does not exist yet.' : '.'),
  )
  process.exitCode = 1
  return null
}
