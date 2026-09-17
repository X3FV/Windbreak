import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { EMPTY_COUNTS } from '@codebuff/windbreak/scan'

import { initializeThemeStore } from '../../hooks/use-theme'
import { WindbreakScanView } from '../windbreak-scan-view'

import type { MockInput } from '@opentui/core/testing'
import type { ScanResult } from '@codebuff/windbreak/scan'
import type { ScanSubject } from '../../windbreak/subject'

beforeAll(() => {
  initializeThemeStore()
})

let close: (() => void) | undefined

afterEach(() => {
  close?.()
  close = undefined
})

const SUBJECT: ScanSubject = {
  targetRoot: '/tmp/project-a',
  dbPath: '/tmp/project-a/.windbreak/state.db',
  configuredTarget: null,
  configPath: '/tmp/project-a/.windbreak/config.json',
  budgetSeconds: 1800,
  investigator: { maxConversationCalls: 40, maxSteps: 12 },
}

const result = (over: Partial<ScanResult> = {}): ScanResult => ({
  runId: 'run-7',
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
    sweptCallables: 4,
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

/** Mount the view, at the size asked for. */
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
    await new Promise((resolve) => setTimeout(resolve, 20))
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

const view = (
  state: React.ComponentProps<typeof WindbreakScanView>['state'],
  overrides: Partial<React.ComponentProps<typeof WindbreakScanView>> = {},
) => (
  <WindbreakScanView
    repoRoot={SUBJECT.targetRoot}
    subject={SUBJECT}
    state={state}
    onClose={() => undefined}
    onResume={() => undefined}
    {...overrides}
  />
)

const running = (lines: readonly string[], droppedLines = 0) =>
  ({ phase: 'running', lines, droppedLines }) as const

describe('WindbreakScanView', () => {
  test('names the subject, the database and the budget before the run', async () => {
    const { frame } = await mount(view(running([])))
    const rendered = frame()

    expect(rendered).toContain('repository')
    expect(rendered).toContain(SUBJECT.targetRoot)
    expect(rendered).toContain('database')
    expect(rendered).toContain(SUBJECT.dbPath)
    expect(rendered).toContain('config')
    expect(rendered).toContain(SUBJECT.configPath!)
    // The auto-approval is a spend nobody agreed to if the screen does not say it.
    expect(rendered).toContain('1800s')
    expect(rendered).toContain('stdin')
  })

  test('streams the run\u2019s own log while it runs', async () => {
    const { frame } = await mount(
      view(running(['stage recon: indexed 12 files', 'stage engines: 2 candidates'])),
    )

    expect(frame()).toContain('stage recon: indexed 12 files')
    expect(frame()).toContain('stage engines: 2 candidates')
  })

  test('says the log was truncated, so a shorter log cannot read as a quieter run', async () => {
    const { frame } = await mount(view(running(['the newest line'], 40)))
    const rendered = frame()

    expect(rendered).toContain('40 earlier line(s)')
    expect(rendered).toContain('the newest line')
  })

  test('follows the newest log row, and counts what is above it', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)
    const { frame } = await mount(view(running(lines)), { width: 100, height: 14 })
    const rendered = frame()

    // A running log is read at its moving end.
    expect(rendered).toContain('line 10')
    expect(rendered).not.toContain('line 1 ')
    expect(rendered).toContain('more row(s)')
  })

  test('refuses to leave while the run is in this process, and says why', async () => {
    let closed = false
    const { frame, press } = await mount(
      view(running(['working']), {
        onClose: () => {
          closed = true
        },
      }),
    )

    await press((keys) => keys.pressEscape())

    expect(closed).toBe(false)
    expect(frame()).toContain('esc leaves once it lands')
  })

  test('keeps the summary \u2014 stages, counts, warnings and all \u2014 when the run lands', async () => {
    const { frame } = await mount(
      view({ phase: 'done', result: result({ warnings: ['candidate 3 unexamined'] }) }),
    )
    const rendered = frame()

    expect(rendered).toContain('run id:       run-7')
    expect(rendered).toContain('status:       complete')
    expect(rendered).toContain('stages:')
    expect(rendered).toContain('candidates:')
    expect(rendered).toContain('language coverage')
    expect(rendered).toContain('warning: candidate 3 unexamined')
    expect(rendered).toContain('OK: scan complete.')
  })

  test('opens a landed summary at its top, not at its tail', async () => {
    // Short terminal, so the summary has to be windowed and the anchor decides what a reader
    // sees first: which run this was and how it ended, not the end of the stage table.
    const { frame } = await mount(view({ phase: 'done', result: result() }), {
      width: 100,
      height: 14,
    })
    const rendered = frame()

    expect(rendered).toContain('run id:       run-7')
    expect(rendered).toContain('↓')
    // Nothing is hidden *above* it — a landed summary is read from its first row. The
    // indicator is `  ↑ N more row(s)`; the hint row's `↑↓ scroll` is not one.
    expect(rendered).not.toContain('↑ ')
    expect(rendered).not.toContain('OK: scan complete.')
  })

  test('leaves with esc once the run has landed', async () => {
    let closed = false
    const { press } = await mount(
      view(
        { phase: 'done', result: result() },
        {
          onClose: () => {
            closed = true
          },
        },
      ),
    )

    await press((keys) => keys.pressEscape())

    expect(closed).toBe(true)
  })

  test('offers the continuation only when the run has one, and takes r for it', async () => {
    let resumed = 0
    const resumable = await mount(
      view(
        { phase: 'done', result: result({ status: 'partial', resumeFrom: 'triage' }) },
        {
          onResume: () => {
            resumed += 1
          },
        },
      ),
    )

    expect(resumable.frame()).toContain('r continue from triage')
    await resumable.press((keys) => keys.pressKey('r'))
    expect(resumed).toBe(1)

    const complete = await mount(
      view(
        { phase: 'done', result: result() },
        {
          onResume: () => {
            resumed += 1
          },
        },
      ),
    )

    expect(complete.frame()).not.toContain('r continue from')
    await complete.press((keys) => keys.pressKey('r'))
    expect(resumed).toBe(1)
  })

  test('a refusal says the scan was not started and reports the reason', async () => {
    const { frame } = await mount(
      view({
        phase: 'refused',
        reason: 'the configuration is invalid: [proposer] unknown model',
      }),
    )
    const rendered = frame()

    expect(rendered).toContain('The scan was not started.')
    expect(rendered).toContain('the configuration is invalid')
  })

  test('an unresolvable subject is shown as unresolved rather than guessed', async () => {
    const { frame } = await mount(
      view({ phase: 'refused', reason: 'could not read the configuration' }, { subject: null }),
    )
    const rendered = frame()

    expect(rendered).toContain('could not be read')
    expect(rendered).toContain('not resolved')
  })

  test('names the configured target when the config points somewhere else', async () => {
    const { frame } = await mount(
      view(running([]), { subject: { ...SUBJECT, configuredTarget: '/tmp/project-b' } }),
    )

    // `windbreak scan` here would follow the config; the view does not, so the difference is
    // stated instead of being discovered from the findings.
    expect(frame()).toContain('/tmp/project-b')
  })
})
