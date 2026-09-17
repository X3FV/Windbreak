import { describe, expect, test } from 'bun:test'

import { resolveWindbreakQueueAction } from '../windbreak-queue-actions'

import type { KeyEvent } from '@opentui/core'

const createKey = (overrides: Partial<KeyEvent> = {}): KeyEvent =>
  ({
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    ...overrides,
  }) as KeyEvent

const browsing = { typing: false, hasSelection: true, chatting: false }
const typing = { typing: true, hasSelection: true, chatting: false }
const empty = { typing: false, hasSelection: false, chatting: false }
const chatting = { typing: false, hasSelection: true, chatting: true }

describe('resolveWindbreakQueueAction', () => {
  test('the arrows select, and the page keys scroll the evidence instead', () => {
    expect(resolveWindbreakQueueAction(createKey({ name: 'up' }), browsing)).toEqual({
      type: 'select',
      delta: -1,
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'j' }), browsing)).toEqual({
      type: 'select',
      delta: 1,
    })

    expect(resolveWindbreakQueueAction(createKey({ name: 'pageup' }), browsing)).toEqual({
      type: 'scroll',
      delta: 1,
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'pagedown' }), browsing)).toEqual({
      type: 'scroll',
      delta: -1,
    })
  })

  test('modified arrows scroll for terminals that swallow them', () => {
    expect(
      resolveWindbreakQueueAction(createKey({ name: 'up', shift: true }), browsing),
    ).toEqual({ type: 'scroll', delta: 1 })
    expect(
      resolveWindbreakQueueAction(createKey({ name: 'down', ctrl: true }), browsing),
    ).toEqual({ type: 'scroll', delta: -1 })
    // The plain printable stand-ins `queue-panel` settled on, for the same reason.
    expect(
      resolveWindbreakQueueAction(createKey({ name: 'k', shift: true, sequence: 'K' }), browsing),
    ).toEqual({ type: 'scroll', delta: 1 })
    expect(
      resolveWindbreakQueueAction(createKey({ name: 'j', shift: true, sequence: 'J' }), browsing),
    ).toEqual({ type: 'scroll', delta: -1 })
    // Their unshifted twins still only move the cursor.
    expect(
      resolveWindbreakQueueAction(createKey({ name: 'k', sequence: 'k' }), browsing),
    ).toEqual({ type: 'select', delta: -1 })
  })

  test('r, b and enter open a rationale for the selected candidate', () => {
    expect(resolveWindbreakQueueAction(createKey({ name: 'r' }), browsing)).toEqual({
      type: 'begin-rationale',
      decision: 'real',
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'b' }), browsing)).toEqual({
      type: 'begin-rationale',
      decision: 'benign',
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'return' }), browsing)).toEqual({
      type: 'begin-rationale',
      decision: 'real',
    })
  })

  test('with nothing selected there is no decision to offer', () => {
    // `a` is not one of the keys that need a selection: on a queue whose disagreements have all
    // been decided, it is the only way to see them.
    expect(resolveWindbreakQueueAction(createKey({ name: 'a' }), empty)).toEqual({
      type: 'toggle-resolved',
    })
    for (const name of ['r', 'b', 'return']) {
      expect(resolveWindbreakQueueAction(createKey({ name }), empty)).toEqual({ type: 'none' })
    }
  })

  test('a toggles the decided rows, and it is not a decision key', () => {
    expect(resolveWindbreakQueueAction(createKey({ name: 'a' }), browsing)).toEqual({
      type: 'toggle-resolved',
    })
  })

  test('escape, q and ctrl+c leave the view', () => {
    for (const key of [
      createKey({ name: 'escape' }),
      createKey({ name: 'q', sequence: 'q' }),
      createKey({ name: 'c', ctrl: true }),
    ]) {
      expect(resolveWindbreakQueueAction(key, browsing)).toEqual({ type: 'close' })
    }
  })

  test('while a rationale is open, escape abandons it and the rest is typing', () => {
    expect(resolveWindbreakQueueAction(createKey({ name: 'escape' }), typing)).toEqual({
      type: 'cancel-rationale',
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'c', ctrl: true }), typing)).toEqual({
      type: 'cancel-rationale',
    })

    // Every shortcut letter has to reach the text field, including the two decision keys — a
    // rationale that says "b" is not a benign verdict — and Escape alone is not enough to leave
    // the view with a half-typed rationale on screen.
    for (const name of ['r', 'b', 'a', 'q', 'j', 'k']) {
      expect(resolveWindbreakQueueAction(createKey({ name }), typing)).toEqual({ type: 'none' })
    }
    expect(resolveWindbreakQueueAction(createKey({ name: 'up' }), typing)).toEqual({
      type: 'none',
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'pagedown' }), typing)).toEqual({
      type: 'none',
    })
    // Enter is the input's own: `MultilineInput.onSubmit` records the decision, and handling the
    // key here as well would record it twice.
    expect(resolveWindbreakQueueAction(createKey({ name: 'return' }), typing)).toEqual({
      type: 'none',
    })
  })

  test('while the investigator pane is open, escape is the pane\u2019s and the rest is a question', () => {
    expect(resolveWindbreakQueueAction(createKey({ name: 'escape' }), chatting)).toEqual({
      type: 'chat-escape',
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'c', ctrl: true }), chatting)).toEqual({
      type: 'chat-escape',
    })

    // Checked before `typing`, because this pane's input is *always* focused: a question that
    // contains "q" or "esc" is still a question, and `c` is a letter rather than a command.
    for (const name of ['q', 'c', 'r', 'b', 'a', 'j', 'k', 'n']) {
      expect(resolveWindbreakQueueAction(createKey({ name, sequence: name }), chatting)).toEqual({
        type: 'none',
      })
    }
    expect(resolveWindbreakQueueAction(createKey({ name: 'up' }), chatting)).toEqual({
      type: 'none',
    })

    // The transcript still scrolls: reading back what the investigator said is the point of a
    // long conversation, and the arrows belong to the text field.
    expect(resolveWindbreakQueueAction(createKey({ name: 'pageup' }), chatting)).toEqual({
      type: 'scroll',
      delta: 1,
    })
    expect(resolveWindbreakQueueAction(createKey({ name: 'pagedown' }), chatting)).toEqual({
      type: 'scroll',
      delta: -1,
    })
  })
})
