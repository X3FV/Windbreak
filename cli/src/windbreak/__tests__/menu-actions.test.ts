import { describe, expect, test } from 'bun:test'

import { resolveMenuAction } from '../menu-actions'

import type { KeyEvent } from '@opentui/core'

const key = (
  name: string,
  modifiers: { shift?: boolean; ctrl?: boolean } = {},
): KeyEvent =>
  ({
    name,
    shift: modifiers.shift === true,
    ctrl: modifiers.ctrl === true,
    meta: false,
    option: false,
    sequence: name === 'return' ? '\r' : name,
  }) as KeyEvent

describe('the start menu', () => {
  test('arrows move, enter chooses, q and escape quit', () => {
    const menu = { screen: 'menu' as const }
    expect(resolveMenuAction(key('down'), menu)).toEqual({ type: 'select', delta: 1 })
    expect(resolveMenuAction(key('j'), menu)).toEqual({ type: 'select', delta: 1 })
    expect(resolveMenuAction(key('up'), menu)).toEqual({ type: 'select', delta: -1 })
    expect(resolveMenuAction(key('return'), menu)).toEqual({ type: 'choose' })
    expect(resolveMenuAction(key('q'), menu)).toEqual({ type: 'quit' })
    expect(resolveMenuAction(key('escape'), menu)).toEqual({ type: 'quit' })
    expect(resolveMenuAction(key('c', { ctrl: true }), menu)).toEqual({ type: 'quit' })
  })

  test('a letter that is not a key is nothing, so typing cannot navigate', () => {
    expect(resolveMenuAction(key('x'), { screen: 'menu' })).toEqual({ type: 'none' })
  })
})

describe('the runs screen', () => {
  const runs = { screen: 'runs' as const }

  test('escape goes back and q quits, which are different verbs', () => {
    expect(resolveMenuAction(key('escape'), runs)).toEqual({ type: 'back' })
    expect(resolveMenuAction(key('q'), runs)).toEqual({ type: 'quit' })
  })

  test('enter opens the selected row and r continues its scan', () => {
    expect(resolveMenuAction(key('return'), runs)).toEqual({ type: 'choose' })
    expect(resolveMenuAction(key('r'), runs)).toEqual({ type: 'resume-run' })
  })

  test('the page keys move the list by pages', () => {
    expect(resolveMenuAction(key('pagedown'), runs)).toEqual({ type: 'page', pages: 1 })
    expect(resolveMenuAction(key('pageup'), runs)).toEqual({ type: 'page', pages: -1 })
  })
})

describe('the files screen', () => {
  const files = { screen: 'files' as const }

  test('f and escape both leave the listing, as they do inside the queue', () => {
    expect(resolveMenuAction(key('f'), files)).toEqual({ type: 'back' })
    expect(resolveMenuAction(key('escape'), files)).toEqual({ type: 'back' })
  })

  test('the scroll keys move the listing rather than a cursor', () => {
    expect(resolveMenuAction(key('down'), files)).toEqual({ type: 'select', delta: 1 })
    expect(resolveMenuAction(key('pageup'), files)).toEqual({ type: 'page', pages: -1 })
  })

  test('q quits rather than going back', () => {
    expect(resolveMenuAction(key('q'), files)).toEqual({ type: 'quit' })
  })
})

describe('the scan screen', () => {
  const running = { screen: 'scan' as const, scanDone: false, scanOpenable: false }

  test('while it runs, leaving is quitting — this screen is the run', () => {
    expect(resolveMenuAction(key('escape'), running)).toEqual({ type: 'quit' })
    expect(resolveMenuAction(key('q'), running)).toEqual({ type: 'quit' })
    expect(resolveMenuAction(key('c', { ctrl: true }), running)).toEqual({ type: 'quit' })
  })

  test('while it runs, enter opens nothing', () => {
    expect(resolveMenuAction(key('return'), running)).toEqual({ type: 'none' })
  })

  test('a finished scan keeps enter for the queue and escape for the menu', () => {
    const done = { screen: 'scan' as const, scanDone: true, scanOpenable: true }
    expect(resolveMenuAction(key('return'), done)).toEqual({ type: 'open-queue' })
    expect(resolveMenuAction(key('escape'), done)).toEqual({ type: 'back' })
    // The summary now has a screen behind it, so the letters the run claimed as "quit"
    // keep that meaning rather than becoming a way out of the pane.
    expect(resolveMenuAction(key('q'), done)).toEqual({ type: 'quit' })
  })

  test('a failed scan can be left, but has no queue to open', () => {
    const failed = { screen: 'scan' as const, scanDone: true, scanOpenable: false }
    expect(resolveMenuAction(key('escape'), failed)).toEqual({ type: 'back' })
    expect(resolveMenuAction(key('return'), failed)).toEqual({ type: 'none' })
  })

  test('the log scrolls with the same keys as the other read views', () => {
    expect(resolveMenuAction(key('down'), running)).toEqual({ type: 'select', delta: 1 })
    expect(resolveMenuAction(key('pageup'), running)).toEqual({ type: 'page', pages: -1 })
  })
})
