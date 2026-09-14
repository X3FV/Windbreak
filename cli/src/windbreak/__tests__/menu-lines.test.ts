import { describe, expect, test } from 'bun:test'

import { EMPTY_COUNTS, formatLanguageCoverage } from '@codebuff/windbreak/scan'

import {
  buildMenuEntries,
  buildMenuHeaderLines,
  buildMenuLines,
  buildRunsLines,
  buildScanSummaryLines,
  deriveScanStage,
  describeRunStatus,
  scanOffsetToFollow,
} from '../menu-lines'

import type { ReviewRunSummary } from '@codebuff/windbreak/review'
import type { ScanResult, ScanStageId } from '@codebuff/windbreak/scan'

const text = (lines: readonly { text: string }[]): string =>
  lines.map((line) => line.text).join('\n')

const run = (overrides: Partial<ReviewRunSummary> = {}): ReviewRunSummary => ({
  runId: 'run-1',
  targetId: 't1',
  targetLocation: '/repo/a',
  commitSha: 'abc12345',
  startedAt: '2026-09-13T10:00:00Z',
  finishedAt: '2026-09-13T10:20:00Z',
  status: 'complete',
  queued: 2,
  resolved: 1,
  ...overrides,
})

const EMPTY_COVERAGE = {
  sweptCallables: 0,
  partiallySweptCallables: 0,
  unsweptCallables: 0,
  languages: [],
}

const EMPTY_STAGE_IDS: readonly ScanStageId[] = []

const scanResult = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  runId: 'run-7',
  targetId: 't1',
  commitSha: 'abc123',
  status: 'complete',
  stages: [
    {
      stage: 'ingestion',
      status: 'complete',
      durationMs: 1200,
      detail: '120 files',
      counts: {},
      reason: null,
    },
    {
      stage: 'static-core',
      status: 'partial',
      durationMs: 800,
      detail: null,
      counts: {},
      reason: 'no rule files',
    },
  ],
  counts: { ...EMPTY_COUNTS, candidates: 3, escalated: 2 },
  resumeFrom: null,
  report: null,
  languageCoverage: EMPTY_COVERAGE,
  warnings: [],
  ...overrides,
})

describe('buildMenuEntries', () => {
  test('the scan row names the checkout it would scan, and is refused without one', () => {
    const withRepo = buildMenuEntries({
      repoRoot: '/repo/a/app',
      hasDatabase: true,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: true,
    })
    expect(withRepo[0]!.disabledReason).toBeNull()
    expect(withRepo[0]!.description).toContain('/repo/a/app')

    const withoutRepo = buildMenuEntries({
      repoRoot: null,
      hasDatabase: false,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: false,
    })
    // Refused *with a reason*, not hidden: a row that vanished would leave the researcher
    // unable to tell "not possible here" from "not a feature".
    expect(withoutRepo[0]!.disabledReason).toContain('without a directory to scan')
    expect(withoutRepo[1]!.disabledReason).toContain('neither a scanned target')
  })

  test('resume is offered even when the database holds nothing, and says which nothing', () => {
    const noDatabase = buildMenuEntries({
      repoRoot: '/repo/a',
      hasDatabase: false,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: true,
    })
    expect(noDatabase[2]!.disabledReason).toBeNull()
    expect(noDatabase[2]!.description).toContain('no state database here yet')

    const emptyDatabase = buildMenuEntries({
      repoRoot: '/repo/a',
      hasDatabase: true,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: true,
    })
    expect(emptyDatabase[2]!.description).toContain('holds no runs yet')
  })

  test('with runs, the row counts them and the disagreements still undecided', () => {
    const entries = buildMenuEntries({
      repoRoot: '/repo/a',
      hasDatabase: true,
      pendingDisagreements: 3,
      runCount: 2,
      hasCodebase: true,
    })
    expect(entries[2]!.description).toBe('2 runs · 3 undecided disagreements')
  })

  test('every row is takeable in the ordinary case', () => {
    const entries = buildMenuEntries({
      repoRoot: '/repo/a',
      hasDatabase: true,
      pendingDisagreements: 1,
      runCount: 1,
      hasCodebase: true,
    })
    expect(entries.map((entry) => entry.disabledReason)).toEqual([null, null, null])
  })
})

describe('buildMenuHeaderLines', () => {
  test('names the repository and the database before any row is offered', () => {
    const lines = buildMenuHeaderLines({
      repoRoot: '/repo/a',
      dbPath: '/repo/a/.windbreak/state.db',
      hasDatabase: true,
    })
    expect(text(lines)).toContain('repository: /repo/a')
    expect(text(lines)).toContain('database:   /repo/a/.windbreak/state.db')
  })

  test('an absent database is warned about and says what creates it', () => {
    const lines = buildMenuHeaderLines({
      repoRoot: null,
      dbPath: '/repo/a/.windbreak/state.db',
      hasDatabase: false,
    })
    expect(text(lines)).toContain('does not exist yet; a scan creates it')
    expect(text(lines)).toContain('not in a checkout')
    expect(lines.some((line) => line.tone === 'warning')).toBe(true)
  })
})

describe('buildMenuLines', () => {
  test('tags the header as no row and each entry with its index', () => {
    const entries = buildMenuEntries({
      repoRoot: '/repo/a',
      hasDatabase: true,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: true,
    })
    const lines = buildMenuLines({
      header: buildMenuHeaderLines({ repoRoot: '/repo/a', dbPath: 'db', hasDatabase: true }),
      entries,
    })

    expect(lines[0]!.row).toBe(-1)
    expect(lines.filter((line) => line.row === 0).length).toBe(2)
    expect(lines.filter((line) => line.row === 2).length).toBe(2)
  })

  test('a refused entry keeps its label and gains its reason as a third line', () => {
    const entries = buildMenuEntries({
      repoRoot: null,
      hasDatabase: false,
      pendingDisagreements: 0,
      runCount: 0,
      hasCodebase: false,
    })
    const lines = buildMenuLines({ header: [], entries })
    const scanRow = lines.filter((line) => line.row === 0)

    expect(scanRow).toHaveLength(3)
    expect(scanRow[0]!.text).toBe('Run a scan on this repo')
    expect(scanRow[2]!.tone).toBe('warning')
  })
})

describe('buildRunsLines', () => {
  test('the first row is the whole database, whether or not a run is listed', () => {
    const lines = buildRunsLines({ runs: [run()], selectedIndex: 0 })
    expect(lines[0]!.text).toBe('every disagreement · 1 undecided disagreement across 1 run')
    expect(lines[0]!.row).toBe(0)
  })

  test('each run gets a row with its checkout, revision and status', () => {
    const lines = buildRunsLines({
      runs: [run(), run({ runId: 'run-2', status: 'partial', finishedAt: null })],
      selectedIndex: 0,
    })
    const first = lines.filter((line) => line.row === 1)
    expect(first).toHaveLength(2)
    expect(first[0]!.text).toContain('run-1 · /repo/a · abc12345')
    expect(first[1]!.text).toContain('complete · 2 disagreements · 1 undecided')

    const second = lines.filter((line) => line.row === 2)
    // Every status that is not `complete` reads as incomplete, including the `running` a
    // killed scan leaves behind: the list is used to continue a run, and "running" would
    // claim a process that no longer exists.
    expect(second[1]!.text).toContain('incomplete — resumable')
    expect(second[0]!.tone).toBe('warning')
  })

  test('a run that escalated nothing says so rather than printing a zero pair', () => {
    const lines = buildRunsLines({
      runs: [run({ queued: 0, resolved: 0 })],
      selectedIndex: 0,
    })
    expect(lines.filter((line) => line.row === 1)[1]!.text).toContain(
      'no disagreements to review',
    )
  })

  test('an empty database is a sentence, not a blank pane', () => {
    const lines = buildRunsLines({ runs: [], selectedIndex: 0 })
    expect(text(lines)).toContain('This database holds no runs')
    expect(lines[0]!.text).toBe('every disagreement · 0 undecided disagreements across 0 runs')
  })

  test('a checkout nobody recorded is named as unknown rather than guessed', () => {
    const lines = buildRunsLines({ runs: [run({ targetLocation: null })], selectedIndex: 0 })
    expect(lines.filter((line) => line.row === 1)[0]!.text).toContain('(checkout not recorded)')
  })
})

describe('describeRunStatus', () => {
  test('keeps the run own word for complete and folds the rest together', () => {
    expect(describeRunStatus('complete')).toBe('complete')
    for (const status of ['partial', 'aborted', 'failed', 'running']) {
      expect(describeRunStatus(status)).toBe('incomplete — resumable')
    }
  })
})

describe('deriveScanStage', () => {
  const stages: readonly ScanStageId[] = ['ingestion', 'static-core', 'triage', 'reporting']

  test('the last announced stage is the stage', () => {
    expect(
      deriveScanStage(['[recon] 120 files', '[scan] ingestion (spec §3.2)', '[scan] static-core (…)'], stages),
    ).toBe('static-core')
  })

  test('announcements that name no stage are walked past', () => {
    expect(deriveScanStage(['[scan] ingestion (spec §3.2)', '[scan] resuming run-1: 2 stage(s) already complete'], stages)).toBe(
      'ingestion',
    )
  })

  test('before the first announcement there is no stage to claim', () => {
    expect(deriveScanStage(['[recon] starting'], stages)).toBeNull()
    expect(deriveScanStage([], stages)).toBeNull()
  })

  test('a stage id this build does not know is not reported as one', () => {
    expect(deriveScanStage(['[scan] made-up-stage (spec)'], stages)).toBeNull()
  })
})

describe('buildScanSummaryLines', () => {
  test('names the run, its stages, and the counts the batch command prints', () => {
    const lines = buildScanSummaryLines(scanResult())
    expect(lines[0]!.text).toBe('scan complete · run run-7')
    expect(text(lines)).toContain('ingestion       complete')
    expect(text(lines)).toContain('static-core     partial')
    expect(text(lines)).toContain('from discovery             3')
    expect(text(lines)).toContain('escalated (needs review)   2')
  })

  test('the escalation count is the one that reads as a call to action', () => {
    const withEscalations = buildScanSummaryLines(scanResult())
    const escalated = withEscalations.find((line) => line.text.includes('escalated (needs review)'))!
    expect(escalated.tone).toBe('warning')

    const none = buildScanSummaryLines(
      scanResult({ counts: { ...EMPTY_COUNTS, candidates: 0, escalated: 0 } }),
    )
    expect(none.find((line) => line.text.includes('escalated (needs review)'))!.tone).toBe('muted')
  })

  test('§20.24.5 coverage is printed next to the counts, in the batch wording', () => {
    const lines = buildScanSummaryLines(scanResult())
    // The same function the batch summary uses, so the two surfaces cannot drift.
    expect(text(lines)).toContain(formatLanguageCoverage(EMPTY_COVERAGE))
  })

  test('a scan that did not complete is a warning, with its resume point named', () => {
    const lines = buildScanSummaryLines(
      scanResult({ status: 'partial', resumeFrom: 'verification' }),
    )
    expect(lines[0]!.text).toBe('scan partial · run run-7')
    expect(lines[0]!.tone).toBe('warning')
    expect(text(lines)).toContain('this run can be continued')
  })

  test('warnings and the report paths travel with the summary', () => {
    const lines = buildScanSummaryLines(
      scanResult({
        report: { sarifPath: '/out/report.sarif', indexPath: '/out/index.md' } as never,
        warnings: ['the sandboxed build was skipped'],
      }),
    )
    expect(text(lines)).toContain('warning: the sandboxed build was skipped')
    expect(text(lines)).toContain('/out/report.sarif')
  })
})

describe('scanOffsetToFollow', () => {
  test('pins the window to the newest line, and never past the start', () => {
    expect(scanOffsetToFollow(100, 20)).toBe(80)
    expect(scanOffsetToFollow(5, 20)).toBe(0)
  })
})
