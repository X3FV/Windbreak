/**
 * What an in-TUI scan is *about*: the checkout, the state database its run goes into, and
 * the config that governed that choice (§20.33.1's rule — name the subject before the wait,
 * because a repository and a database are the two facts a researcher gets wrong).
 *
 * ## Two anchors, and why they are not the same one
 *
 * The **checkout** is the session's own repository, never `config.target.location`. The chat
 * surface has already resolved which repository it is about — that is what its file tools
 * read and what its history is attached to — so a scan that silently went to the configured
 * target would produce findings about code the researcher is not looking at. A bare
 * directory needs a configurable default *because* it cannot say which checkout it means;
 * the TUI can, so it does.
 *
 * The **database** is the configured one, because state's location is a decision the config
 * owns: `windbreak scan` and the TUI have to write runs where the other one reads them, and
 * a view that assumed `<repo>/.windbreak/state.db` would show an empty queue to anyone who
 * had configured state elsewhere (spec §18's substitution — "not checked" reading as
 * "clean").
 *
 * ## Why the config is looked up at the repository root rather than the process's cwd
 *
 * This is the one place this module deliberately differs from
 * `config.discoverConfigPath()`, which resolves `<cwd>/.windbreak/config.json`. That is the
 * right rule for a command, because a command is *run from* its target. The TUI is not: it
 * can be started from `<repo>/src/deep`, where the conventional path holds no config, and a
 * configured database would then be ignored from every subdirectory — silently, since the
 * conventional path is also the fallback. Anchoring at the repository makes "which config",
 * "which repository" and "which database" one answer.
 *
 * A refusal is a value rather than a throw: an unreadable config is something the view has
 * to *say*, and a thrown error would land inside a React render.
 */

import fs from 'fs'
import path from 'path'

import { loadConfig } from '@codebuff/windbreak/config'

export interface ScanSubject {
  /** The checkout the scan reads. Always the session's repository. */
  targetRoot: string
  /** Where the run's state goes: the configured database, else the checkout's own. */
  dbPath: string
  /**
   * The target the *config* names, when it names one.
   *
   * Carried for display rather than for use: a subject that differs from it is worth one
   * line on the screen, because `windbreak scan` in this directory would follow the config
   * and the TUI will not.
   */
  configuredTarget: string | null
  /** The config file that produced `dbPath`, or null when the built-ins did. */
  configPath: string | null
  /**
   * §9's target budget, as the config resolved it.
   *
   * Carried because the view has to *state* it: a scan run from a renderer approves an
   * overrun instead of prompting (`scan/launch.ts`'s reason (2) — stdin belongs to the
   * renderer), and an auto-approval nobody was told about is a spend the researcher did
   * not agree to.
   */
  budgetSeconds: number
  /**
   * §20.29.6's conversation ceiling and per-turn step ceiling, as the config resolved them.
   *
   * Carried for the same reason the budget is, and one more: these are the only limits on
   * what asking a question *costs*, and a pane that enforced a ceiling other than the one in
   * the config would be enforcing a number nobody wrote down. Before this they were read by
   * the retired screen from a `--config` it was handed explicitly, so a configured value was
   * ignored by every entry point that did not name one — which is a spend limit that does not
   * apply depending on how you launched the tool.
   */
  investigator: { maxConversationCalls: number; maxSteps: number }
}

export type ScanSubjectResolution =
  | { ok: true; subject: ScanSubject }
  | { ok: false; reason: string }

/** Where a checkout's config lives when nothing names one (§7.3's convention). */
export const conventionalConfigPath = (repoRoot: string): string =>
  path.join(repoRoot, '.windbreak', 'config.json')

/** Where a checkout's state lives when neither `--db` nor a config says otherwise. */
export const conventionalDbPath = (repoRoot: string): string =>
  path.join(repoRoot, '.windbreak', 'state.db')

export const resolveScanSubject = (input: {
  repoRoot: string
  /** Injected so the `$WINDBREAK_CONFIG` rule is testable without mutating `process.env`. */
  env?: { WINDBREAK_CONFIG?: string | undefined }
}): ScanSubjectResolution => {
  const repoRoot = path.resolve(input.repoRoot)
  const env = input.env ?? process.env

  const fromEnv = env.WINDBREAK_CONFIG
  // An explicitly set variable is honoured even when the file is missing, so that a typo is
  // `Config file not found` rather than a silent fall back to the built-in defaults.
  const conventional = conventionalConfigPath(repoRoot)
  const configPath =
    fromEnv !== undefined && fromEnv.length > 0
      ? path.resolve(fromEnv)
      : fs.existsSync(conventional)
        ? conventional
        : null

  let loaded: ReturnType<typeof loadConfig>
  try {
    loaded = loadConfig(configPath ?? undefined)
  } catch (error) {
    return {
      ok: false,
      reason: `could not read ${configPath ?? 'the configuration'}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  return {
    ok: true,
    subject: {
      targetRoot: repoRoot,
      // Already absolute: `loadConfig` resolves the target section against the directory
      // holding the config file, so `"db": "state.db"` means the config's own directory.
      dbPath: loaded.config.target.db ?? conventionalDbPath(repoRoot),
      configuredTarget: loaded.config.target.location,
      configPath: loaded.sourcePath,
      budgetSeconds: loaded.config.budget.totalSeconds,
      investigator: {
        maxConversationCalls: loaded.config.investigator.maxConversationCalls,
        maxSteps: loaded.config.investigator.maxSteps,
      },
    },
  }
}
