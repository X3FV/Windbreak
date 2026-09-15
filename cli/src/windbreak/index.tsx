import { createCliRenderer } from '@opentui/core'
import { createRoot, flushSync } from '@opentui/react'
import {
  createReviewInvestigator,
  openReviewSession,
  resolveRepoRoot,
} from '@codebuff/windbreak/review'
import { launchScan as runLaunchScan } from '@codebuff/windbreak/scan'
import { openStateDatabase } from '@codebuff/windbreak/state'
import { createWindbreakClient } from '@codebuff/windbreak/client'
import { loadConfig } from '@codebuff/windbreak/config'
import React from 'react'

import { exitCliCleanly } from '../utils/exit-cleanly'
import { initializeThemeStore } from '../hooks/use-theme'
import { installProcessCleanupHandlers } from '../utils/renderer-cleanup'
import { writeFileDescriptorSync } from '../utils/terminal-io'

import { findWindbreakCommand, parseWindbreakArgs, WindbreakUsageError } from './args'
import { resolveScreenDatabase } from './database'
import { LoadingPane } from './loading-pane'
import type { WindbreakPreferences } from './preferences'
import { ReviewApp } from './review-app'
import { StartMenu, type ScanRunner } from './start-menu'
import {
  readWindbreakPreferences,
  writeWindbreakPreferences,
} from './settings-store'

import type { InvestigatorConfig } from '@codebuff/windbreak/config'
import type {
  OpenReviewSessionResult,
  ReviewInvestigator,
  ReviewSession,
} from '@codebuff/windbreak/review'
import type { LaunchScanOutcome } from '@codebuff/windbreak/scan'
import type { Database } from 'bun:sqlite'

/**
 * `freebuff windbreak` — the adjudication surface (spec D32, §5.3, §20.33).
 *
 * Dispatched before the chat app exists, for the same reason the smoke paths
 * are: this surface never wants a chat session, an agent registry, or an API
 * client. It reads a local state database and writes a decision back to it, and
 * that is all it does. `cli/src/index.tsx` therefore checks for it before
 * `parseArgs()` runs.
 *
 * Since §20.33 it opens the **start menu** rather than the queue: the three things a
 * checkout can be asked for are scan, files, and resume-a-run, and one of them (the scan)
 * runs in this process. The queue is then a screen *under* the menu, opened with a run id
 * — which is why the session is opened again at that point instead of being carried from
 * the start.
 */

export interface WindbreakTuiDeps {
  /** Replaced in tests, which must not create a real renderer or exit. */
  resolveSession?: (args: {
    dbPath: string
    runId?: string | undefined
    /** §20.31's fallback listing, resolved from the working directory. */
    repoRoot?: string | null
  }) => OpenReviewSessionResult
  /** Called instead of the product exit path. */
  exit?: (code: number) => void
  /** stdout, for `--help`. Straight to the descriptor: no logger is initialized. */
  writeOut?: (line: string) => void
  /** stderr, for refusals. */
  writeErr?: (line: string) => void
  /**
   * The theme store, initialized here rather than assumed.
   *
   * `useThemeStore` is a module-level singleton that throws until
   * `initializeThemeStore()` runs, and the chat app's `initializeApp` is what
   * normally runs it. This surface deliberately never calls `initializeApp`, so
   * skipping this made the screen die on its first render with
   * "useThemeStore not initialized" — the first thing the real TUI run caught.
   */
  initializeTheme?: () => void
  /** Replaced in tests that need to prove ordering without a terminal. */
  createRenderer?: typeof createCliRenderer
  /**
   * Where the screen's saved arrangement and palette come from.
   *
   * A seam because the real reader is `loadSettings`, which *creates* the CLI's
   * config directory when it is missing — a test that forgot to inject this
   * would write a settings file into the developer's home directory.
   */
  loadPreferences?: () => WindbreakPreferences
  /** Where a change made with `L`/`t` is written. Also injected in tests. */
  savePreferences?: (next: WindbreakPreferences) => void
  /**
   * Builds §20.29's investigator bridge, or returns null when it cannot be built.
   *
   * A seam for the same reason `resolveSession` is: the real builder reaches for
   * credentials and a second database connection, and a test that ran it would read the
   * developer's `credentials.json`. Injecting it also lets a test prove the pane *works*,
   * which is otherwise untestable without a provider.
   */
  createInvestigator?: (input: {
    db: Database
    clientUnavailableReason?: string
    /** The pane's limits from the config file (§20.29.6), so a test can prove they arrive. */
    limits: InvestigatorConfig
  }) => Promise<ReviewInvestigator>
  /**
   * Runs a scan for the menu (§20.33).
   *
   * A seam because the real one is a whole pipeline — recon, a sandboxed build, engines,
   * model calls and a report — and a test of the *screen* must not need any of it. What is
   * asserted through it is the wiring: which database and checkout the menu passes, and
   * what the screen does with the result.
   */
  launchScan?: (input: {
    dbPath: string
    targetRoot?: string
    commit?: string
    configPath?: string
    runId?: string
    log?: (line: string) => void
  }) => Promise<LaunchScanOutcome>
  /**
   * Mounts a React root over the renderer, returning the two operations the command uses.
   *
   * A seam beside `createRenderer` rather than a convenience: the screen now renders
   * *twice* — the loading pane, then the app once the bridge is ready — and a test that
   * wants to observe that ordering has to be able to stand in for the root. It also keeps
   * `createRoot` out of the test process entirely, where there is no renderer for it to
   * attach to.
   */
  mount?: (renderer: WindbreakRenderer) => WindbreakMount
}

/** What `createCliRenderer` resolves to, named once so the seams can refer to it. */
type WindbreakRenderer = Awaited<ReturnType<typeof createCliRenderer>>

/**
 * How long to wait for the loading frame to reach the terminal.
 *
 * A bound, not a budget: `renderer.idle()` is the normal path and resolves as soon as the
 * frame is away. The race exists because a renderer that never reports idle would hold
 * the CLI on a loading screen forever, and a blank pause is a far better failure than a
 * hang.
 */
const LOADING_FRAME_TIMEOUT_MS = 250

/** The two things the command needs from a mounted root. */
export interface WindbreakMount {
  render: (element: React.ReactNode) => void
  unmount: () => void
}

/**
 * Run the subcommand.
 *
 * Returns a non-zero code when the surface refused to start — which the caller
 * must apply to `process.exitCode`, because the command never runs far enough to
 * own the exit itself. A zero return means the screen is up: the renderer keeps
 * the process alive, and the screen ends the process when the researcher leaves.
 */
export const runWindbreakCommand = async (
  argv: readonly string[],
  deps: WindbreakTuiDeps = {},
): Promise<number> => {
  const writeOut = deps.writeOut ?? ((line: string) => void writeFileDescriptorSync(1, `${line}\n`))
  const writeErr = deps.writeErr ?? ((line: string) => void writeFileDescriptorSync(2, `${line}\n`))

  const commandIndex = findWindbreakCommand(argv)

  let args
  try {
    args = parseWindbreakArgs(commandIndex === null ? [] : argv.slice(commandIndex + 1))
  } catch (error) {
    if (error instanceof WindbreakUsageError) {
      // Help goes to stdout and is not a failure; a misuse is a usage error.
      if (error.help) writeOut(error.message)
      else writeErr(`windbreak: ${error.message}`)
      return error.help ? 0 : 2
    }
    throw error
  }

  // The config is read before anything is opened, and a file that cannot be read or
  // parsed is a refusal rather than a screen with quietly different limits. Only the
  // *unreadable* case is refused: the `violations` `loadConfig` also returns are about the
  // verdict roles' cross-provider gate, and the menu runs none of them — refusing the menu
  // over a misconfigured Proposer would be refusing it for a reason it does not use. (The
  // *scan* the menu can start does run them, and refuses itself there, with the violations
  // named.)
  let investigatorLimits: InvestigatorConfig
  try {
    investigatorLimits = loadConfig(args.configPath).config.investigator
  } catch (error) {
    writeErr(
      `windbreak: ${error instanceof Error ? error.message : String(error)}`,
    )
    return 2
  }

  // Which repository is on screen (§20.31). Resolved here, once, and handed to the menu,
  // the sessions, and the bridge, so the file pane and the models cannot be looking at two
  // different checkout — a second resolution inside either one would be a second answer
  // to "which repository is this".
  const repoRoot = resolveRepoRoot(args.cwd)

  // Which database the screen reads, resolved from the repository above rather than from the
  // working directory: `--db` if named, else that checkout's own configured database, else its
  // conventional `.windbreak/state.db`. Resolved here for the same reason `repoRoot` is — the
  // queue, the scan and the file pane all have to be about one checkout, and a database picked
  // anywhere else is a second answer to that question. A config that exists and cannot be read
  // refuses the screen, as it does on the batch side.
  let databasePath: string
  try {
    databasePath = resolveScreenDatabase({
      named: args.dbPath,
      configPath: args.configPath,
      repoRoot,
    })
  } catch (error) {
    writeErr(`windbreak: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }

  const resolveSession = deps.resolveSession ?? openReviewSession
  const opened = resolveSession({
    dbPath: databasePath,
    runId: args.runId,
    repoRoot,
  })

  if (!opened.ok) {
    // Only an unusable database lands here — the wrong schema version, or a file
    // that is not one. Reported before a renderer is created: there is nothing to
    // show yet, and an operator who pointed at the wrong file should see why on
    // the normal screen rather than inside an alternate one they then have to
    // leave. A *missing* database is not this: it opens, and the menu says so
    // (`session.source.absent`) while still offering a scan, which is what creates
    // one.
    writeErr(`windbreak: ${opened.reason}`)
    return 1
  }

  const exit = deps.exit ?? ((code: number) => void exitCliCleanly(code))

  // Before the renderer, because the first render reads the theme.
  ;(deps.initializeTheme ?? initializeThemeStore)()

  const createRenderer = deps.createRenderer ?? createCliRenderer
  const renderer = await createRenderer({
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
  })

  installProcessCleanupHandlers(renderer)

  const mount = deps.mount ?? ((target: WindbreakRenderer) => createRoot(target))
  const root = mount(renderer)

  // Read once, so the loading pane and the screens cannot disagree about the palette.
  const preferences = (deps.loadPreferences ?? readWindbreakPreferences)()

  /**
   * Every connection this command has opened.
   *
   * A scan written into a database that did not exist before leaves the menu's own
   * connection stale — the run it just created is not in it — so the menu is handed a
   * *fresh* session and the previous one stays open. Closing it under a component that may
   * still be reading it would be the alternative, and one idle SQLite connection per scan
   * is the cheaper side of that trade. They are closed together on the way out.
   */
  const sessions: ReviewSession[] = [opened.session]

  const leave = (code: number): void => {
    root.unmount()
    for (const active of sessions) active.close()
    exit(code)
  }

  /** Reopen the queue's database — for the dashboard, or for the menu after a scan. */
  const reopen = (runId?: string): OpenReviewSessionResult =>
    resolveSession({
      dbPath: databasePath,
      ...(runId === undefined ? {} : { runId }),
      repoRoot,
    })

  /**
   * The scan the menu runs, bound to this command's database and checkout.
   *
   * The checkout is the resolved repository rather than the working directory, so the
   * menu and the file pane cannot be about two different trees. When there is no
   * repository at all the field is omitted rather than guessed at, and `launchScan`
   * refuses with that reason — the same refusal the menu row states.
   */
  const runScan: ScanRunner = (options) =>
    (deps.launchScan ?? runLaunchScan)({
      dbPath: databasePath,
      ...(repoRoot === null ? {} : { targetRoot: repoRoot }),
      ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      log: options.log,
    })

  /**
   * §20.29's investigator bridge for a given session, when it can be built.
   *
   * Built here rather than in the screen, because this is where credentials already
   * exist. Two ways it ends up absent, and both are normal: no credentials are
   * available, or the database cannot be opened. Each becomes a reason the pane states
   * rather than an empty pane that looks ready (§18).
   *
   * §20.31 removed the third: a checkout nothing has scanned no longer has no target.
   * The bridge is still built — with the resolved repository as its fallback root and a
   * *throwaway in-memory* connection — because reading a checkout is not a thing that
   * needed a scan. What still needs one is the write side and the transcript, and the
   * bridge says so where it happens rather than refusing the whole pane.
   *
   * The connection is created in memory on purpose and is not negotiable: opening the
   * disk file here is what `session.source.absent` says does not exist, and *creating* it
   * would leave a database whose empty queue reads as "no disagreements" — the §20.28
   * substitution, with the extra cost of a file the researcher did not ask for.
   *
   * Defined before it is called, and called *after* the renderer: the wait belongs on
   * screen, so the order of operations is renderer, loading pane, this, app. See
   * `loading-pane.tsx`.
   */
  const buildInvestigator = async (
    session: ReviewSession,
  ): Promise<ReviewInvestigator | null> => {
    const hasStateDatabase = !session.source.absent && session.source.path !== null

    let bridgeDb: Database
    try {
      // A second connection to the same file, which WAL supports. The alternative is
      // widening `ReviewSession` with its connection, and the session's own comment says
      // what it is: a queue reader. The bridge's reads are not the queue's, and keeping
      // them out of that interface keeps the screen's surface as small as it claims.
      bridgeDb = openStateDatabase(
        hasStateDatabase ? (session.source.path as string) : ':memory:',
      )
    } catch {
      return null
    }

    if (deps.createInvestigator) {
      return deps.createInvestigator({ db: bridgeDb, limits: investigatorLimits })
    }

    let client
    let clientUnavailableReason: string | undefined
    try {
      ;({ client } = await createWindbreakClient({ cwd: process.cwd() }))
    } catch (error) {
      client = null
      clientUnavailableReason =
        `no model credentials are available, so the investigator cannot run (${
          error instanceof Error ? error.message : String(error)
        }). Reviewing a disagreement needs no model: only the chat pane is unavailable.`
    }

    return createReviewInvestigator({
      db: bridgeDb,
      client,
      maxAgentSteps: investigatorLimits.maxSteps,
      maxConversationCalls: investigatorLimits.maxConversationCalls,
      // Always offered, and only reached when no run resolves a target: with a scan the
      // run's own target wins, so this cannot quietly redirect an investigation away
      // from the evidence it was opened for.
      fallbackTargetRoot: repoRoot,
      ...(clientUnavailableReason ? { clientUnavailableReason } : {}),
    })
  }

  /**
   * The queue, for a run or for every disagreement (§5.3).
   *
   * Returns false when the queue could not be opened. What that costs depends on the
   * caller: from the menu there is still a screen behind it, and from `--run` there is
   * not — so the caller decides whether a refusal ends the command, rather than this
   * choosing for it.
   */
  const showReview = async (runId: string | null): Promise<boolean> => {
    const next = reopen(runId ?? undefined)
    if (!next.ok) {
      // A database that was usable when the menu opened and is not now: the file was
      // replaced or removed underneath. Reported on the normal screen, and the menu stays
      // where it is — there is nothing about this that should cost the researcher their
      // place.
      writeErr(`windbreak: ${next.reason}`)
      return false
    }

    const session = next.session
    sessions.push(session)

    // Drawn whenever a bridge is going to be built, which §20.31 makes unconditional: the
    // wait is resolving credentials and importing the SDK, and an unscanned checkout now
    // builds a bridge too (with the repository as its fallback root). The earlier condition
    // skipped this for an absent database, when there was no bridge and therefore no pause —
    // that reasoning went with the absence of a bridge.
    //
    // What it names is the path the screen was pointed at, so an operator who pointed it
    // somewhere wrong sees that before the queue appears rather than after.
    //
    // **Two gates have to be passed or the frame never reaches the terminal, and both were
    // found by running it.** React has to *commit* the tree: `createRoot` builds a
    // `ConcurrentRoot`, so a plain `render` only enqueues the work, and the very next thing
    // this function does is `await` the bridge — after which the app's render supersedes the
    // loading one before React ever commits it. Then the renderer has to *draw* it: it paints
    // on its own schedule, with `requestRender` deferring to `process.nextTick`, so a
    // committed tree is still not a painted one. `flushSync` closes the first gate and
    // `idle()` the second. Without either, this is the blank pause with extra steps.
    const waitSubject =
      session.source.absent || session.source.path === null ? repoRoot : databasePath
    flushSync(() => {
      root.render(<LoadingPane subject={waitSubject} preferences={preferences} />)
    })
    renderer.requestRender()
    await Promise.race([
      renderer.idle(),
      new Promise<void>((resolve) => setTimeout(resolve, LOADING_FRAME_TIMEOUT_MS)),
    ])

    let investigator: ReviewInvestigator | null = null
    try {
      investigator = await buildInvestigator(session)
    } catch {
      // A bridge that cannot be built is not a reason to refuse the screen: the queue is
      // the product, and the pane is an addition to it.
      investigator = null
    }

    root.render(
      <ReviewApp
        session={session}
        dbPath={databasePath}
        runId={runId ?? undefined}
        includeResolvedInitially={args.includeResolved}
        preferences={preferences}
        onPreferencesChange={deps.savePreferences ?? writeWindbreakPreferences}
        investigator={investigator ?? undefined}
        onExit={() => leave(0)}
      />,
    )

    return true
  }

  /**
   * The start menu, and the screen every other one is opened from (§20.33).
   *
   * It is handed a session rather than opening one, because the menu's own counters
   * (`runs`, and the disagreements in them) have to be readable *before* a run is chosen —
   * and because a scan can replace the database underneath it, at which point this is
   * called again with the fresh connection.
   */
  const showMenu = (menuSession: ReviewSession): void => {
    root.render(
      <StartMenu
        session={menuSession}
        dbPath={databasePath}
        repoRoot={repoRoot}
        preferences={preferences}
        runScan={runScan}
        onScanFinished={() => {
          const refreshed = reopen()
          // A reopen that failed leaves the menu with the session it has. Its own rows
          // then say what that database holds, which is more useful than an error over a
          // screen that still works.
          if (!refreshed.ok) return
          sessions.push(refreshed.session)
          showMenu(refreshed.session)
        }}
        onOpenReview={(runId) => void showReview(runId)}
        onExit={() => leave(0)}
      />,
    )
  }

  // The menu is the command now: a scan, the files, or the run to resume. `--run` still
  // names a queue to open, so a scripted invocation is unchanged — it just skips the menu
  // rather than being the only thing the command could do.
  if (args.runId !== undefined) {
    if (!(await showReview(args.runId))) {
      // Nothing has been drawn, so a renderer left alive here would be a blank alternate
      // screen holding the process open. The refusal is the whole output.
      leave(1)
      return 1
    }
  } else {
    showMenu(opened.session)
  }

  return 0
}

/** True when this invocation is the `windbreak` subcommand. */
export const isWindbreakInvocation = (argv: readonly string[]): boolean =>
  findWindbreakCommand(argv) !== null
