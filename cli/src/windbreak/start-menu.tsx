/**
 * The start menu (spec §20.33).
 *
 * `windbreak` used to open §5.3's queue and nothing else, which made the command a
 * *destination*: the only way to scan, or to look at the files, or to reach the run you
 * interrupted yesterday, was to leave the TUI and type a batch command whose output
 * scrolled away. This screen is the passage instead: what this checkout can be asked for,
 * with each answer saying what it is about before it is chosen.
 *
 * ## It says what it resolved, first
 *
 * The header names the repository and the database before any row is offered. Those two
 * are what a researcher gets wrong — running the command one directory too high, or beside
 * a database from another checkout — and both are cheap to state and expensive to discover
 * after a scan.
 *
 * ## A scan runs here, not behind the screen
 *
 * `runScan` is called in this process with a `log` callback, so the run streams into the
 * pane instead of into a child process. That is §20.33's choice and it has one consequence
 * worth naming: while the scan runs, this screen *is* the run, so leaving it means
 * quitting the command. The run that got as far as it got stays in the state database,
 * which is what makes `r` on the runs screen a continuation rather than a restart.
 *
 * ## Nothing is hidden for being empty
 *
 * The rows are the three things a checkout can be asked for, and a row that cannot be taken
 * stays on screen with its reason under it rather than disappearing — the same rule §18
 * applies to a report, applied to a menu. A row that vanished would leave a researcher
 * unable to tell "this database holds no runs" from "this tool cannot do that".
 */

import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { BORDER_CHARS } from '../utils/ui-constants'

import { WHEEL_ROWS } from './actions'
import { buildCodebaseLines, type CodebaseLine, type CodebaseTone } from './codebase-lines'
import { CodebasePane } from './codebase-pane'
import { WindbreakColorsProvider, useWindbreakColors } from './colors-context'
import { PANE_FRAME_ROWS } from './layout'
import { resolveMenuAction, type MenuScreen } from './menu-actions'
import {
  buildFilesHintLine,
  buildMenuEntries,
  buildMenuHeaderLines,
  buildMenuHintLine,
  buildMenuLines,
  buildRunsHintLine,
  buildRunsLines,
  buildScanHeaderLines,
  buildScanHintLine,
  buildScanSummaryLines,
  deriveScanStage,
  runsRows,
  scanOffsetToFollow,
} from './menu-lines'
import { resolveWindbreakColors, type WindbreakColors } from './theme'

import type { RunsLine } from './menu-lines'
import type { WindbreakPreferences } from './preferences'
import type { KeyEvent, MouseEvent } from '@opentui/core'
import { SCAN_STAGE_IDS } from '@codebuff/windbreak/scan'
import type { ReviewRunSummary, ReviewSession } from '@codebuff/windbreak/review'
import type { LaunchScanOutcome, ScanResult, ScanStageId } from '@codebuff/windbreak/scan'

/** The scan, as the screen drives it. Injected in tests, where there is no pipeline. */
export type ScanRunner = (options: {
  runId?: string | undefined
  log: (line: string) => void
}) => Promise<LaunchScanOutcome>

/**
 * How many log lines are kept.
 *
 * A cap rather than a growing array because a scan's log is unbounded — engines and the
 * sandboxed build both stream — and a pane that follows the newest line never reads the
 * beginning anyway. The number is generous enough that the whole of an ordinary run's
 * output survives scrolling back.
 */
const SCAN_LOG_CAP = 2000

/** How often buffered log lines reach React. See `pushScanLog`. */
const SCAN_FLUSH_MS = 100

type ScanRun =
  | { phase: 'running'; resuming: string | null; startedAt: number }
  | { phase: 'done'; resuming: string | null; startedAt: number; elapsedMs: number; result: ScanResult }
  | { phase: 'failed'; resuming: string | null; startedAt: number; elapsedMs: number; reason: string }

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

/**
 * The first visible line that keeps a chosen row on screen.
 *
 * Derived rather than stored, because the two lists that use it (the menu and the runs)
 * have rows of different heights: a cursor moved one row down can move the view by three
 * lines, and a stored offset would have to be reconciled with a layout change on every
 * resize. The row is placed a third of the way down instead of at the top, so there is
 * context above it.
 */
export const offsetForRow = (
  lines: readonly { row: number }[],
  row: number,
  height: number,
): number => {
  const first = lines.findIndex((line) => line.row === row)
  if (first < 0) return 0
  const max = Math.max(0, lines.length - height)
  return clamp(first - Math.floor(height / 3), 0, max)
}

interface StartMenuProps {
  session: ReviewSession
  /** Where the queue was read from, shown in the header. */
  dbPath: string
  /** The checkout this command resolved, or null when there is none (§20.31). */
  repoRoot: string | null
  preferences: WindbreakPreferences
  /** Omitted in tests that only render; the scan row is then refused with a reason. */
  runScan?: ScanRunner | undefined
  /**
   * Called once a scan has written a run.
   *
   * The caller reopens the session so the menu's own counts include the run that was just
   * written — and so does the *resume* list, which is the one that would otherwise be a
   * stale answer to "which runs are there".
   */
  onScanFinished?: ((runId: string) => void) | undefined
  /** Open §5.3's queue; null means every disagreement in the database. */
  onOpenReview: (runId: string | null) => void
  onExit: () => void
}

/** One row of a pane, with the logical row it belongs to for selection. */
type RowLine = CodebaseLine & { row?: number }

const toneColor = (tone: CodebaseTone, colors: WindbreakColors): string => {
  switch (tone) {
    case 'normal':
      return colors.codebaseFileText
    case 'info':
      return colors.codebaseDirText
    case 'muted':
      return colors.codebaseMetaText
    case 'warning':
      return colors.warningText
  }
}

/**
 * A scrolling pane of pre-built lines, with an optional selected row.
 *
 * Local rather than shared with `CodebasePane`, because the two differ in exactly the thing
 * this screen needs: a selection. The file listing has no cursor — it is read, not chosen
 * from — so the pane that draws it spends its cursor column on the file tree's indentation
 * instead.
 */
const LinesPane: React.FC<{
  title: string
  lines: readonly RowLine[]
  offset: number
  /** Content rows, border excluded. */
  height: number
  /** Columns, border excluded. A number rather than `'100%'`: the box's own width type
   * takes a template literal, and a pane that straddles the screen is what `columns`
   * already is. */
  width: number
  selectedRow: number | null
  onScroll: (delta: number) => void
}> = ({ title, lines, offset, height, width, selectedRow, onScroll }) => {
  const colors = useWindbreakColors()
  const visible = lines.slice(offset, offset + height)

  return (
    <box
      title={title}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction
        if (direction !== 'up' && direction !== 'down') return
        onScroll(direction === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)
      }}
      style={{
        width,
        height: height + 2,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: colors.frame,
        titleColor: colors.title,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {visible.map((line, index) => {
        const isFirstOfRow =
          line.row !== undefined &&
          line.row >= 0 &&
          (index === 0 || visible[index - 1]!.row !== line.row)
        const isSelected =
          selectedRow !== null && line.row === selectedRow && line.row !== undefined
        return (
          <text
            key={offset + index}
            style={{
              fg: isSelected ? colors.queueSelectedFg : toneColor(line.tone, colors),
              bg: isSelected ? colors.queueSelectedBg : undefined,
            }}
          >
            {isSelected && isFirstOfRow ? '❯ ' : '  '}
            {line.text}
          </text>
        )
      })}
    </box>
  )
}

/** The tone a raw scan log line is drawn in. */
const logLineTone = (text: string): CodebaseTone => {
  if (text.startsWith('warning:') || text.startsWith('error')) return 'warning'
  // `runScan` announces each stage as `[scan] <id>`, which is the run's own progress
  // report rather than a stage's output.
  if (text.startsWith('[scan]')) return 'info'
  return 'muted'
}

export const StartMenu: React.FC<StartMenuProps> = ({
  session,
  dbPath,
  repoRoot,
  preferences,
  runScan,
  onScanFinished,
  onOpenReview,
  onExit,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const width = '100%'
  const columns = Math.max(40, terminalWidth)
  const body = Math.max(0, terminalHeight - 2)
  const paneRows = Math.max(1, body - PANE_FRAME_ROWS)

  const colors = useMemo(
    () => resolveWindbreakColors(theme, preferences.theme, preferences.colors),
    [theme, preferences.theme, preferences.colors],
  )

  const [screen, setScreen] = useState<MenuScreen>('menu')
  const [menuIndex, setMenuIndex] = useState(0)
  const [runsIndex, setRunsIndex] = useState(0)
  const [filesOffset, setFilesOffset] = useState(0)

  const [scan, setScan] = useState<ScanRun | null>(null)
  const [scanLog, setScanLog] = useState<string[]>([])
  const [scanOffset, setScanOffset] = useState(0)
  const [scanFollow, setScanFollow] = useState(true)
  /** Re-rendered once a second while a scan runs, for the elapsed clock. */
  const [clock, setClock] = useState(0)

  // ---- the data the menu describes ----------------------------------------
  //
  // Read per render, not memoised across the component's life: the runs list is what a
  // scan changes, and the session handed back by `onScanFinished` is a different object
  // — a memo keyed by nothing would keep answering with the pre-scan database.
  const runs: ReviewRunSummary[] = useMemo(() => session.runs(), [session])
  const codebase = useMemo(() => session.codebase(null), [session])
  const codebaseLines = useMemo(() => buildCodebaseLines(codebase), [codebase])
  const pendingDisagreements = runs.reduce((sum, run) => sum + (run.queued - run.resolved), 0)

  const entries = useMemo(
    () =>
      buildMenuEntries({
        repoRoot,
        hasDatabase: !session.source.absent,
        pendingDisagreements,
        runCount: runs.length,
        hasCodebase: codebase !== null,
      }),
    [repoRoot, session.source.absent, pendingDisagreements, runs.length, codebase],
  )

  const menuLines: RunsLine[] = useMemo(
    () =>
      buildMenuLines({
        header: buildMenuHeaderLines({
          repoRoot,
          dbPath,
          hasDatabase: !session.source.absent,
        }),
        entries,
      }),
    [repoRoot, dbPath, session.source.absent, entries],
  )

  const runsLines: RunsLine[] = useMemo(
    () => buildRunsLines({ runs, selectedIndex: runsIndex }),
    [runs, runsIndex],
  )

  const selectedRun = runsIndex === 0 ? null : (runs[runsIndex - 1] ?? null)

  const scanLines: RowLine[] = useMemo(() => {
    if (scan === null) return []
    const elapsedMs = scan.phase === 'running' ? Date.now() - scan.startedAt : scan.elapsedMs
    const logLines: RowLine[] = scanLog.map((text) => ({
      text,
      tone: logLineTone(text),
    }))

    if (scan.phase === 'running') {
      return [
        ...buildScanHeaderLines({
          repoRoot,
          dbPath,
          resuming: scan.resuming,
          stage: deriveScanStage(scanLog, SCAN_STAGE_IDS),
          elapsedMs,
        }),
        ...logLines,
      ]
    }

    const head: RowLine[] =
      scan.phase === 'done'
        ? buildScanSummaryLines(scan.result)
        : [
            { text: 'the scan did not finish', tone: 'warning' },
            { text: scan.reason, tone: 'warning' },
            { text: '', tone: 'muted' },
          ]

    return [...head, ...logLines]
  }, [scan, scanLog, repoRoot, dbPath, clock])

  // ---- the scan ------------------------------------------------------------
  /**
   * Buffered, then flushed on a timer.
   *
   * A scan calls `log` for every line it would have printed, and each call landing as its
   * own `setState` would re-render the pane — and re-read the queue's database — for every
   * line. The buffer costs at most [`SCAN_FLUSH_MS`] of latency on the newest line, which
   * nobody can see, and collapses a burst into one render.
   */
  const logBuffer = useRef<string[]>([])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushScanLog = useCallback((line: string) => {
    logBuffer.current.push(line)
    if (logBuffer.current.length > SCAN_LOG_CAP) {
      logBuffer.current.splice(0, logBuffer.current.length - SCAN_LOG_CAP)
    }
    if (flushTimer.current !== null) return
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      setScanLog([...logBuffer.current])
    }, SCAN_FLUSH_MS)
  }, [])

  const clearScanLog = useCallback(() => {
    logBuffer.current = []
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    setScanLog([])
  }, [])

  const startScan = useCallback(
    (resuming: string | null) => {
      if (runScan === undefined) return
      clearScanLog()
      setScanOffset(0)
      setScanFollow(true)
      setScreen('scan')

      const startedAt = Date.now()
      setScan({ phase: 'running', resuming, startedAt })

      // One timer for the elapsed clock, and only while something is running: a stopped
      // scan's duration is `elapsedMs`, so a ticking render would be pure cost.
      const outcome = runScan({
        ...(resuming === null ? {} : { runId: resuming }),
        log: pushScanLog,
      })

      void outcome.then((result) => {
        const elapsedMs = Date.now() - startedAt
        // The buffer is flushed before the summary is composed, because the log is part of
        // what the finished screen shows and a pending timer would otherwise append to a
        // list the researcher had already scrolled to the top of.
        if (flushTimer.current !== null) {
          clearTimeout(flushTimer.current)
          flushTimer.current = null
        }
        setScanLog([...logBuffer.current])

        if (result.ok) {
          setScan({ phase: 'done', resuming, startedAt, elapsedMs, result: result.result })
          // The summary is the first thing worth reading, so the pane stops following and
          // starts at the top — the finished screen reads top-down, unlike the stream.
          setScanFollow(false)
          setScanOffset(0)
          onScanFinished?.(result.result.runId)
        } else {
          setScan({ phase: 'failed', resuming, startedAt, elapsedMs, reason: result.reason })
          setScanFollow(false)
          setScanOffset(0)
        }
      })
    },
    [runScan, clearScanLog, pushScanLog, onScanFinished],
  )

  useEffect(() => {
    if (scan?.phase !== 'running') return
    const timer = setInterval(() => setClock((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [scan?.phase])

  // A pending flush after unmount would set state on a gone component.
  useEffect(
    () => () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current)
    },
    [],
  )

  // ---- navigation ----------------------------------------------------------
  const choose = useCallback(() => {
    if (screen === 'menu') {
      const entry = entries[menuIndex]
      if (!entry || entry.disabledReason !== null) return
      if (entry.choice === 'scan') {
        startScan(null)
        return
      }
      if (entry.choice === 'files') {
        setFilesOffset(0)
        setScreen('files')
        return
      }
      setRunsIndex(0)
      setScreen('runs')
      return
    }

    if (screen === 'runs') {
      onOpenReview(selectedRun === null ? null : selectedRun.runId)
      return
    }
  }, [screen, entries, menuIndex, startScan, onOpenReview, selectedRun])

  const resumeSelected = useCallback(() => {
    if (screen !== 'runs') return
    // Only a run that never finished has anything to continue. The hint row does not offer
    // `r` for a complete run, so this is the second half of the same rule rather than a
    // refusal the researcher can trip.
    if (selectedRun === null || selectedRun.status === 'complete') return
    startScan(selectedRun.runId)
  }, [screen, selectedRun, startScan])

  const scrollScan = useCallback(
    (delta: number) => {
      const max = Math.max(0, scanLines.length - paneRows)
      setScanOffset((offset) => {
        const current = scanFollow ? scanOffsetToFollow(scanLines.length, paneRows) : offset
        const next = clamp(current + delta, 0, max)
        // Scrolling back to the newest line resumes following, so the only way to stop
        // following is to be looking at something else.
        setScanFollow(next >= max)
        return next
      })
    },
    [scanLines.length, paneRows, scanFollow],
  )

  /**
   * Move the selection on the two list screens.
   *
   * The menu skips a row it cannot take, because arrowing onto a refused row and pressing
   * enter would be a key that does nothing twice; the runs list does not skip, because
   * every row there is takeable.
   */
  const moveSelection = useCallback(
    (delta: number) => {
      if (screen === 'menu') {
        setMenuIndex((index) => {
          let next = index
          for (let step = 0; step < entries.length; step += 1) {
            next = (next + delta + entries.length) % entries.length
            if (entries[next]?.disabledReason === null) return next
          }
          return index
        })
        return
      }
      if (screen === 'runs') {
        const total = runsRows(runs)
        setRunsIndex((index) => clamp(index + delta, 0, total - 1))
      }
    },
    [screen, entries, runs],
  )

  const page = useCallback(
    (pages: number) => {
      if (screen === 'scan') {
        scrollScan(pages * Math.max(1, paneRows - 1))
        return
      }
      if (screen === 'files') {
        setFilesOffset((offset) =>
          clamp(offset + pages * Math.max(1, paneRows - 1), 0, Math.max(0, codebaseLines.lines.length - paneRows)),
        )
        return
      }
      moveSelection(pages * Math.max(1, Math.floor(paneRows / 2)))
    },
    [screen, scrollScan, paneRows, codebaseLines.lines.length, moveSelection],
  )

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        const action = resolveMenuAction(key, {
          screen,
          // A stopped scan is one whose screen still has a way back; only a *finished* one
          // has a queue to open, which is why the two are separate facts.
          scanDone: scan !== null && scan.phase !== 'running',
          scanOpenable: scan?.phase === 'done',
        })

        switch (action.type) {
          case 'quit':
            onExit()
            return
          case 'back':
            if (screen === 'scan') {
              setScan(null)
              clearScanLog()
            }
            setScreen('menu')
            return
          case 'select':
            if (screen === 'scan') {
              scrollScan(action.delta * WHEEL_ROWS)
              return
            }
            if (screen === 'files') {
              setFilesOffset((offset) =>
                clamp(offset + action.delta * WHEEL_ROWS, 0, Math.max(0, codebaseLines.lines.length - paneRows)),
              )
              return
            }
            moveSelection(action.delta)
            return
          case 'page':
            page(action.pages)
            return
          case 'choose':
            choose()
            return
          case 'resume-run':
            resumeSelected()
            return
          case 'open-queue':
            if (scan?.phase === 'done') onOpenReview(scan.result.runId)
            return
          case 'none':
            return
        }
      },
      [
        screen,
        scan,
        onExit,
        clearScanLog,
        scrollScan,
        moveSelection,
        page,
        choose,
        resumeSelected,
        onOpenReview,
        codebaseLines.lines.length,
        paneRows,
      ],
    ),
  )

  // ---- what is drawn -------------------------------------------------------
  const menuRow = entries[menuIndex]?.disabledReason === null ? menuIndex : null

  const scanStage: ScanStageId | null =
    scan === null ? null : deriveScanStage(scanLog, SCAN_STAGE_IDS)

  const hint =
    screen === 'menu'
      ? buildMenuHintLine(columns)
      : screen === 'runs'
        ? buildRunsHintLine(columns, selectedRun !== null && selectedRun.status !== 'complete')
        : screen === 'files'
          ? buildFilesHintLine(columns)
          : buildScanHintLine(columns, scan?.phase === 'done')

  const headerMeta =
    screen === 'menu'
      ? `  ${repoRoot ?? '(no checkout)'}`
      : screen === 'runs'
        ? `  runs · ${dbPath}`
        : screen === 'files'
          ? `  files · ${codebase?.location ?? '(none)'}`
          : `  scan · ${dbPath}`

  let pane: React.ReactNode = null
  if (screen === 'menu') {
    pane = (
      <LinesPane
        title=" WindBreak "
        lines={menuLines}
        offset={offsetForRow(menuLines, menuIndex, paneRows)}
        height={paneRows}
        width={columns}
        selectedRow={menuRow}
        onScroll={(delta) => moveSelection(delta)}
      />
    )
  } else if (screen === 'runs') {
    pane = (
      <LinesPane
        title={` Resume a previous run — ${runs.length} `}
        lines={runsLines}
        offset={offsetForRow(runsLines, runsIndex, paneRows)}
        height={paneRows}
        width={columns}
        selectedRow={runsIndex}
        onScroll={(delta) => moveSelection(delta)}
      />
    )
  } else if (screen === 'files') {
    pane = (
      <CodebasePane
        lines={codebaseLines.lines}
        offset={clamp(filesOffset, 0, Math.max(0, codebaseLines.lines.length - paneRows))}
        height={paneRows}
        width={columns}
        onScroll={(delta) =>
          setFilesOffset((offset) =>
            clamp(offset + delta, 0, Math.max(0, codebaseLines.lines.length - paneRows)),
          )
        }
        location={codebase?.location ?? null}
      />
    )
  } else {
    pane = (
      <LinesPane
        title={
          scan?.phase === 'running'
            ? ` Scan — ${scanStage ?? 'starting'} `
            : ' Scan '
        }
        lines={scanLines}
        offset={
          scanFollow
            ? scanOffsetToFollow(scanLines.length, paneRows)
            : clamp(scanOffset, 0, Math.max(0, scanLines.length - paneRows))
        }
        height={paneRows}
        width={columns}
        selectedRow={null}
        onScroll={scrollScan}
      />
    )
  }

  return (
    <WindbreakColorsProvider colors={colors}>
      <box style={{ width, height: '100%', flexDirection: 'column' }}>
        <box style={{ flexDirection: 'row', width, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: colors.headerText }}>WindBreak</text>
          <text style={{ fg: colors.headerMeta }}>{headerMeta}</text>
        </box>

        {pane}

        <box style={{ flexDirection: 'row', width, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: colors.hintsText }}>{hint}</text>
        </box>
      </box>
    </WindbreakColorsProvider>
  )
}
