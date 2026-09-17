import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { scanSummaryLines } from '@codebuff/windbreak/scan'

import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { wrapToVisualLines } from '../utils/text-layout'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { KeyEvent } from '@opentui/core'
import type { ScanResult } from '@codebuff/windbreak/scan'
import type { ChatTheme } from '../types/theme-system'
import type { ScanSubject } from '../windbreak/subject'

/**
 * The scan, on screen, while it runs (§20.33's first row, re-homed onto Freebuff's TUI).
 *
 * Three things it does that a batch command cannot. It **streams the run's own log** — the
 * same channel `windbreak scan` pipes to `console.log`, so there is one account of what
 * happened and not a second summariser beside it. It **keeps the summary** when the run
 * lands, because a finished scan's summary is its only record of its warnings and of whether
 * `0 candidates` means clean or unswept. And it **names the subject before the wait**: the
 * checkout, the database the run goes into, the config that chose that database, and the
 * budget — including that an overrun is decided here rather than prompted, which is a spend
 * nobody agreed to if the screen does not say it.
 *
 * A pure view over a state it is handed. The run belongs to
 * `windbreak-scan-screen.tsx`, which is what makes this testable without a launcher and
 * keeps a scan from being able to start inside a render.
 */

export type WindbreakScanState =
  | { phase: 'refused'; reason: string }
  /** `droppedLines` counts what the run printed before the log's own window: §18 says a
   *  shorter log must not read as a quieter run, so the loss is stated where the log is. */
  | { phase: 'running'; lines: readonly string[]; droppedLines: number }
  | { phase: 'done'; result: ScanResult }

export interface WindbreakScanViewProps {
  /** The checkout the session is about. Shown even when no subject could be resolved. */
  repoRoot: string
  /** Null when the config could not be read — the header then says so rather than guessing. */
  subject: ScanSubject | null
  state: WindbreakScanState
  onClose: () => void
  /** Continue the run on screen from its first incomplete stage. */
  onResume: () => void
}

/**
 * Which line earns which colour.
 *
 * A heuristic over the summary's own text, and deliberately no more than that: the facts come
 * from `scan/summary.ts`, and re-deriving them here into a richer shape would be the second
 * summariser this view exists to avoid. Wrapping is per line so a wrapped continuation keeps
 * its line's tone — a warning must not lose its colour halfway down.
 */
const toneOf = (line: string, theme: ChatTheme): string => {
  if (line.startsWith('BLOCKED:')) return theme.error
  if (line.startsWith('warning:') || line.startsWith('WARN:')) return theme.warning
  if (line.startsWith('OK:')) return theme.success
  return theme.foreground
}

interface Row {
  text: string
  tone: string
}

/** Wrap a body of logical lines into the rows the terminal will actually print. */
const toRows = (lines: readonly string[], cols: number, theme: ChatTheme): Row[] =>
  lines.flatMap((line) => {
    // A blank line is a row of its own: `wrapToVisualLines` reports no rows for empty text,
    // which is right for a stream and wrong for layout.
    const wrapped = line === '' ? [''] : wrapToVisualLines(line, cols)
    return wrapped.map((text) => ({ text, tone: toneOf(line, theme) }))
  })

interface HeaderRow {
  label: string
  value: string
  tone: string
}

const headerRows = (
  repoRoot: string,
  subject: ScanSubject | null,
  theme: ChatTheme,
): HeaderRow[] => {
  const rows: HeaderRow[] = [
    { label: 'repository', value: repoRoot, tone: theme.foreground },
  ]

  if (subject === null) {
    rows.push({ label: 'database', value: 'not resolved', tone: theme.muted })
    rows.push({ label: 'config', value: 'could not be read', tone: theme.error })
    return rows
  }

  rows.push({ label: 'database', value: subject.dbPath, tone: theme.foreground })
  rows.push({
    label: 'config',
    value: subject.configPath ?? 'built-in defaults',
    tone: subject.configPath ? theme.foreground : theme.muted,
  })
  // Two rows rather than one long one, because the half that matters is the half a narrow
  // terminal would cut: a truncated disclosure is not a disclosure. The second row carries an
  // empty label, which the column pads, so it lines up under the value it continues.
  rows.push({
    label: 'budget',
    value: `${subject.budgetSeconds}s — an overrun is decided here, not prompted`,
    tone: theme.foreground,
  })
  rows.push({
    label: '',
    value: '(this screen owns stdin, so a prompt would hang the run)',
    tone: theme.muted,
  })

  // `windbreak scan` in this directory would follow the config; this view does not, so the
  // difference is named rather than left to be discovered from the results.
  if (subject.configuredTarget && subject.configuredTarget !== subject.targetRoot) {
    rows.push({
      label: 'note',
      value: `the config's target is ${subject.configuredTarget}; this scan reads the repository above`,
      tone: theme.warning,
    })
  }

  return rows
}

// One string per paragraph: the view wraps at the width the terminal actually has, and copy that
// was already broken by hand would be broken a second time — mid-clause, which reads as a
// rendering fault rather than as prose.
const refusalLines = (reason: string): string[] => [
  '',
  'The scan was not started.',
  '',
  reason,
  '',
  'Nothing about the target has been claimed either way: no candidates were swept and no run was recorded here. Fix what the message names and run /scan again.',
]

export const WindbreakScanView: React.FC<WindbreakScanViewProps> = ({
  repoRoot,
  subject,
  state,
  onClose,
  onResume,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const [scroll, setScroll] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const body = useMemo<readonly string[]>(() => {
    if (state.phase === 'running') {
      if (state.lines.length === 0) return ['starting…']
      return state.droppedLines === 0
        ? [...state.lines]
        : [
            `… ${state.droppedLines} earlier line(s) of this run's log are not kept here;`,
            'the summary that follows a finished run is the record, and it is complete.',
            '',
            ...state.lines,
          ]
    }
    if (state.phase === 'refused') return refusalLines(state.reason)
    return scanSummaryLines(state.result)
  }, [state])

  const header = useMemo(
    () => headerRows(repoRoot, subject, theme),
    [repoRoot, subject, theme],
  )

  // Two border rows, one divider, one hint row, and room for both scroll indicators. Reserved
  // rather than measured so the body does not jump when an indicator appears. The view is the
  // whole surface, so it is the thing that knows how much of the terminal it has.
  const rows = Math.max(3, terminalHeight - header.length - 5)
  // Two border columns and two padding columns come out of the content width.
  const cols = Math.max(20, terminalWidth - 4)
  const all = useMemo(() => toRows(body, cols, theme), [body, cols, theme])

  // `scroll` counts rows hidden *below* the window, so 0 is pinned to the newest row.
  const maxScroll = Math.max(0, all.length - rows)
  const clamped = Math.min(scroll, maxScroll)
  const end = all.length - clamped
  const start = Math.max(0, end - rows)
  const visible = all.slice(start, end)

  const running = state.phase === 'running'
  const resumable = state.phase === 'done' && state.result.resumeFrom !== null

  // Where the window opens is a property of what is in it. A running log is read from its
  // newest row, because that is the part that is moving; a summary that has landed is read
  // from its **top**, because those first lines are which run this was and how it ended — a
  // view that opened at the bottom would show the tail of the stage table before it said the
  // run's name. Clamped to the top by the render, so "as far up as possible" is safe to ask for.
  useEffect(() => {
    setScroll(state.phase === 'running' ? 0 : Number.MAX_SAFE_INTEGER)
  }, [state.phase])

  const handleKey = useCallback(
    (key: KeyEvent) => {
      switch (key.name) {
        case 'up':
        case 'k':
          setNotice(null)
          setScroll(Math.min(maxScroll, clamped + 1))
          return
        case 'down':
        case 'j':
          setNotice(null)
          setScroll(Math.max(0, clamped - 1))
          return
        case 'pageup':
          setNotice(null)
          setScroll(Math.min(maxScroll, clamped + rows))
          return
        case 'pagedown':
          setNotice(null)
          setScroll(Math.max(0, clamped - rows))
          return
        case 'r':
          if (!resumable) return
          setNotice(null)
          onResume()
          return
        case 'escape':
          // A scan in flight owns this screen. Leaving it would hand the terminal back to the
          // chat while the run kept writing to a callback nothing renders — the summary and the
          // warnings would be lost, which is the one thing §20.33 keeps it for. So Esc says why
          // instead of pretending to be a cancel: `launchScan` has no cancel, and a key that
          // looked like one would be worse than no key.
          if (running) {
            setNotice(
              'the scan is in this process, so it ends on its own — esc leaves once it lands',
            )
            return
          }
          onClose()
          return
        default:
          return
      }
    },
    [clamped, maxScroll, onClose, onResume, resumable, rows, running],
  )

  useKeyboard(handleKey)

  const hint = running
    ? '↑↓ scroll · esc is refused while it runs · the run keeps going'
    : resumable
      ? `↑↓ scroll · r continue from ${state.phase === 'done' ? state.result.resumeFrom : ''} · esc back to chat`
      : '↑↓ scroll · esc back to chat'

  return (
    <box
      title=" WindBreak scan "
      titleAlignment="center"
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.border,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {header.map((row, index) => (
        <text key={`${index}-${row.label}`} style={{ wrapMode: 'none' }}>
          <span style={{ fg: theme.muted }}>{row.label.padEnd(11)}</span>
          <span style={{ fg: row.tone }}>{row.value}</span>
        </text>
      ))}

      <text style={{ fg: theme.border }}>{'─'.repeat(Math.max(1, cols))}</text>

      {start > 0 && (
        <text style={{ fg: theme.muted }}>{`  ↑ ${start} more row(s)`}</text>
      )}

      {visible.map((row, index) => (
        <text key={`${start + index}`} style={{ fg: row.tone, wrapMode: 'none' }}>
          {row.text === '' ? ' ' : row.text}
        </text>
      ))}

      {end < all.length && (
        <text style={{ fg: theme.muted }}>{`  ↓ ${all.length - end} more row(s)`}</text>
      )}

      {notice && <text style={{ fg: theme.warning }}>{notice}</text>}

      <text style={{ fg: theme.muted }}>{hint}</text>
    </box>
  )
}
