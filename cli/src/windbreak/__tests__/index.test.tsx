import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import React from 'react'

import { openStateDatabase } from '@codebuff/windbreak/state'

import { isWindbreakInvocation, runWindbreakCommand } from '..'
import { LoadingPane } from '../loading-pane'
import { ReviewApp } from '../review-app'
import { StartMenu } from '../start-menu'

import type { InvestigatorConfig } from '@codebuff/windbreak/config'
import type { ReviewInvestigator } from '@codebuff/windbreak/review'

const capture = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    writeOut: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
  }
}

const invocation = (...args: string[]) => ['bun', '/app/index.ts', 'windbreak', ...args]

/** A bridge that does nothing, for tests whose subject is the wire to it. */
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

describe('isWindbreakInvocation', () => {
  test('recognizes the subcommand and only the subcommand', () => {
    expect(isWindbreakInvocation(invocation())).toBe(true)
    expect(isWindbreakInvocation(['bun', '/app/index.ts', 'login'])).toBe(false)
    expect(isWindbreakInvocation(['bun', '/app/index.ts'])).toBe(false)
  })
})

describe('runWindbreakCommand', () => {
  test('a missing database opens the screen, and creates nothing on the way', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-cli-'))
    const dbPath = path.join(dir, 'state.db')
    const io = capture()
    const order: string[] = []

    // The real opener, not a stub: that a missing database yields a renderable
    // session is the thing being asserted.
    const code = await runWindbreakCommand(invocation('--db', dbPath), {
      ...io,
      initializeTheme: () => order.push('theme'),
      loadPreferences: () => ({ layout: 'auto', theme: 'default' }),
      savePreferences: () => order.push('saved'),
      // Throws rather than pretending: reaching the renderer at all is the
      // assertion, and a refusal would have returned 1 without ever arriving.
      createRenderer: (() => {
        order.push('renderer')
        throw new Error('no terminal in this test')
      }) as never,
    }).catch(() => -1)

    expect(order).toEqual(['theme', 'renderer'])
    expect(io.err).toEqual([])
    expect(code).toBe(-1)

    // What did *not* change: opening the screen is still not allowed to be the
    // thing that creates an empty database and then reports the emptiness as an
    // empty queue (§18). The screen says "not found" instead.
    expect(fs.existsSync(dbPath)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('an unknown subcommand is a usage error, not a silent success', async () => {
    const io = capture()

    const code = await runWindbreakCommand(invocation('scan'), io)

    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('only one so far is "review"')
  })

  test('an unknown option is refused rather than ignored', async () => {
    const io = capture()

    const code = await runWindbreakCommand(invocation('--db', 'x', '--wat'), io)

    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('--wat')
  })

  test('--help prints usage to stdout and is not a failure', async () => {
    const io = capture()

    const code = await runWindbreakCommand(invocation('--help'), io)

    expect(code).toBe(0)
    const help = io.out.join('\n')
    expect(help).toContain('Usage:')
    expect(help).toContain('--db <path>')
    expect(help).toContain('--run <id>')
    expect(io.err).toEqual([])
  })

  test('the theme store is initialized before the first render', async () => {
    // `useThemeStore` throws until it is initialized, and this surface never runs
    // the chat app's `initializeApp` — which is where the real TUI run died.
    const order: string[] = []
    const session = {
      // The source is part of the contract, not a UI detail: it is what stops an
      // absent database from rendering as an empty queue, so a stub has to say
      // which it is standing in for.
      source: { path: null, absent: false },
      list: () => [],
      detail: () => null,
      decide: () => ({ previous: null }),
      counts: () => ({ total: 0, pending: 0, resolved: 0 }),
      // The menu reads the run list for its own counters before anything is chosen.
      runs: () => [],
      // No target on record in this stub, which is the state the codebase pane has to
      // render rather than the one it lists.
      codebase: () => null,
      close: () => {
        order.push('session-closed')
      },
    }

    const code = await runWindbreakCommand(invocation('--db', '/tmp/review-test.db'), {
      exit: () => order.push('exit'),
      writeOut: () => {},
      writeErr: () => {},
      resolveSession: () => ({ ok: true, session }),
      initializeTheme: () => order.push('theme'),
      // Injected rather than left to default: the real reader is `loadSettings`,
      // which creates the CLI's config directory when it is missing, so a test
      // that forgot this would write a settings file into the developer's home
      // directory.
      loadPreferences: () => ({ layout: 'auto', theme: 'default' }),
      savePreferences: () => order.push('saved'),
      // Throws rather than pretending: reaching the renderer at all is the
      // assertion, and it must happen after the theme is ready.
      createRenderer: (() => {
        order.push('renderer')
        throw new Error('no terminal in this test')
      }) as never,
    }).catch(() => -1)

    expect(order).toEqual(['theme', 'renderer'])
    expect(code).toBe(-1)
  })

  test('the --config file reaches the pane as the investigator limits', async () => {
    // The config row only means something if the surface that uses it reads it. This is
    // the wire from `investigator.maxConversationCalls` to the bridge the pane talks to.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-cfg-'))
    const dbPath = path.join(dir, 'state.db')
    // A real state database, because the bridge opens a second connection to it.
    openStateDatabase(dbPath).close()
    const configPath = path.join(dir, 'wb.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({ investigator: { maxConversationCalls: 7, maxSteps: 3 } }),
    )

    const order: string[] = []
    const seen: InvestigatorConfig[] = []

    // `--run` names the queue to open, which is the path that skips the menu — the
    // ordering asserted below is the *queue* screen's, and §20.33 made the menu the
    // default in front of it.
    const code = await runWindbreakCommand(invocation('--db', dbPath, '--run', 'run-1', '--config', configPath), {
      writeOut: () => {},
      writeErr: () => {},
      initializeTheme: () => order.push('theme'),
      loadPreferences: () => {
        order.push('preferences')
        return { layout: 'auto', theme: 'default' }
      },
      createRenderer: (async () => {
        order.push('renderer')
        // `requestRender`/`idle` are the two renderer methods the loading frame needs to
        // reach the terminal, so a double without them would make this test fail for a
        // reason it is not about.
        return { requestRender: () => {}, idle: async () => {} }
      }) as never,
      mount: () => {
        order.push('mount')
        return {
          // The element's own type says which screen was drawn, so the ordering is
          // asserted on what the root was handed rather than on a flag the command set.
          render: (element) =>
            order.push(
              React.isValidElement(element) && element.type === LoadingPane
                ? 'render:loading'
                : 'render:app',
            ),
          unmount: () => order.push('unmount'),
        }
      },
      createInvestigator: async ({ limits }) => {
        order.push('investigator')
        seen.push(limits)
        return stubInvestigator
      },
    })

    expect(seen).toEqual([{ maxConversationCalls: 7, maxSteps: 3 }])
    // The wait is drawn, and the app replaces it only once the bridge exists.
    expect(order).toEqual([
      'theme',
      'renderer',
      'mount',
      'preferences',
      'render:loading',
      'investigator',
      'render:app',
    ])
    expect(code).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('an absent database waits too now, because §20.31 builds a bridge for it', async () => {
    // This used to be "skips the loading pane": an absent database built no bridge, since
    // opening one would *create* it (§20.28), so there was no wait to draw. §20.31 gives
    // the bridge the repository as a fallback root, so the credential/SDK wait is real
    // for an unscanned checkout as well — and a blank pause is what §20.29.8 removed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-absent-'))
    const dbPath = path.join(dir, 'state.db')
    const rendered: string[] = []
    const created: string[] = []

    await runWindbreakCommand(invocation('--db', dbPath, '--run', 'run-1'), {
      writeOut: () => {},
      writeErr: () => {},
      initializeTheme: () => {},
      loadPreferences: () => ({ layout: 'auto', theme: 'default' }),
      // `requestRender` and `idle` are the two renderer methods the loading frame needs
      // to reach the terminal; without them the frame is drawn but never painted.
      createRenderer: (async () => ({
        requestRender: () => {},
        idle: async () => {},
      })) as never,
      mount: () => ({
        render: (element) =>
          rendered.push(
            React.isValidElement(element) && element.type === LoadingPane ? 'loading' : 'app',
          ),
        unmount: () => {},
      }),
      createInvestigator: async () => {
        created.push('called')
        return stubInvestigator
      },
    })

    expect(rendered).toEqual(['loading', 'app'])
    // Reading a checkout never needed a scan, so the pane is available here.
    expect(created).toEqual(['called'])
    // And the screen still creates nothing on the way, which is what §20.28 is about:
    // the connection is in memory, so no database exists to read as an empty queue.
    expect(fs.existsSync(dbPath)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a bare invocation opens the menu, and waits for a choice before the bridge', async () => {
    // §20.33's shape, at the entry point: the menu is the command, and resolving
    // credentials — the pause the loading pane exists for — happens only once a screen
    // that needs a model has been asked for. A cold start must not pay for a bridge the
    // researcher may never use.
    const order: string[] = []
    const rendered: string[] = []
    const session = {
      source: { path: '/tmp/wb.db', absent: false },
      list: () => [],
      detail: () => null,
      decide: () => ({ previous: null }),
      counts: () => ({ total: 0, pending: 0, resolved: 0 }),
      runs: () => [],
      codebase: () => null,
      close: () => order.push('closed'),
    }

    const code = await runWindbreakCommand(invocation('--db', '/tmp/wb.db'), {
      writeOut: () => {},
      writeErr: () => {},
      resolveSession: () => ({ ok: true, session }),
      initializeTheme: () => order.push('theme'),
      loadPreferences: () => ({ layout: 'auto', theme: 'default' }),
      createRenderer: (async () => ({
        requestRender: () => {},
        idle: async () => {},
      })) as never,
      mount: () => ({
        render: (element) => {
          if (!React.isValidElement(element)) {
            rendered.push('invalid')
            return
          }
          if (element.type === StartMenu) rendered.push('menu')
          else if (element.type === LoadingPane) rendered.push('loading')
          else if (element.type === ReviewApp) rendered.push('app')
          else rendered.push('other')
        },
        unmount: () => order.push('unmount'),
      }),
      createInvestigator: async () => {
        order.push('investigator')
        return stubInvestigator
      },
    })

    expect(code).toBe(0)
    expect(rendered).toEqual(['menu'])
    expect(order).toEqual(['theme'])
  })

  test('the repository is resolved from the working directory and given to the session', async () => {
    // §20.31's first decision, at the seam that carries it: one resolution, handed to the
    // session, so the file pane and the models cannot be looking at two checkouts.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-repo-'))
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    const seen: Array<{ dbPath: string; repoRoot?: string | null }> = []

    const code = await runWindbreakCommand(
      invocation('--cwd', dir, '--db', 'state.db'),
      {
        ...capture(),
        initializeTheme: () => {},
        createRenderer: (() => {
          throw new Error('the refusal below returns before any renderer')
        }) as never,
        resolveSession: (input) => {
          seen.push(input)
          return { ok: false, reason: 'stop here: the resolution is the assertion' }
        },
      },
    )

    expect(code).toBe(1)
    expect(seen[0]?.repoRoot).toBe(fs.realpathSync(dir))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a config that cannot be read is refused rather than silently ignored', async () => {
    // A file the operator named and this build cannot read is an error, not a reason to
    // use defaults they did not ask for.
    const io = capture()
    const code = await runWindbreakCommand(
      invocation('--db', '/scanned/state.db', '--config', '/nowhere/wb.json'),
      io,
    )

    expect(code).toBe(2)
    expect(io.err.join('\n')).toContain('Config file not found')
  })

  test('a database that cannot be used stops before a renderer is created', async () => {
    // The case the refusal is still for: the database is there and unreadable —
    // here, a schema version this build does not know. Stubbed, because what is
    // under test is the CLI's handling of `ok: false`, not which condition
    // produces it. (A *missing* database is no longer one of them.)
    //
    // No renderer exists in this test process, so reaching that point would fail
    // loudly rather than pass quietly.
    const io = capture()

    const code = await runWindbreakCommand(invocation('--db', '/scanned/state.db'), {
      ...io,
      resolveSession: () => ({ ok: false, reason: 'schema version 5, found 3' }),
    })

    expect(code).toBe(1)
    expect(io.err.join('\n')).toContain('schema version 5, found 3')
  })
})
