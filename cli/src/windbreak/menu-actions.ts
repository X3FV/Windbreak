/**
 * The start menu's shortcut table (spec §20.33), kept out of the component so it can be
 * tested without a renderer — the same split `actions.ts` makes for the queue screen.
 *
 * The screens are one component because they are one *passage*: menu → a list → a reading
 * view, with `esc` stepping back. Two keys mean different things on different screens
 * (`enter` chooses a row on the menu and opens the queue after a scan; `esc` leaves a
 * listing and *quits* while a scan is running, because there is nowhere behind it that
 * would not abandon the run), and a table is the honest place to say so.
 */

import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { KeyEvent } from '@opentui/core'

export type MenuScreen = 'menu' | 'runs' | 'files' | 'scan'

export type MenuAction =
  | { type: 'quit' }
  /** Leave this screen for the one it was opened from. */
  | { type: 'back' }
  | { type: 'select'; delta: number }
  | { type: 'page'; pages: number }
  /** Open the selected row. */
  | { type: 'choose' }
  /** Continue the selected run's scan from its first incomplete stage. */
  | { type: 'resume-run' }
  /** Open the adjudication queue for the run the finished scan produced. */
  | { type: 'open-queue' }
  | { type: 'none' }

export const resolveMenuAction = (
  key: KeyEvent,
  state: {
    screen: MenuScreen
    /** True once a scan has stopped — finished or failed — so `esc` can go back. */
    scanDone?: boolean
    /** True only for a scan that produced a run, which is when `enter` has a queue. */
    scanOpenable?: boolean
  },
): MenuAction => {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'
  const up = key.name === 'up' || key.name === 'k'
  const down = key.name === 'down' || key.name === 'j'

  if (state.screen === 'menu') {
    if (isEscape || isCtrlC || key.name === 'q') return { type: 'quit' }
    if (up) return { type: 'select', delta: -1 }
    if (down) return { type: 'select', delta: 1 }
    if (isPlainEnterKey(key)) return { type: 'choose' }
    return { type: 'none' }
  }

  if (state.screen === 'runs') {
    if (isEscape) return { type: 'back' }
    if (isCtrlC || key.name === 'q') return { type: 'quit' }
    if (up) return { type: 'select', delta: -1 }
    if (down) return { type: 'select', delta: 1 }
    if (key.name === 'pageup') return { type: 'page', pages: -1 }
    if (key.name === 'pagedown') return { type: 'page', pages: 1 }
    if (isPlainEnterKey(key)) return { type: 'choose' }
    // `r` is the letter `resume` already has in the batch surface (`windbreak resume`), and
    // it is free here: this screen decides nothing, so there is no `r real` to collide
    // with — the queue's own `r` lives in a different component, mounted at a different
    // time.
    if (key.name === 'r') return { type: 'resume-run' }
    return { type: 'none' }
  }

  if (state.screen === 'files') {
    // The same keys the queue screen's own file mode claims, so the listing behaves the
    // same wherever it is opened from.
    if (isEscape || key.name === 'f') return { type: 'back' }
    if (isCtrlC || key.name === 'q') return { type: 'quit' }
    if (up) return { type: 'select', delta: -1 }
    if (down) return { type: 'select', delta: 1 }
    if (key.name === 'pageup') return { type: 'page', pages: -1 }
    if (key.name === 'pagedown') return { type: 'page', pages: 1 }
    return { type: 'none' }
  }

  // The scan screen. While the run is working there is no way back that is not also a way
  // to abandon it: this screen *is* the run, in-process, so `esc` quits the command rather
  // than leaving a process that would keep going. The run that got as far as it got stays
  // in the database, which is what makes it resumable — the hint row says so.
  if (state.scanDone === true) {
    if (isEscape) return { type: 'back' }
    if (isCtrlC || key.name === 'q') return { type: 'quit' }
    // A failed scan has no queue to open, so `enter` is nothing there rather than a key
    // that would open the previous run's — see the component's `open-queue` handling.
    if (isPlainEnterKey(key) && state.scanOpenable === true) return { type: 'open-queue' }
  } else if (isEscape || isCtrlC || key.name === 'q') {
    return { type: 'quit' }
  }

  if (up) return { type: 'select', delta: -1 }
  if (down) return { type: 'select', delta: 1 }
  if (key.name === 'pageup') return { type: 'page', pages: -1 }
  if (key.name === 'pagedown') return { type: 'page', pages: 1 }
  return { type: 'none' }
}
