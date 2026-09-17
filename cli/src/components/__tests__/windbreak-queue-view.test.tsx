import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { createRoot, flushSync } from '@opentui/react'
import React from 'react'

import { initializeThemeStore } from '../../hooks/use-theme'
import { WindbreakQueueView } from '../windbreak-queue-view'

import type {
  ReviewDecision,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewQueueSource,
} from '@codebuff/windbreak/review'
import type { MockInput } from '@opentui/core/testing'
import type { QueueChatTurn } from '../../windbreak/queue-chat-content'
import type {
  WindbreakQueueChat,
  WindbreakQueueChatHandlers,
  WindbreakQueueNotice,
  WindbreakQueueState,
} from '../windbreak-queue-view'

beforeAll(() => {
  initializeThemeStore()
})

let close: (() => void) | undefined

afterEach(() => {
  close?.()
  close = undefined
})

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface Mounted {
  frame: () => string
  press: (act: (keys: MockInput) => void) => Promise<void>
}

const mount = async (element: React.ReactNode): Promise<Mounted> => {
  const setup = await createTestRenderer({ width: 100, height: 40, kittyKeyboard: true })
  const root = createRoot(setup.renderer)
  close = () => {
    flushSync(() => root.unmount())
    setup.renderer.destroy()
  }

  /**
   * Render, let effects and focus land, render again.
   *
   * The extra tick is for the rationale input: a `MultilineInput` registers for focus a frame
   * after the render that creates it, so a keystroke sent in the same tick reaches nothing.
   */
  const settle = async (): Promise<void> => {
    await setup.renderOnce()
    await wait(60)
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

const source = (overrides: Partial<ReviewQueueSource> = {}): ReviewQueueSource => ({
  path: '/repo/.windbreak/state.db',
  absent: false,
  ...overrides,
})

const entry = (overrides: Partial<ReviewEntrySummary> = {}): ReviewEntrySummary => ({
  candidateId: 'cand-1',
  runId: 'run-1',
  filePath: 'src/handler.c',
  startLine: 6,
  cwe: 'CWE-120',
  source: 'semgrep',
  patternId: 'wb-c-unbounded-string-op',
  decision: null,
  decidedAt: null,
  rationale: null,
  ...overrides,
})

const detail = (overrides: Partial<ReviewEntryDetail> = {}): ReviewEntryDetail => ({
  summary: entry(),
  candidateState: 'escalated',
  target: {
    id: 't1',
    location: '/home/researcher/project-a',
    buildModel: 'compile_commands',
    scopeClass: 'userspace-c',
    commitSha: 'abc123def456',
  },
  evidence: {
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy into a fixed-size buffer',
    level: 'error',
    filePath: 'src/handler.c',
    startLine: 6,
    endLine: 6,
    snippet: '  strcpy(buf, line);',
    injectionSignals: [],
  },
  proposer: {
    role: 'proposer',
    verdictId: 'ver-proposer',
    verdict: 'real',
    reasoning: 'the length check happens after the copy',
    preconditions: [],
    modelId: 'openai/gpt-5',
    provider: 'openai',
  },
  refuter: {
    role: 'refuter',
    verdictId: 'ver-refuter',
    verdict: 'benign',
    reasoning: 'callers validate the length upstream',
    preconditions: [],
    modelId: 'z-ai/glm-5.3',
    provider: 'z-ai',
  },
  ...overrides,
})

const chatState = (overrides: Partial<WindbreakQueueChat> = {}): WindbreakQueueChat => ({
  open: false,
  starting: false,
  unavailableReason: null,
  turns: [],
  pending: false,
  budget: { calls: 0, limit: 40, turns: 0, tokens: 0, exhausted: false, remaining: 40 },
  refusal: null,
  mode: 'explain',
  ...overrides,
})

const openState = (overrides: Partial<Extract<WindbreakQueueState, { phase: 'open' }>> = {}) =>
  ({
    phase: 'open',
    source: source(),
    counts: { total: 1, pending: 1, resolved: 0 },
    entries: [entry()],
    detail: detail(),
    selectedIndex: 0,
    includeResolved: false,
    notice: null,
    chat: chatState(),
    ...overrides,
  }) satisfies Extract<WindbreakQueueState, { phase: 'open' }>

const turn = (overrides: Partial<QueueChatTurn> = {}): QueueChatTurn => ({
  agent: 'investigator',
  mode: 'explain',
  prompt: 'who calls this?',
  answer: 'The socket reader calls it with an unbounded line buffer.',
  error: null,
  cancelled: false,
  pending: false,
  writes: [],
  proposals: [],
  proposalRejections: [],
  injectionSignals: [],
  toolsUsed: ['read_files', 'code_search'],
  recordedTurnId: 'turn-1',
  budget: { calls: 2, limit: 40, turns: 1, tokens: 1200, exhausted: false, remaining: 38 },
  ...overrides,
})

const mountView = async (
  state: WindbreakQueueState,
  handlers: {
    onClose?: () => void
    onSelect?: (delta: number) => void
    onToggleResolved?: () => void
    onDecide?: (input: {
      candidateId: string
      decision: ReviewDecision
      rationale: string
    }) => void
    onChat?: Partial<WindbreakQueueChatHandlers>
  } = {},
): Promise<Mounted> =>
  mount(
    <WindbreakQueueView
      repoRoot="/repo"
      state={state}
      onClose={handlers.onClose ?? (() => undefined)}
      onSelect={handlers.onSelect ?? (() => undefined)}
      onToggleResolved={handlers.onToggleResolved ?? (() => undefined)}
      onDecide={handlers.onDecide ?? (() => undefined)}
      onChat={{
        open: handlers.onChat?.open ?? (() => undefined),
        close: handlers.onChat?.close ?? (() => undefined),
        ask: handlers.onChat?.ask ?? (() => undefined),
        cancel: handlers.onChat?.cancel ?? (() => undefined),
      }}
    />,
  )

describe('WindbreakQueueView', () => {
  test('names the database it read, and the work in it', async () => {
    const { frame } = await mountView(openState())

    const rendered = frame()
    expect(rendered).toContain('/repo/.windbreak/state.db')
    expect(rendered).toContain('1 pending · 0 of 1 decided')
    expect(rendered).toContain('pending only')
  })

  test('shows both model answers and the evidence behind them', async () => {
    const { frame } = await mountView(openState())

    const rendered = frame()
    // The row…
    expect(rendered).toContain('cand-1')
    expect(rendered).toContain('src/handler.c:6')
    // …and the disagreement the row is: both sides, with the model that gave each.
    expect(rendered).toContain('openai/gpt-5 via openai')
    expect(rendered).toContain('z-ai/glm-5.3 via z-ai')
    expect(rendered).toContain('the length check happens after the copy')
    expect(rendered).toContain('callers validate the length upstream')
    expect(rendered).toContain('strcpy(buf, line);')
  })

  test('a missing database says which nothing this is', async () => {
    const { frame } = await mountView(
      openState({
        source: source({ absent: true }),
        counts: { total: 0, pending: 0, resolved: 0 },
        entries: [],
        detail: null,
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('No state database exists at /repo/.windbreak/state.db')
    expect(rendered).toContain('nothing has been scanned into this path')
    // The header must not offer a count it has no basis for.
    expect(rendered).not.toContain('0 of 0 decided')
  })

  test('a refusal is rendered, not thrown', async () => {
    const { frame } = await mountView({
      phase: 'refused',
      reason:'could not open the queue: schema version 3 does not match the expected 8.',
      dbPath: '/repo/.windbreak/state.db',
    })

    const rendered = frame()
    // The file the refusal is about, named. The reason text does not carry it, and a refusal that
    // did not say which database was unreadable would leave the reader unable to act on it.
    expect(rendered).toContain('/repo/.windbreak/state.db')
    expect(rendered).toContain('The queue was not opened.')
    expect(rendered).toContain('schema version 3')
    expect(rendered).toContain('This is not an empty queue')
    // And no count, which this screen has no basis for.
    expect(rendered).not.toContain('0 pending')
  })

  test('a refusal with no resolved path says the configuration is what could not be read', async () => {
    const { frame } = await mountView({
      phase: 'refused',
      reason: 'could not read /repo/.windbreak/config.json: unexpected end of JSON',
      dbPath: null,
    })

    const rendered = frame()
    expect(rendered).toContain('not resolved — the configuration could not be read')
    expect(rendered).toContain('unexpected end of JSON')
  })

  test('a fully decided queue points at the rows instead of looking empty', async () => {
    const { frame } = await mountView(
      openState({
        counts: { total: 2, pending: 0, resolved: 2 },
        entries: [],
        detail: null,
      }),
    )

    expect(frame()).toContain('Press `a` to list them')
  })

  test('an empty database says the queue is not the code', async () => {
    const { frame } = await mountView(
      openState({
        counts: { total: 0, pending: 0, resolved: 0 },
        entries: [],
        detail: null,
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('This database holds no disagreements.')
    expect(rendered).toContain('about the code')
  })

  test('the arrows move the cursor and a toggles the decided rows', async () => {
    const seen: number[] = []
    const toggles = { count: 0 }
    const { press } = await mountView(openState(), {
      onSelect: (delta) => seen.push(delta),
      onToggleResolved: () => {
        toggles.count += 1
      },
    })

    await press((keys) => keys.pressArrow('down'))
    await press((keys) => keys.pressKey('k'))
    await press((keys) => keys.pressKey('a'))

    expect(seen).toEqual([1, -1])
    expect(toggles.count).toBe(1)
  })

  test('escape leaves the view', async () => {
    let closed = 0
    const { press } = await mountView(openState(), {
      onClose: () => {
        closed += 1
      },
    })

    await press((keys) => keys.pressEscape())
    expect(closed).toBe(1)
  })

  test('a decision is typed, and the keystroke that submits it carries the text', async () => {
    const decisions: { candidateId: string; decision: ReviewDecision; rationale: string }[] = []
    let closed = 0
    const { frame, press } = await mountView(openState(), {
      onDecide: (input) => decisions.push(input),
      onClose: () => {
        closed += 1
      },
    })

    await press((keys) => keys.pressKey('r'))
    // What the decision does downstream is stated before the key that records it, not after.
    expect(frame()).toContain('the candidate joins verification as confirmed')
    expect(frame()).toContain('enter records the decision')

    await press((keys) => keys.typeText('checked the callers by hand'))
    await press((keys) => keys.pressEnter())

    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toEqual({
      candidateId: 'cand-1',
      decision: 'real',
      rationale: 'checked the callers by hand',
    })
    // Recording a decision is not leaving the view.
    expect(closed).toBe(0)
  })

  test('b decides the other way, and says what that costs', async () => {
    const decisions: { decision: ReviewDecision }[] = []
    const { frame, press } = await mountView(openState(), {
      onDecide: (input) => decisions.push({ decision: input.decision }),
    })

    await press((keys) => keys.pressKey('b'))
    expect(frame()).toContain('dropped from verification')

    await press((keys) => keys.pressEnter())
    expect(decisions).toEqual([{ decision: 'benign' }])
  })

  test('escape abandons a rationale, and leaves the view only when nothing is open', async () => {
    const decisions: unknown[] = []
    let closed = 0
    const { frame, press } = await mountView(openState(), {
      onDecide: (input) => decisions.push(input),
      onClose: () => {
        closed += 1
      },
    })

    await press((keys) => keys.pressKey('r'))
    expect(frame()).toContain('rationale for cand-1')

    await press((keys) => keys.pressEscape())
    // Nothing was recorded — `session.decide` is only reached from the input's submit — and the
    // view is still open, with the prompt gone.
    expect(decisions).toHaveLength(0)
    expect(closed).toBe(0)
    expect(frame()).not.toContain('rationale for cand-1')

    await press((keys) => keys.pressEscape())
    expect(closed).toBe(1)
  })

  test('an empty submission is allowed, and says that empty is recorded as none', async () => {
    const decisions: { rationale: string }[] = []
    const { frame, press } = await mountView(openState(), {
      onDecide: (input) => decisions.push({ rationale: input.rationale }),
    })

    await press((keys) => keys.pressKey('r'))
    expect(frame()).toContain('empty is recorded as none')

    await press((keys) => keys.pressEnter())
    expect(decisions).toEqual([{ rationale: '' }])
  })

  test('after a decision the pane says what was written, and if it replaced one', async () => {
    const notice: WindbreakQueueNotice = {
      candidateId: 'cand-1',
      decision: 'real',
      previous: 'benign',
    }
    const { frame } = await mountView(openState({ notice }))

    const rendered = frame()
    expect(rendered).toContain('recorded real for cand-1')
    expect(rendered).toContain('This replaces an earlier benign')
  })

  test('the decision a resolved row carries is shown with its rationale', async () => {
    const { frame } = await mountView(
      openState({
        includeResolved: true,
        counts: { total: 1, pending: 0, resolved: 1 },
        entries: [
          entry({
            decision: 'benign',
            decidedAt: '2026-02-02T00:00:00Z',
            rationale: 'checked the callers by hand',
          }),
        ],
        detail: detail({
          summary: entry({
            decision: 'benign',
            decidedAt: '2026-02-02T00:00:00Z',
            rationale: 'checked the callers by hand',
          }),
        }),
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('pending and decided')
    expect(rendered).toContain('checked the callers by hand')
    expect(rendered).toContain('dropped from verification')
  })

  test('c opens the investigator on the selected row', async () => {
    let opened = 0
    const { press } = await mountView(openState(), {
      onChat: {
        open: () => {
          opened += 1
        },
      },
    })

    const idle = await mountView(openState())
    expect(idle.frame()).toContain('c ask about this row')

    await press((keys) => keys.pressKey('c'))
    expect(opened).toBe(1)
  })

  test('the pane says who will answer and what the conversation has cost', async () => {
    const { frame } = await mountView(
      openState({ chat: chatState({ open: true, turns: [turn()] }) }),
    )

    const rendered = frame()
    expect(rendered).toContain('about src/handler.c:6')
    expect(rendered).toContain('budget: 2/40 model calls')
    expect(rendered).toContain('1 turn')
    // The answer and its audit line. The budget is the *turn's* own state, not a second reading of
    // the bridge's — the two cannot disagree on screen.
    expect(rendered).toContain('The socket reader calls it with an unbounded line buffer.')
    expect(rendered).toContain('[2 tool calls: read_files, code_search]')
  })

  test('a freshly opened pane states the terms it answers under', async () => {
    const { frame } = await mountView(openState({ chat: chatState({ open: true }) }))

    const rendered = frame()
    expect(rendered).toContain('It does not decide anything.')
    expect(rendered).toContain('it cannot change it')
    expect(rendered).toContain('no turns yet')
  })

  test('a question is typed and sent with the keystroke that carries it', async () => {
    const asked: string[] = []
    const { press } = await mountView(openState({ chat: chatState({ open: true }) }), {
      onChat: { ask: (text) => asked.push(text) },
    })

    await press((keys) => keys.typeText('is the length capped upstream?'))
    await press((keys) => keys.pressEnter())

    expect(asked).toEqual(['is the length capped upstream?'])
  })

  test('escape closes an idle pane, and stops a turn that is running', async () => {
    let closed = 0
    let cancelled = 0
    const { press } = await mountView(openState({ chat: chatState({ open: true }) }), {
      onChat: {
        close: () => {
          closed += 1
        },
        cancel: () => {
          cancelled += 1
        },
      },
    })

    await press((keys) => keys.pressEscape())
    expect(closed).toBe(1)
    expect(cancelled).toBe(0)

    const pending = await mountView(
      openState({ chat: chatState({ open: true, pending: true }) }),
      {
        onChat: {
          close: () => {
            closed += 1
          },
          cancel: () => {
            cancelled += 1
          },
        },
      },
    )

    await pending.press((keys) => keys.pressEscape())
    // A turn in flight is stopped; closing instead would leave it running with its answer going
    // nowhere. The pane says which of the two `esc` will do.
    expect(cancelled).toBe(1)
    expect(closed).toBe(1)
    expect(pending.frame()).toContain('esc stops it')
  })

  test('the pane refuses a second question while one is in flight', async () => {
    const asked: string[] = []
    const { press } = await mountView(
      openState({ chat: chatState({ open: true, pending: true }) }),
      { onChat: { ask: (text) => asked.push(text) } },
    )

    await press((keys) => keys.typeText('and another thing'))
    await press((keys) => keys.pressEnter())

    expect(asked).toEqual([])
  })

  test('a cancelled turn is not a failed one', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({
          open: true,
          turns: [
            turn({
              cancelled: true,
              answer: null,
              error: null,
              budget: { calls: 1, limit: 40, turns: 1, tokens: 0, exhausted: false, remaining: 39 },
            }),
          ],
        }),
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('cancelled — you stopped this turn')
    expect(rendered).not.toContain('(no answer)')
  })

  test('an unavailable investigator says why instead of showing an input', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({
          open: true,
          unavailableReason:
            'no model credentials are available, so the investigator cannot run. The queue still works: deciding a disagreement needs no model.',
        }),
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('no model credentials are available')
    expect(rendered).toContain('deciding a disagreement needs no model')
  })

  test('a spent ceiling says what to do rather than showing a dead input', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({
          open: true,
          budget: { calls: 40, limit: 40, turns: 9, tokens: 9000, exhausted: true, remaining: 0 },
        }),
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('budget spent: 40/40 model calls')
    expect(rendered).toContain('ceiling spent — esc closes this pane')
  })

  test('an account refusal is shown above the input, not only in the transcript', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({
          open: true,
          refusal: {
            kind: 'credits',
            detail: 'the account has no credits left',
          },
        }),
      }),
    )

    expect(frame()).toContain('! ')
  })

  test('a turn that is not on record says so', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({ open: true, turns: [turn({ recordedTurnId: null })] }),
      }),
    )

    expect(frame()).toContain('not on record')
  })

  test('a recorded proposal is shown as recorded, with the model\u2019s own label', async () => {
    const { frame } = await mountView(
      openState({
        chat: chatState({
          open: true,
          turns: [
            turn({
              proposals: [
                { filePath: 'src/other.c', startLine: 12, endLine: 12, cwe: 'CWE-787', claim: 'x' },
              ],
            }),
          ],
        }),
      }),
    )

    const rendered = frame()
    expect(rendered).toContain('recorded 1 candidate')
    expect(rendered).toContain('src/other.c:12 (CWE-787, as the model labelled it)')
  })

  test('the detail pane scrolls without moving the cursor', async () => {
    const seen: number[] = []
    const { press } = await mountView(openState(), { onSelect: (delta) => seen.push(delta) })

    await press((keys) => keys.pressKey('pagedown'))
    await press((keys) => keys.pressKey('pageup'))

    expect(seen).toEqual([])
  })
})
