/**
 * Running a scan from inside the TUI (§20.33).
 *
 * `runScan` is the orchestrator the batch `scan`/`resume` commands already call; this
 * module is what makes it reachable from a renderer, and it exists because three of the
 * things a *command* gets from its own surroundings are not available to one:
 *
 * 1. **The database is opened here, and opening may create it.** That is the legitimate
 *    half of the absent-database rule: §20.28 forbids creating a state database so an
 *    empty queue can be shown, because "no disagreements" is not a fact about a checkout
 *    nothing has scanned. A scan is the opposite case — it is the operation that *makes*
 *    the facts — so `openStateDatabase` initialising the file at `.windbreak/state.db`
 *    is what the researcher asked for rather than a substitution.
 * 2. **The decider is non-interactive, and not by preference.** `runScan` builds an
 *    *interactive* budget decider unless told otherwise, which reads stdin — and stdin
 *    belongs to the renderer while this runs. Passing `yes: true` is therefore
 *    correctness rather than a default: without it, a budget overrun would block the scan
 *    on a prompt nobody can see, inside the alternate screen, with the screen apparently
 *    hung. §9's policy for a non-interactive caller is to degrade rather than prompt, and
 *    a screen is a non-interactive caller.
 * 3. **Progress is a callback, not stdout.** `log` is the same channel the batch command
 *    pipes to `console.log`, so the screen streams exactly the lines the run would have
 *    printed — one source, not a second summariser that could disagree with it.
 *
 * A failure is a value rather than a throw, for the reason the queue's own opener returns
 * one: every refusal here (an unreadable config, a run that does not exist) is a thing the
 * screen has to *say*, and a thrown error would land inside a React render.
 */

import path from 'path'

import { loadEffectiveConfig } from '../config'
import { readGitRefs } from '../recon/git'
import { createTargetId } from '../recon/run'
import { openStateDatabase } from '../state/db'
import { VERSION } from '../version'
import { runScan } from './run'

import type { WindbreakModelHost } from '../client'
import type { ScanResult } from './types'

export interface LaunchScanOptions {
  dbPath: string
  /** The checkout to scan. Ignored when `runId` names an existing run. */
  targetRoot?: string | undefined
  /** The revision to pin; defaults to the checkout's HEAD. */
  commit?: string | undefined
  /** The config file the batch commands read, when one was named. */
  configPath?: string | undefined
  /**
   * Continue this run from its first incomplete stage (§7.3).
   *
   * The target is read back from the run rather than taken from `targetRoot`: a resume
   * that re-resolved the checkout from the caller's working directory could attach the
   * continuation to a different target, and `resume` already exists as the command that
   * refuses exactly that.
   */
  runId?: string | undefined
  /**
   * A model transport the caller already owns (§20.41).
   *
   * The seam that makes an in-TUI scan able to run on the host it was launched from,
   * rather than on a second client the scan resolves for itself. Absent, the behaviour is
   * unchanged; present, the scan neither builds nor releases it.
   */
  modelHost?: WindbreakModelHost | undefined
  /** One line per event, as the run itself reports them. */
  log?: ((line: string) => void) | undefined
}

export type LaunchScanOutcome =
  | { ok: true; result: ScanResult }
  | { ok: false; reason: string }

/** What a run's own record says the target was, for a continuation. */
interface ResolvedRunTarget {
  targetRoot: string
  targetId: string
  commitSha: string
}

const targetForRun = (
  dbPath: string,
  runId: string,
): { ok: true; target: ResolvedRunTarget } | { ok: false; reason: string } => {
  const db = openStateDatabase(dbPath)
  try {
    const run = db
      .query<{ target_id: string; commit_sha: string }, [string]>(
        'SELECT target_id, commit_sha FROM runs WHERE id = ?',
      )
      .get(runId)
    if (!run) return { ok: false, reason: `no run ${runId} in ${dbPath}.` }

    const target = db
      .query<{ location: string | null }, [string]>(
        'SELECT location FROM targets WHERE id = ?',
      )
      .get(run.target_id)
    if (!target?.location) {
      return {
        ok: false,
        reason:
          `run ${runId} records target ${run.target_id}, which has no checkout path ` +
          'on record; the run cannot be continued.',
      }
    }

    return {
      ok: true,
      target: {
        targetRoot: target.location,
        targetId: run.target_id,
        commitSha: run.commit_sha,
      },
    }
  } finally {
    db.close()
  }
}

/**
 * Resolve, open, run, close.
 *
 * Split from `launchScan` so that *every* failure — including the ones that are thrown
 * rather than returned, such as a config file that parses but does not validate — leaves
 * as a value. The screen awaits this and then renders whatever comes back; a rejection
 * would leave it on a running scan that had already stopped.
 */
const launch = async (options: LaunchScanOptions): Promise<LaunchScanOutcome> => {
  const dbPath = path.resolve(options.dbPath)

  // Refused before the database is opened, so a config the researcher is told about is
  // not one a half-run scan was started against. Only *violations* refuse: §20.29.6's
  // rule that the screen runs no verdict roles does not apply here — this is the scan,
  // and the roles it is about to run are exactly the ones the config is validated for.
  let loaded: ReturnType<typeof loadEffectiveConfig>
  try {
    // The *effective* config, so the menu's scan is governed by the same document the
    // commands are: `--config` when the screen was given one, else the `.windbreak` config
    // discovered from the working directory. Reading only the named file here made the
    // menu run the built-in models in a checkout whose config asked for others — the
    // tool disagreeing with itself about which config is in effect.
    loaded = loadEffectiveConfig(options.configPath)
  } catch (error) {
    return {
      ok: false,
      reason: `the configuration could not be read, so no scan was started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  if (loaded.violations.length > 0) {
    return {
      ok: false,
      reason:
        'the configuration is invalid, so no scan was started: ' +
        loaded.violations
          .map((violation) => `[${violation.role}] ${violation.message}`)
          .join('; '),
    }
  }

  let target: ResolvedRunTarget
  if (options.runId !== undefined) {
    const resolved = targetForRun(dbPath, options.runId)
    if (!resolved.ok) return resolved
    target = resolved.target
  } else {
    if (!options.targetRoot) {
      return { ok: false, reason: 'there is no checkout to scan.' }
    }
    const targetRoot = path.resolve(options.targetRoot)
    const commitSha = options.commit ?? readGitRefs(targetRoot).commitSha ?? 'unknown'
    target = {
      targetRoot,
      // Computed the way recon computes it, or every row would attach to a target that
      // does not exist.
      targetId: createTargetId(targetRoot, commitSha),
      commitSha,
    }
  }

  const db = openStateDatabase(dbPath)
  try {
    const result = await runScan({
      db,
      targetRoot: target.targetRoot,
      targetId: target.targetId,
      commitSha: target.commitSha,
      config: loaded.config,
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      // See (2) above: the renderer owns stdin, so a prompt would hang the screen.
      yes: true,
      version: VERSION,
      // A host the screen already holds is used as-is and left open for its owner
      // (§20.41): the free path is admitted only to the freebuff CLI, so a scan run inside
      // that CLI has to run on the client and session it already has rather than on a
      // second pair resolved from the environment.
      ...(options.modelHost ? { modelHost: options.modelHost } : {}),
      ...(options.log ? { log: options.log } : {}),
    })

    return { ok: true, result }
  } catch (error) {
    // The run that got this far is left in the database, which is what makes it
    // resumable: the failure is reported to the researcher, and `resume` picks up from
    // the first stage that never completed.
    return {
      ok: false,
      reason: `the scan did not finish: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  } finally {
    db.close()
  }
}

export const launchScan = async (
  options: LaunchScanOptions,
): Promise<LaunchScanOutcome> => {
  try {
    return await launch(options)
  } catch (error) {
    // A backstop, not the main path: everything expected is returned above. Reaching here
    // means something outside the pipeline threw — a database that cannot be opened, a
    // config path that is a directory — and the screen still has to be told.
    return {
      ok: false,
      reason: `the scan could not be started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
