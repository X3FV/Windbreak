import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import { openStateDatabase } from '@codebuff/windbreak/state'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { runWindbreakCommand } from '..'
import { LoadingPane } from '../loading-pane'
import { DEFAULT_WINDBREAK_PREFERENCES } from '../preferences'

import type { TestRendererSetup } from '@opentui/core/testing'
import type { ReviewInvestigator } from '@codebuff/windbreak/review'

let setup: TestRendererSetup | null = null
let cleanup: (() => void) | undefined

beforeAll(() => {
  // `useThemeStore` throws until initialized, and this surface never runs the chat app's
  // `initializeApp` — the same reason `index.tsx` initializes it before the renderer.
  initializeThemeStore()
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  setup = null
})

const mountPane = async (subject: string): Promise<TestRendererSetup> => {
  const created = await createTestRenderer({ width: 80, height: 24 })
  setup = created
  const root = createRoot(created.renderer)
  cleanup = () => {
    flushSync(() => root.unmount())
    created.renderer.destroy()
  }
  flushSync(() => {
    root.render(
      <LoadingPane subject={subject} preferences={DEFAULT_WINDBREAK_PREFERENCES} />,
    )
  })
  // Committing the tree is not drawing it — the same two gates `index.tsx` documents.
  // Here the test renderer's own flush closes the second, so this test asserts on a frame
  // rather than on a tree that was merely rendered.
  await created.flush()
  return created
}

describe('the launch loading view', () => {
  test('it says what it is waiting for, and which path it is waiting on', async () => {
    // "Loading" with no subject leaves an operator unsure whether anything is happening,
    // and the path is the one fact that shows they pointed it at the right place.
    const frame = (await mountPane('/repo/.windbreak/state.db')).captureCharFrame()

    expect(frame).toContain('WindBreak')
    expect(frame).toContain('preparing the investigator')
    expect(frame).toContain('/repo/.windbreak/state.db')
  })

  test('the subject is whatever the screen was pointed at, database or repository', async () => {
    // §20.31 widened this line: an unscanned checkout waits on the same thing (credentials
    // and the SDK) with no database to name, so the repository is what belongs here — not
    // a path to a file that does not exist.
    const frame = (await mountPane('/repo/unscanned-checkout')).captureCharFrame()

    expect(frame).toContain('/repo/unscanned-checkout')
    expect(frame).not.toContain('state.db')
  })
})

/** A bridge that does nothing, for a test whose subject is the wait before it exists. */
const stubInvestigator: ReviewInvestigator = {
  unavailableReason: null,
  modeFor: () => 'hunt',
  budget: () => ({ calls: 0, limit: 1, turns: 0, tokens: 0, exhausted: false, remaining: 1 }),
  workingCopy: () => null,
  ask: async () => ({
    ok: true,
    agent: 'investigator',
    workingCopyId: null,
    writes: [],
    cancelled: false,
    answer: 'nothing to report',
    error: null,
    proposals: [],
    proposalRejections: [],
    injectionSignals: [],
    toolsUsed: [],
    recordedTurnId: null,
    budget: { calls: 1, limit: 1, turns: 1, tokens: 0, exhausted: true, remaining: 0 },
  }),
}

describe('the wait before the app is ready', () => {
  test('the loading pane is on screen while the bridge is built', async () => {
    // The property the pane exists for: during the credential/target resolution the
    // terminal shows *something*, rather than the blank shell the reordering in
    // §20.29.5 introduced. Asserted on a real renderer's frame rather than on the call
    // order, because a render that is never committed or never painted is exactly the
    // failure this guards — and it is the failure the first implementation had.
    //
    // `--run` because §20.33 put the *menu* in front of the queue, and the menu builds no
    // bridge: the wait this pane covers belongs to the screen that needs a model, and
    // naming a run is how a caller asks for that screen directly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-launch-'))
    const dbPath = path.join(dir, 'state.db')
    // A real database, so the run takes the branch that has a bridge to wait for.
    openStateDatabase(dbPath).close()

    const created = await createTestRenderer({ width: 80, height: 24 })
    setup = created
    const root = createRoot(created.renderer)
    cleanup = () => {
      flushSync(() => root.unmount())
      created.renderer.destroy()
    }

    let frameDuringBuild: string | null = null

    await runWindbreakCommand(['bun', '/app/index.ts', 'windbreak', '--db', dbPath, '--run', 'run-1'], {
      writeOut: () => {},
      writeErr: () => {},
      initializeTheme: () => {},
      loadPreferences: () => DEFAULT_WINDBREAK_PREFERENCES,
      createRenderer: (async () => created.renderer) as never,
      mount: () => root,
      createInvestigator: async () => {
        // Called *after* the command has waited for the loading frame, so this is the
        // frame that was on screen throughout the wait.
        frameDuringBuild = created.captureCharFrame()
        return stubInvestigator
      },
    })

    expect(frameDuringBuild).not.toBeNull()
    expect(frameDuringBuild as unknown as string).toContain('preparing the investigator')

    fs.rmSync(dir, { recursive: true, force: true })
  })
})
