import { describe, expect, test } from 'bun:test'

import { resolveReviewAction } from '../actions'

import type { KeyEvent } from '@opentui/core'

const key = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent =>
  ({ name, sequence: '', ctrl: false, shift: false, meta: false, ...extra }) as KeyEvent

const browse = { mode: 'browse' as const }
const rationale = { mode: 'rationale' as const }

describe('resolveReviewAction', () => {
  test('arrows and j/k move the selection', () => {
    expect(resolveReviewAction(key('up'), browse)).toEqual({ type: 'select', delta: -1 })
    expect(resolveReviewAction(key('k'), browse)).toEqual({ type: 'select', delta: -1 })
    expect(resolveReviewAction(key('down'), browse)).toEqual({ type: 'select', delta: 1 })
    expect(resolveReviewAction(key('j'), browse)).toEqual({ type: 'select', delta: 1 })
  })

  test('r and b open a decision, named for the conclusion not for a model', () => {
    expect(resolveReviewAction(key('r'), browse)).toEqual({
      type: 'begin-decision',
      decision: 'real',
    })
    expect(resolveReviewAction(key('b'), browse)).toEqual({
      type: 'begin-decision',
      decision: 'benign',
    })
  })

  test('a toggles the resolved entries back into the list', () => {
    expect(resolveReviewAction(key('a'), browse)).toEqual({ type: 'toggle-resolved' })
  })

  test('page keys scroll the detail pane by pages, without moving the cursor', () => {
    // The case for a finding is read, not skimmed, so it has to be reachable
    // without a mouse. These scroll the evidence, not the queue.
    expect(resolveReviewAction(key('pageup'), browse)).toEqual({
      type: 'scroll-detail',
      pages: -1,
    })
    expect(resolveReviewAction(key('pagedown'), browse)).toEqual({
      type: 'scroll-detail',
      pages: 1,
    })
  })

  test('q, escape and ctrl+c leave, and leaving records nothing', () => {
    expect(resolveReviewAction(key('q'), browse)).toEqual({ type: 'quit' })
    expect(resolveReviewAction(key('escape'), browse)).toEqual({ type: 'quit' })
    expect(resolveReviewAction(key('c', { ctrl: true }), browse)).toEqual({ type: 'quit' })
  })

  test('while the rationale is being typed, its letters are text', () => {
    // The whole reason the screen has a mode: `b`, `r`, `a` and `q` are ordinary
    // characters in a sentence like "because the refuter is right".
    for (const name of ['r', 'b', 'a', 'q', 'j', 'k']) {
      expect(resolveReviewAction(key(name), rationale)).toEqual({ type: 'none' })
    }
  })

  test('scrolling is a browse command, not a rationale-text key', () => {
    expect(resolveReviewAction(key('pageup'), rationale)).toEqual({ type: 'none' })
    expect(resolveReviewAction(key('pagedown'), rationale)).toEqual({ type: 'none' })
  })

  test('enter records the decision and escape abandons it', () => {
    expect(resolveReviewAction(key('return'), rationale)).toEqual({ type: 'submit-decision' })
    expect(resolveReviewAction(key('escape'), rationale)).toEqual({ type: 'cancel-decision' })
    expect(resolveReviewAction(key('c', { ctrl: true }), rationale)).toEqual({
      type: 'cancel-decision',
    })
  })

  test('L walks the arrangement, however the terminal spells a shifted letter', () => {
    expect(resolveReviewAction(key('L'), browse)).toEqual({ type: 'cycle-layout' })
    expect(resolveReviewAction(key('l', { shift: true }), browse)).toEqual({
      type: 'cycle-layout',
    })
    // Unshifted is deliberately inert: `L` is not next to the decision keys by
    // accident, and a researcher reaching for `r`/`b` must not rearrange the
    // screen instead.
    expect(resolveReviewAction(key('l'), browse)).toEqual({ type: 'none' })
  })

  test('t walks the palette', () => {
    expect(resolveReviewAction(key('t'), browse)).toEqual({ type: 'cycle-theme' })
  })

  test('neither arrangement key fires while the rationale is being typed', () => {
    expect(resolveReviewAction(key('L'), rationale)).toEqual({ type: 'none' })
    expect(resolveReviewAction(key('l', { shift: true }), rationale)).toEqual({
      type: 'none',
    })
    expect(resolveReviewAction(key('t'), rationale)).toEqual({ type: 'none' })
  })

  test('an unbound key does nothing in either mode', () => {
    expect(resolveReviewAction(key('x'), browse)).toEqual({ type: 'none' })
    expect(resolveReviewAction(key('x'), rationale)).toEqual({ type: 'none' })
  })
})

describe('the chat mode', () => {
  const chatIdle = { mode: 'chat' as const, chatBusy: false }
  const chatBusy = { mode: 'chat' as const, chatBusy: true }

  test('c opens the chat, and the decision keys are not live in it', () => {
    expect(resolveReviewAction(key('c'), browse)).toEqual({ type: 'enter-chat' })
    // The input owns the letters while it is focused, or `r` would record a decision
    // instead of starting a rationale that begins with the letter.
    expect(resolveReviewAction(key('r'), chatIdle)).toEqual({ type: 'none' })
    expect(resolveReviewAction(key('b'), chatIdle)).toEqual({ type: 'none' })
  })

  test('escape stops a running turn, and leaves when nothing is running', () => {
    // One key, two meanings, resolved by whether a turn is in flight. The distinction is
    // the point: stopping keeps the researcher's place in the queue, which is what makes
    // the pane and the card one surface rather than two screens.
    expect(resolveReviewAction(key('escape'), chatBusy)).toEqual({ type: 'abort-turn' })
    expect(resolveReviewAction(key('escape'), chatIdle)).toEqual({ type: 'cancel-chat' })
  })

  test('an absent busy flag means idle, so escape leaves', () => {
    expect(resolveReviewAction(key('escape'), { mode: 'chat' })).toEqual({
      type: 'cancel-chat',
    })
  })

  test('the transcript stays scrollable while a turn runs', () => {
    expect(resolveReviewAction(key('up'), chatBusy)).toEqual({ type: 'scroll-chat', delta: -1 })
    expect(resolveReviewAction(key('pagedown'), chatBusy)).toEqual({
      type: 'scroll-chat-page',
      pages: 1,
    })
  })

  test('tab switches the agent, in chat mode and nowhere else (§20.30)', () => {
    // `tab` rather than a letter, because every letter belongs to the question being
    // typed — the same reason `escape` is the only other key the mode claims.
    expect(resolveReviewAction(key('tab'), chatIdle)).toEqual({ type: 'switch-agent' })
    // And it is available with a turn running: the running turn keeps the agent it was
    // sent with, so switching changes the next question rather than this one.
    expect(resolveReviewAction(key('tab'), chatBusy)).toEqual({ type: 'switch-agent' })
    // Outside the chat it is nobody's key, so it must not rearrange the screen.
    expect(resolveReviewAction(key('tab'), browse)).toEqual({ type: 'none' })
  })
})

describe('the codebase mode (§20.30)', () => {
  const codebaseMode = { mode: 'codebase' as const }

  test('f opens the file listing', () => {
    expect(resolveReviewAction(key('f'), browse)).toEqual({ type: 'enter-codebase' })
  })

  test('escape and f both leave it, keeping the researcher in the queue', () => {
    expect(resolveReviewAction(key('escape'), codebaseMode)).toEqual({
      type: 'cancel-codebase',
    })
    expect(resolveReviewAction(key('f'), codebaseMode)).toEqual({ type: 'cancel-codebase' })
  })

  test('the decision keys are not live while a path is being read', () => {
    // The reason this is a mode rather than a flag: a `b` typed while scanning a
    // directory tree must not stage a `benign` verdict on the disagreement behind it.
    for (const name of ['r', 'b', 'a']) {
      expect(resolveReviewAction(key(name), codebaseMode)).toEqual({ type: 'none' })
    }
  })

  test('the arrows scroll the listing instead of moving the cursor', () => {
    // `j`/`k` are scroll keys here for the same reason: moving the selection would
    // show a different target's tree while the researcher was reading this one.
    expect(resolveReviewAction(key('down'), codebaseMode)).toEqual({
      type: 'scroll-codebase',
      delta: 1,
    })
    expect(resolveReviewAction(key('k'), codebaseMode)).toEqual({
      type: 'scroll-codebase',
      delta: -1,
    })
    expect(resolveReviewAction(key('pageup'), codebaseMode)).toEqual({
      type: 'scroll-codebase-page',
      pages: -1,
    })
    expect(resolveReviewAction(key('pagedown'), codebaseMode)).toEqual({
      type: 'scroll-codebase-page',
      pages: 1,
    })
  })

  test('q and ctrl+c still leave the screen', () => {
    expect(resolveReviewAction(key('q'), codebaseMode)).toEqual({ type: 'quit' })
    expect(resolveReviewAction(key('c', { ctrl: true }), codebaseMode)).toEqual({
      type: 'quit',
    })
  })
})
