/**
 * The start menu's text (spec §20.33).
 *
 * Kept out of the component for the reason `codebase-lines.ts` and `detail-lines.ts` are:
 * this is the part that can be *wrong*. A menu is a promise about what pressing a key
 * will do, and the two ways it goes wrong are both checkable without a renderer — offering
 * a choice that cannot be taken (a scan with no checkout) and *not* offering one that can.
 *
 * ## What the menu says about itself
 *
 * Three facts decide what is on offer, and each is stated rather than inferred from which
 * rows are missing: the repository the command resolved, the database it will read (or
 * that there is none), and how many runs that database holds. A researcher who ran
 * `windbreak` in the wrong directory sees that before choosing anything, which is the same
 * reason §20.31's loading frame names its subject.
 *
 * ## Nothing is hidden for being empty
 *
 * A row is offered whenever the action is *possible*, even when it would show nothing, and
 * the screen behind it says which nothing that is. §18's rule reaches a menu: hiding
 * "resume a previous run" because the database holds no runs would leave a researcher
 * unable to tell an empty database from a missing one — and the database with no runs is
 * the one a scan is about to fill. Only an action that cannot be taken at all is refused,
 * and then the row stays on screen with its reason under it.
 */

import { formatLanguageCoverage } from '@codebuff/windbreak/scan'

import { shortenPath } from './text'

import type { CodebaseLine } from './codebase-lines'
import type { ReviewRunSummary } from '@codebuff/windbreak/review'
import type { ScanResult, ScanStageId } from '@codebuff/windbreak/scan'

/** The three things `windbreak` can be asked to do before the dashboard opens. */
export type MenuChoice = 'scan' | 'files' | 'runs'

export interface MenuEntry {
  choice: MenuChoice
  label: string
  description: string
  /** Why this row cannot be taken, or null when it can. */
  disabledReason: string | null
}

export interface MenuInput {
  /** The repository the command resolved, or null when there is none to work in. */
  repoRoot: string | null
  /** True when the queue's database exists on disk. */
  hasDatabase: boolean
  /** Disagreements across every run, for the `runs` row's description. */
  pendingDisagreements: number
  runCount: number
  /** True when the file listing has something to draw (a target, or a walkable root). */
  hasCodebase: boolean
}

/**
 * The three rows, in the order they are offered.
 *
 * Scan first because it is the only one that *creates* facts — the other two read what a
 * scan produced — and a researcher who has just discovered this tool has nothing to read
 * yet.
 */
export const buildMenuEntries = (input: MenuInput): MenuEntry[] => [
  {
    choice: 'scan',
    label: 'Run a scan on this repo',
    description:
      input.repoRoot === null
        ? 'no checkout to scan'
        : `recon → engines → OSV → triage → verification → report, in ${shortenPath(input.repoRoot)}`,
    disabledReason:
      input.repoRoot === null
        ? 'WindBreak was started without a directory to scan. Run it inside a checkout.'
        : null,
  },
  {
    choice: 'files',
    label: 'Files / codebase browser',
    description: input.hasCodebase
      ? 'the files this repository holds, and which of them a scan indexed'
      : 'no codebase to list',
    disabledReason: input.hasCodebase
      ? null
      : 'There is neither a scanned target nor a directory to walk.',
  },
  {
    choice: 'runs',
    label: 'Resume a previous run',
    description: !input.hasDatabase
      ? 'no state database here yet — a scan creates one'
      : input.runCount === 0
        ? 'this database holds no runs yet'
        : `${countLabel(input.runCount, 'run')} · ${countLabel(
            input.pendingDisagreements,
            'undecided disagreement',
          )}`,
    // Never refused. `runs` is the way to see what a database holds, and a screen that
    // says "this database has no runs in it" is a different statement from a row that is
    // not there — see the header's note.
    disabledReason: null,
  },
]

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`

/** The two lines above the rows: what this command resolved. */
export const buildMenuHeaderLines = (input: {
  repoRoot: string | null
  dbPath: string
  hasDatabase: boolean
}): CodebaseLine[] => [
  { text: `WindBreak · the queue surface (spec §5.3)`, tone: 'muted' },
  {
    text: `repository: ${input.repoRoot ?? '(none — this directory is not in a checkout)'}`,
    tone: input.repoRoot === null ? 'warning' : 'normal',
  },
  {
    text: input.hasDatabase
      ? `database:   ${input.dbPath}`
      : `database:   ${input.dbPath} — does not exist yet; a scan creates it`,
    tone: input.hasDatabase ? 'normal' : 'warning',
  },
]

/**
 * The menu, as lines: the header it resolved, then one row per choice.
 *
 * A refused row keeps its label, its description and its reason — three lines instead of
 * two, which is the whole reason the pane takes rows with different heights rather than a
 * fixed-height list.
 */
export const buildMenuLines = (input: {
  header: readonly CodebaseLine[]
  entries: readonly MenuEntry[]
}): RunsLine[] => {
  const lines: RunsLine[] = input.header.map((line) => ({ ...line, row: -1 }))
  lines.push({ row: -1, text: '', tone: 'muted' })

  input.entries.forEach((entry, index) => {
    lines.push({
      row: index,
      text: entry.label,
      tone: entry.disabledReason === null ? 'normal' : 'muted',
    })
    lines.push({ row: index, text: `  ${entry.description}`, tone: 'muted' })
    if (entry.disabledReason !== null) {
      lines.push({ row: index, text: `  ${entry.disabledReason}`, tone: 'warning' })
    }
  })

  return lines
}

export const MENU_HINT = '↑↓/jk choose · enter select · q quit'

/** `↑↓/jk choose · enter select · q quit`, shortened as the terminal narrows. */
export const buildMenuHintLine = (columns: number): string => {
  const tiers = [MENU_HINT, '↑↓/jk · enter select · q']
  const usable = Math.max(1, columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

export const RUNS_HINT = '↑↓/jk choose · enter open · r resume scan · esc back · q quit'

export const buildRunsHintLine = (columns: number, canResume: boolean): string => {
  const resume = canResume ? ' · r resume scan' : ''
  const tiers = [
    `↑↓/jk choose · enter open${resume} · esc back · q quit`,
    `↑↓/jk · enter open${resume} · esc back · q`,
    `↑↓/jk · enter${resume} · esc · q`,
  ]
  const usable = Math.max(1, columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

const runCounts = (run: ReviewRunSummary): string => {
  const pending = run.queued - run.resolved
  if (run.queued === 0) return 'no disagreements to review'
  return `${countLabel(run.queued, 'disagreement')} · ${pending} undecided`
}

/**
 * A run's status, in the researcher's terms.
 *
 * `complete` is the run's own word and is kept; every other recorded status — `partial`,
 * `aborted`, `failed`, and the `running` a killed scan leaves behind — reads as
 * *incomplete* because that is the fact the list is used for: a scan left mid-way is one
 * `r` can continue, and calling it "running" would claim a process that no longer exists.
 */
export const describeRunStatus = (status: string): string =>
  status === 'complete' ? 'complete' : 'incomplete — resumable'

/**
 * A line of the runs screen, tagged with the row it belongs to.
 *
 * A run needs two lines — where it was pinned and what it holds — and the selection is a
 * *row*, not a line. Carrying the row lets the pane highlight both lines of the selected
 * run and scroll to the right place without knowing how the list is laid out.
 */
export type RunsLine = CodebaseLine & { row: number }

/**
 * The runs screen: a row for the whole database, then one per run.
 *
 * The first row is not a run and is labelled as what it is, because the researcher's
 * question is often "what needs deciding anywhere" rather than "which run". It is also the
 * only row that works without knowing a run id, which is what a `--db` pointed at a
 * colleague's database needs.
 */
export const buildRunsLines = (input: {
  runs: readonly ReviewRunSummary[]
  /** Index 0 is the "every disagreement" row; runs start at 1. */
  selectedIndex: number
}): RunsLine[] => {
  const pending = input.runs.reduce((sum, run) => sum + (run.queued - run.resolved), 0)
  const lines: RunsLine[] = [
    {
      row: 0,
      text:
        `every disagreement · ${countLabel(pending, 'undecided disagreement')} across ` +
        `${countLabel(input.runs.length, 'run')}`,
      tone: pending > 0 ? 'normal' : 'muted',
    },
  ]

  if (input.runs.length === 0) {
    lines.push(
      { row: -1, text: '', tone: 'muted' },
      {
        row: -1,
        text: 'This database holds no runs. A scan writes the first one.',
        tone: 'warning',
      },
    )
    return lines
  }

  input.runs.forEach((run, index) => {
    const row = index + 1
    const where =
      run.targetLocation === null
        ? '(checkout not recorded)'
        : shortenPath(run.targetLocation, 2)
    // The short id, because that is what the run's own output printed and what a
    // researcher quotes back — the full id is in the database, not in a 40-column column.
    lines.push({
      row,
      text: `${run.runId.slice(0, 12)} · ${where} · ${run.commitSha.slice(0, 8)}`,
      tone: run.status === 'complete' ? 'normal' : 'warning',
    })
    lines.push({
      row,
      text: `  ${describeRunStatus(run.status)} · ${runCounts(run)}${
        run.startedAt === null ? '' : ` · started ${run.startedAt}`
      }`,
      tone: 'muted',
    })
  })

  return lines
}

/** The row a selected index maps to, for the runs screen's window. */
export const runsRows = (runs: readonly ReviewRunSummary[]): number => runs.length + 1

export const FILES_HINT = '↑↓/jk scroll · PgUp/PgDn page · esc back · q quit'

export const buildFilesHintLine = (columns: number): string => {
  const tiers = [FILES_HINT, '↑↓/jk · PgUp/PgDn · esc back · q']
  const usable = Math.max(1, columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

/**
 * The stage the run is in, read from the run's own log.
 *
 * `runScan` announces each stage as `[scan] <id> (spec)`, so the last such line *is* the
 * stage — no second source is consulted, and the screen cannot claim a stage the run never
 * entered. Everything else in the stream is the stage's own output.
 *
 * Returns null before the first announcement, which is the gap between pressing the key
 * and the run recording its first stage: a screen that said "ingestion" there would be
 * describing something it had not seen start.
 */
export const deriveScanStage = (
  log: readonly string[],
  stageIds: readonly ScanStageId[],
): ScanStageId | null => {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const match = /^\[scan\] ([a-z-]+)/.exec(log[index]!)
    if (!match) continue
    const stage = stageIds.find((id) => id === match[1])
    if (stage) return stage
    // `[scan] resuming …` and `[scan] every requested stage …` are announcements too, and
    // neither names a stage — so keep walking back rather than returning nothing.
  }
  return null
}

export const SCAN_HINT = '↑↓/jk scroll · q leave (the run is resumable)'
export const SCAN_DONE_HINT = '↑↓/jk scroll · esc/q leave · enter open the queue'

export const buildScanHintLine = (columns: number, done: boolean): string => {
  const tiers = done
    ? [SCAN_DONE_HINT, '↑↓/jk · enter queue · esc leave']
    : [SCAN_HINT, '↑↓/jk scroll · q leave']
  const usable = Math.max(1, columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

/** The lines above the log while a scan runs. */
export const buildScanHeaderLines = (input: {
  repoRoot: string | null
  dbPath: string
  /** True when this is `resume` for an existing run rather than a new scan. */
  resuming: string | null
  /** The stage the run last announced, if it has announced one. */
  stage: ScanStageId | null
  elapsedMs: number
}): CodebaseLine[] => [
  {
    text: input.resuming === null
      ? `scanning ${input.repoRoot ?? '(unknown checkout)'}`
      : `resuming run ${input.resuming} · ${input.repoRoot ?? '(unknown checkout)'}`,
    tone: 'normal',
  },
  {
    text: `${input.stage === null ? 'starting' : input.stage} · ${formatElapsed(
      input.elapsedMs,
    )} · ${input.dbPath}`,
    tone: 'muted',
  },
  { text: '', tone: 'muted' },
]

export const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * The scan's own summary, once it stops.
 *
 * The same facts the batch command prints, and deliberately the same words for the counts:
 * a researcher comparing a TUI scan with a CLI one must not have to translate between two
 * vocabularies for the same run. §20.24.5's coverage line is included for the reason the
 * batch summary includes it — `0 candidates` must not be the last word on a repository
 * whose callables the C-shaped tables never reached.
 */
export const buildScanSummaryLines = (
  result: ScanResult,
  options: { maxLogLines?: number } = {},
): CodebaseLine[] => {
  const lines: CodebaseLine[] = [
    {
      text:
        result.status === 'complete'
          ? `scan complete · run ${result.runId}`
          : `scan ${result.status} · run ${result.runId}`,
      tone: result.status === 'complete' ? 'normal' : 'warning',
    },
    { text: '', tone: 'muted' },
    { text: 'stages:', tone: 'muted' },
  ]

  for (const stage of result.stages) {
    const seconds = `${(stage.durationMs / 1000).toFixed(1)}s`.padStart(8)
    lines.push({
      text: `  ${stage.stage.padEnd(15)} ${stage.status.padEnd(9)} ${seconds}  ${
        stage.detail ?? stage.reason ?? ''
      }`,
      tone: stage.status === 'complete' ? 'normal' : 'warning',
    })
  }

  lines.push(
    { text: '', tone: 'muted' },
    { text: 'candidates:', tone: 'muted' },
    { text: `  from discovery             ${result.counts.candidates}`, tone: 'normal' },
    { text: `    of which patch-mined     ${result.counts.patchMined}`, tone: 'muted' },
    { text: `    of which variant-hunt    ${result.counts.replays}`, tone: 'muted' },
    { text: `  triaged                    ${result.counts.triaged}`, tone: 'normal' },
    { text: `  confirmed                  ${result.counts.confirmed}`, tone: 'normal' },
    { text: `  dropped                    ${result.counts.dropped}`, tone: 'muted' },
    {
      text: `  escalated (needs review)   ${result.counts.escalated}`,
      // The one count that is a call to action, so it is the one that is warned about
      // when it is non-zero: the queue on the other side of `enter` is what it counts.
      tone: result.counts.escalated > 0 ? 'warning' : 'muted',
    },
    { text: '', tone: 'muted' },
    { text: formatLanguageCoverage(result.languageCoverage), tone: 'muted' },
  )

  if (result.report) {
    lines.push(
      { text: '', tone: 'muted' },
      { text: 'report:', tone: 'muted' },
      { text: `  sarif                      ${result.report.sarifPath}`, tone: 'normal' },
      { text: `  index                      ${result.report.indexPath}`, tone: 'muted' },
      { text: `  excluded from the report   ${result.counts.excluded}`, tone: 'muted' },
    )
  }

  for (const warning of result.warnings) {
    lines.push({ text: `warning: ${warning}`, tone: 'warning' })
  }

  if (result.resumeFrom !== null) {
    lines.push(
      { text: '', tone: 'muted' },
      {
        text: `The first incomplete stage is ${result.resumeFrom}; this run can be continued.`,
        tone: 'warning',
      },
    )
  }

  return lines
}

/** Where the scan's log tail ends, for a pane that follows the newest line. */
export const scanOffsetToFollow = (lineCount: number, height: number): number =>
  Math.max(0, lineCount - Math.max(1, height))
