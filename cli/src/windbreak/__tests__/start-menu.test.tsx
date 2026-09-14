import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { reviewSessionFor } from '@codebuff/windbreak/review'
import { EMPTY_COUNTS, type LaunchScanOutcome, type ScanResult } from '@codebuff/windbreak/scan'
import { applySchema } from '@codebuff/windbreak/state'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { DEFAULT_WINDBREAK_PREFERENCES } from '../preferences'
import { StartMenu, type ScanRunner } from '../start-menu'

import type { ReviewSession } from '@codebuff/windbreak/review'

let cleanupRenderer: (() => void) | undefined

beforeAll(() => {
  initializeThemeStore()
})

afterEach(() => {
  cleanupRenderer?.()
  cleanupRenderer = undefined
})

/**
 * A real session over a real schema, in a real (temporary) checkout.
 *
 * The screen is exercised against `@codebuff/windbreak/review` rather than a stub because
 * the wiring *is* part of the subject here: the menu's own counters come from
 * `session.runs()`, and the files screen draws `session.codebase(null)` — a stub would test
 * the screen in a world where neither is ever called.
 */
const seed = () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-menu-'))
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'src', 'handler.c'), 'int main(void) { return 0; }\n')

  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)

  db.prepare(
    `INSERT INTO targets (id, location, commit_sha) VALUES ('t1', ?, 'abc123')`,
  ).run(fs.realpathSync(repoDir))
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status, started_at)
     VALUES ('run-1', 't1', '{}', 'abc123', 'partial', '2026-09-13T10:00:00Z')`,
  ).run()
  db.prepare(
    `INSERT INTO recon_files (target_id, path, language, bytes, binary)
     VALUES ('t1', 'src/handler.c', 'c', 120, 0)`,
  ).run()
  db.prepare(
    `INSERT INTO candidates (id, run_id, source, file_path, start_line, end_line, cwe,
                             normalized_json, state)
     VALUES ('cand-1', 'run-1', 'semgrep', 'src/handler.c', 1, 1, 'CWE-120', '{}', 'escalated')`,
  ).run()
  db.prepare(
    `INSERT INTO adjudication_queue (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id)
     VALUES ('cand-1', 'run-1', 'v1', 'v2')`,
  ).run()

  return { db, repoDir, session: reviewSessionFor(db, undefined, fs.realpathSync(repoDir)) }
}

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
  ],
  counts: { ...EMPTY_COUNTS, candidates: 4, escalated: 2 },
  resumeFrom: null,
  report: null,
  languageCoverage: {
    sweptCallables: 12,
    partiallySweptCallables: 0,
    unsweptCallables: 3,
    languages: [],
  },
  warnings: [],
  ...overrides,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface MountOptions {
  session: ReviewSession
  repoRoot: string | null
  runScan?: ScanRunner
}

const mountMenu = async (options: MountOptions) => {
  const setup = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  cleanupRenderer = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  const opened: (string | null)[] = []
  const finished: string[] = []
  let exits = 0

  flushSync(() =>
    root.render(
      <StartMenu
        session={options.session}
        dbPath=".windbreak/state.db"
        repoRoot={options.repoRoot}
        preferences={DEFAULT_WINDBREAK_PREFERENCES}
        runScan={options.runScan}
        onScanFinished={(runId) => finished.push(runId)}
        onOpenReview={(runId) => opened.push(runId)}
        onExit={() => {
          exits += 1
        }}
      />,
    ),
  )
  await setup.renderOnce()

  /** Input lands on the render loop and React commits on its scheduler. */
  const settle = async (waitMs = 20) => {
    await setup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    await setup.renderOnce()
  }

  return {
    ...setup,
    settle,
    opened,
    finished,
    exits: () => exits,
    async press(action: () => void, waitMs = 20) {
      action()
      await settle(waitMs)
    },
  }
}

type Screen = Awaited<ReturnType<typeof mountMenu>>

/**
 * The label the cursor is drawn on, so a test can assert a real selection.
 *
 * The line is cut at the pane's right border: the padded frame carries it on every row, and
 * comparing against a label with a `│` glued to its tail would fail for a reason the test
 * is not about.
 */
const selectedLabel = (frame: string): string => {
  const row = frame.split('\n').find((line) => line.includes('❯'))
  if (row === undefined) return ''
  return row
    .slice(row.indexOf('❯') + 1)
    .split('│')[0]!
    .trim()
}

describe('the start menu', () => {
  test('names what it resolved and offers the three choices', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })
    const frame = menu.captureCharFrame()

    expect(frame).toContain('Run a scan on this repo')
    expect(frame).toContain('Files / codebase browser')
    expect(frame).toContain('Resume a previous run')
    // The two facts a researcher gets wrong, before any row is chosen.
    expect(frame).toContain(`repository: ${fs.realpathSync(repoDir)}`)
    expect(frame).toContain('database:   .windbreak/state.db')
    expect(frame).toContain('1 run · 1 undecided disagreement')
    expect(frame).toContain('↑↓/jk choose')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('the selection moves, and only takeable rows take it', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })

    expect(selectedLabel(menu.captureCharFrame())).toBe('Run a scan on this repo')
    await menu.press(() => menu.mockInput.pressKey('j'))
    expect(selectedLabel(menu.captureCharFrame())).toBe('Files / codebase browser')
    await menu.press(() => menu.mockInput.pressArrow('down'))
    expect(selectedLabel(menu.captureCharFrame())).toBe('Resume a previous run')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('with no checkout the scan row is refused with its reason on screen', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: null })
    const frame = menu.captureCharFrame()

    expect(frame).toContain('no checkout to scan')
    expect(frame).toContain('without a directory to scan')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('files opens the listing, and escape comes back to the menu', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })

    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressEnter())

    const listing = menu.captureCharFrame()
    expect(listing).toContain('Codebase — ')
    expect(listing).toContain('handler.c')
    expect(listing).toContain('↑↓/jk scroll')

    await menu.press(() => menu.mockInput.pressEscape())
    expect(menu.captureCharFrame()).toContain('Run a scan on this repo')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('runs lists the database first and each run after it', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })

    await menu.press(() => menu.mockInput.pressKey('j', {}))
    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressEnter())

    const frame = menu.captureCharFrame()
    expect(frame).toContain('every disagreement · 1 undecided disagreement across 1 run')
    expect(frame).toContain('run-1')
    expect(frame).toContain('incomplete — resumable')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('enter on the first runs row opens every disagreement, and on a run opens that run', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })

    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressEnter())
    await menu.press(() => menu.mockInput.pressEnter())
    expect(menu.opened).toEqual([null])

    // The run's own row is one below the database's.
    await menu.press(() => menu.mockInput.pressArrow('down'))
    await menu.press(() => menu.mockInput.pressEnter())
    expect(menu.opened).toEqual([null, 'run-1'])
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('r continues an incomplete run rather than starting a new scan', async () => {
    const { db, repoDir, session } = seed()
    const calls: { runId?: string }[] = []
    // Left running on purpose: what is asserted is what the screen says *while* the
    // continuation works, and a resolved scan would have been replaced by its summary.
    const scan = deferred<LaunchScanOutcome>()
    const runner: ScanRunner = (options) => {
      calls.push({ ...(options.runId === undefined ? {} : { runId: options.runId }) })
      return scan.promise
    }
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir), runScan: runner })

    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressKey('j'))
    await menu.press(() => menu.mockInput.pressEnter())
    await menu.press(() => menu.mockInput.pressArrow('down'))
    await menu.press(() => menu.mockInput.pressKey('r'))

    expect(calls).toEqual([{ runId: 'run-1' }])
    const frame = menu.captureCharFrame()
    // A continuation says so, because the target comes from the run rather than the
    // directory the command was run in.
    expect(frame).toContain('resuming run run-1')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('q leaves the command, and every other letter is not a command', async () => {
    const { db, repoDir, session } = seed()
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir) })

    await menu.press(() => menu.mockInput.pressKey('x'))
    expect(menu.exits()).toBe(0)
    expect(selectedLabel(menu.captureCharFrame())).toBe('Run a scan on this repo')

    await menu.press(() => menu.mockInput.pressKey('q'))
    expect(menu.exits()).toBe(1)
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })
})

describe('a scan started from the menu', () => {
  test('streams the run own log, then keeps its summary on screen', async () => {
    const { db, repoDir, session } = seed()
    const scan = deferred<LaunchScanOutcome>()
    let captured: ((line: string) => void) | null = null
    const runner: ScanRunner = (options) => {
      captured = options.log
      return scan.promise
    }
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir), runScan: runner })

    await menu.press(() => menu.mockInput.pressEnter())
    captured!('[scan] ingestion (spec §3.2)')
    captured!('[recon] 120 files')
    // The log is flushed on a timer rather than per line, so the frame has to wait for it.
    await menu.settle(160)

    const running = menu.captureCharFrame()
    expect(running).toContain('scanning ')
    expect(running).toContain('ingestion')
    expect(running).toContain('[recon] 120 files')
    expect(running).toContain('q leave (the run is resumable)')

    scan.resolve({ ok: true, result: scanResult() })
    await menu.settle()

    const done = menu.captureCharFrame()
    expect(done).toContain('scan complete · run run-7')
    expect(done).toContain('escalated (needs review)   2')
    expect(done).toContain('enter open the queue')
    expect(menu.finished).toEqual(['run-7'])

    // The summary is the run's only record of its warnings and coverage, so it stays until
    // the researcher asks for the queue.
    await menu.press(() => menu.mockInput.pressEnter())
    expect(menu.opened).toEqual(['run-7'])
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test('a scan that fails says why, and escape goes back to the menu', async () => {
    const { db, repoDir, session } = seed()
    const runner: ScanRunner = () =>
      Promise.resolve({ ok: false, reason: 'the configuration is invalid, so no scan was started' })
    const menu = await mountMenu({ session, repoRoot: fs.realpathSync(repoDir), runScan: runner })

    await menu.press(() => menu.mockInput.pressEnter())
    await menu.settle()

    const frame = menu.captureCharFrame()
    expect(frame).toContain('the scan did not finish')
    expect(frame).toContain('the configuration is invalid')
    expect(menu.finished).toEqual([])

    await menu.press(() => menu.mockInput.pressEscape())
    expect(menu.captureCharFrame()).toContain('Run a scan on this repo')
    db.close()
    fs.rmSync(repoDir, { recursive: true, force: true })
  })
})
