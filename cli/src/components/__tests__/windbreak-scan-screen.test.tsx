import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import fs from 'fs'
import os from 'os'
import path from 'path'
import React from 'react'

import { createMeteredSessions } from '@codebuff/windbreak/client'
import { EMPTY_COUNTS } from '@codebuff/windbreak/scan'

import { initializeThemeStore } from '../../hooks/use-theme'
import { WindbreakScanScreen } from '../windbreak-scan-screen'

import type { CodebuffClient } from '@codebuff/sdk'
import type { WindbreakModelHost } from '@codebuff/windbreak/client'
import type { LaunchScanOutcome, ScanResult } from '@codebuff/windbreak/scan'
import type { MockInput } from '@opentui/core/testing'
import type { ScanRunner } from '../windbreak-scan-screen'

/**
 * What a view is told when this CLI has no transport to lend.
 *
 * Passed at every render site rather than left to the default: the default reaches for this
 * process's login and live freebuff session, and a test about the view's own behaviour should
 * touch neither. The wiring itself has its own test below, with a host it controls.
 */
const noHost = async (): Promise<WindbreakModelHost | null> => null

beforeAll(() => {
  initializeThemeStore()
})

const created: string[] = []
let close: (() => void) | undefined

afterEach(() => {
  close?.()
  close = undefined
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const tempRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scan-screen-'))
  created.push(dir)
  return dir
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const result = (over: Partial<ScanResult> = {}): ScanResult => ({
  runId: 'run-9',
  targetId: 'target-abc',
  commitSha: 'deadbee',
  status: 'complete',
  stages: [
    {
      stage: 'ingestion',
      status: 'complete',
      durationMs: 1200,
      detail: '12 files',
      counts: {},
      reason: null,
    },
  ],
  counts: { ...EMPTY_COUNTS },
  resumeFrom: null,
  report: null,
  languageCoverage: {
    sweptCallables: 0,
    partiallySweptCallables: 0,
    unsweptCallables: 0,
    languages: [],
  },
  providerFailure: null,
  warnings: [],
  ...over,
})

interface Mounted {
  frame: () => string
  press: (act: (keys: MockInput) => void) => Promise<void>
}

const mount = async (
  element: React.ReactNode,
  size: { width: number; height: number } = { width: 100, height: 40 },
): Promise<Mounted> => {
  const setup = await createTestRenderer({ ...size, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  close = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  const settle = async (): Promise<void> => {
    await setup.renderOnce()
    await wait(20)
    await setup.renderOnce()
  }

  flushSync(() => root.render(element))
  await settle()

  return {
    frame: () => setup.captureCharFrame(),
    press: async (act) => {
      act(setup.mockInput)
      await settle()
    },
  }
}

describe('WindbreakScanScreen', () => {
  test('runs against the session\u2019s checkout, into that checkout\u2019s database', async () => {
    const repo = tempRepo()
    const seen: Parameters<ScanRunner>[0][] = []
    const runner: ScanRunner = (input) => {
      seen.push(input)
      return Promise.resolve({ ok: false, reason: 'stopped here' })
    }

    await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={() => undefined}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]!.targetRoot).toBe(repo)
    expect(seen[0]!.dbPath).toBe(path.join(repo, '.windbreak', 'state.db'))
    // No config was named, so the engine reads the discovered one itself.
    expect(seen[0]!.configPath).toBeUndefined()
    expect(seen[0]!.runId).toBeUndefined()
    // Stated rather than omitted, so the launcher can tell "this CLI has no transport" from
    // "this caller never said", which are resolved differently.
    expect(seen[0]!.modelHost).toBeNull()
  })

  test('hands the run the CLI’s own transport rather than letting the scan resolve one', async () => {
    // §20.41.5's experiment, asserted where the view can be wrong: free mode is scoped to the
    // freebuff CLI *as a caller*, so a scan started here must make its calls as this process.
    // The launcher's own resolution path — a client built from the same credentials — is the
    // shape §20.41 documents as refused, so passing this through is the entire change.
    const repo = tempRepo()
    const seen: Parameters<ScanRunner>[0][] = []
    const runner: ScanRunner = (input) => {
      seen.push(input)
      return Promise.resolve({ ok: false, reason: 'stopped here' })
    }
    const host: WindbreakModelHost = {
      client: {} as CodebuffClient,
      sessions: createMeteredSessions(),
    }

    await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={() => undefined}
        runner={runner}
        hostResolver={async () => host}
      />,
    )

    expect(seen[0]!.modelHost).toBe(host)
  })

  test('names a config the checkout holds, so the run and the commands agree', async () => {
    const repo = tempRepo()
    fs.mkdirSync(path.join(repo, '.windbreak'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.windbreak', 'config.json'),
      JSON.stringify({ target: { db: 'state.db' } }),
    )

    const seen: Parameters<ScanRunner>[0][] = []
    const runner: ScanRunner = (input) => {
      seen.push(input)
      return Promise.resolve({ ok: false, reason: 'stopped here' })
    }

    await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={() => undefined}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(seen[0]!.configPath).toBe(path.join(repo, '.windbreak', 'config.json'))
  })

  test('streams the run\u2019s own log while it is in flight', async () => {
    const repo = tempRepo()
    const runner: ScanRunner = (input) => {
      input.log('stage recon: indexed 3 files')
      input.log('stage engines: 1 candidate')
      // Never lands: this test is about what is on screen mid-run.
      return new Promise<LaunchScanOutcome>(() => undefined)
    }

    const { frame } = await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={() => undefined}
        runner={runner}
        hostResolver={noHost}
      />,
    )
    // The container batches log lines, so give the flush its interval.
    await wait(200)

    const rendered = frame()
    expect(rendered).toContain('stage recon: indexed 3 files')
    expect(rendered).toContain('stage engines: 1 candidate')
    expect(rendered).toContain('esc is refused while it runs')
  })

  test('keeps the summary when the run lands, and hands the transcript one line', async () => {
    const repo = tempRepo()
    // A holder rather than a `let`: TypeScript narrows a `null` initializer to `null` and
    // cannot see the assignment the view makes through its callback.
    const closed = { summary: null as string | null }
    const runner: ScanRunner = () =>
      Promise.resolve({
        ok: true,
        result: result({ status: 'partial', counts: { ...EMPTY_COUNTS, candidates: 12, escalated: 3 } }),
      })

    const { frame, press } = await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={(summary) => {
          closed.summary = summary
        }}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(frame()).toContain('run id:       run-9')
    expect(frame()).toContain('status:       partial')

    await press((keys) => keys.pressEscape())

    // §20.33: a finished scan keeps its summary. At transcript resolution that is the run's
    // identity, its status, and the queue it produced — with the command that works it.
    expect(closed.summary).toContain('run-9')
    expect(closed.summary).toContain('partial')
    expect(closed.summary).toContain('12 candidate(s)')
    expect(closed.summary).toContain('3 escalated')
    expect(closed.summary).toContain('windbreak review --run run-9')
  })

  test('r continues the run it produced, by the run\u2019s own id', async () => {
    const repo = tempRepo()
    const calls: (string | undefined)[] = []
    const runner: ScanRunner = (input) => {
      calls.push(input.runId)
      return Promise.resolve(
        calls.length === 1
          ? { ok: true, result: result({ status: 'partial', resumeFrom: 'triage' }) }
          : { ok: true, result: result() },
      )
    }

    const { frame, press } = await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={() => undefined}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(frame()).toContain('r continue from triage')
    await press((keys) => keys.pressKey('r'))

    expect(calls).toEqual([undefined, 'run-9'])
    expect(frame()).toContain('OK: scan complete.')
  })

  test('a launcher refusal is shown rather than thrown, and reaches the transcript', async () => {
    const repo = tempRepo()
    const closed = { summary: null as string | null }
    const runner: ScanRunner = () =>
      Promise.resolve({
        ok: false,
        reason: 'the configuration is invalid, so no scan was started: [proposer] unknown model',
      })

    const { frame, press } = await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={(summary) => {
          closed.summary = summary
        }}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(frame()).toContain('The scan was not started.')
    expect(frame()).toContain('unknown model')

    await press((keys) => keys.pressEscape())
    expect(closed.summary).toContain('no scan was started')
    expect(closed.summary).toContain('unknown model')
  })

  test('an unreadable config refuses before the launcher is ever called', async () => {
    const repo = tempRepo()
    fs.mkdirSync(path.join(repo, '.windbreak'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.windbreak', 'config.json'), '{ not json')

    const seen = { called: false, summary: null as string | null }
    const runner: ScanRunner = () => {
      seen.called = true
      return Promise.resolve({ ok: false, reason: 'should not run' })
    }

    const { frame, press } = await mount(
      <WindbreakScanScreen
        repoRoot={repo}
        onClose={(summary) => {
          seen.summary = summary
        }}
        runner={runner}
        hostResolver={noHost}
      />,
    )

    expect(seen.called).toBe(false)
    expect(frame()).toContain('could not be read')
    expect(frame()).toContain('not resolved')

    await press((keys) => keys.pressEscape())
    expect(seen.summary).toContain('could not read')
  })
})
