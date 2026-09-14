import { isPlainEnterKey } from '../utils/terminal-enter-detection'

import type { KeyEvent } from '@opentui/core'

/**
 * The adjudication screen's shortcut table, kept out of the component so it can
 * be tested without a renderer — the same split the chat's own shortcut
 * resolution and the queue panel use.
 */

export type ReviewDecision = 'real' | 'benign'

/**
 * `browse` is the list; `rationale` is the same screen with the rationale input focused;
 * `chat` is the same screen with the investigator's input focused — and, since §20.32, the
 * conversation occupying the body beside a narrow queue rail; `codebase` is the same
 * screen with the file listing where the arguments were.
 *
 * The mode is the whole of the state machine: while an input is focused the letters `r`,
 * `b`, `a` and `q` are text the researcher is typing, not commands, so the screen must
 * not act on them. That rule is why `chat` exists as a mode rather than as a flag beside
 * the others — a chat that left the decision keys live would swallow them into the
 * question being typed.
 *
 * `codebase` earns a mode for the same reason even though it has no input: it moves the
 * scroll keys, and a read view whose `j`/`k` still moved the queue cursor would send the
 * researcher to a different disagreement while they were reading paths.
 */
export type ReviewMode = 'browse' | 'rationale' | 'chat' | 'codebase'

/**
 * Rows a wheel notch moves, shared by the queue list and the detail pane so one
 * notch feels the same wherever the cursor is.
 */
export const WHEEL_ROWS = 3

export type ReviewAction =
  | { type: 'quit' }
  | { type: 'select'; delta: number }
  | { type: 'begin-decision'; decision: ReviewDecision }
  | { type: 'cancel-decision' }
  | { type: 'submit-decision' }
  | { type: 'toggle-resolved' }
  /** Open the investigator's pane (§20.29.4). */
  | { type: 'enter-chat' }
  | { type: 'cancel-chat' }
  /**
   * Stop the turn that is running (§20.29.5 slice 6).
   *
   * Distinct from `cancel-chat`, which leaves the pane: stopping a turn keeps the seat in
   * the queue and the transcript, which is the whole reason the two are one surface.
   */
  | { type: 'abort-turn' }
  /**
   * Switch between §20.30's two agents: the investigator answers about the target, the
   * engineer edits the working copy.
   *
   * `tab` rather than a letter, because in chat mode every letter belongs to the
   * question being typed — the same reason `esc` is the only other key the mode claims.
   * The turn a switch is made during keeps the agent it started with: the agent is
   * captured when the question is sent, not read from the screen when it settles.
   */
  | { type: 'switch-agent' }
  | { type: 'submit-chat' }
  /** Scroll the transcript by rows; the pane decides how many it can show. */
  | { type: 'scroll-chat'; delta: number }
  /** Scroll the transcript by pages. */
  | { type: 'scroll-chat-page'; pages: number }
  /** Open the file listing (§20.30). */
  | { type: 'enter-codebase' }
  | { type: 'cancel-codebase' }
  /** Scroll the file listing by rows; the pane decides how many it can show. */
  | { type: 'scroll-codebase'; delta: number }
  /** Scroll the file listing by pages. */
  | { type: 'scroll-codebase-page'; pages: number }
  /** Scroll the detail pane by pages; the pane decides how many rows that is. */
  | { type: 'scroll-detail'; pages: number }
  /** Walk the arrangement: auto → three panes → queue + detail → stacked (§20.16). */
  | { type: 'cycle-layout' }
  /** Walk the palette: default → contrast → reading (§20.16). */
  | { type: 'cycle-theme' }
  | { type: 'none' }

export const resolveReviewAction = (
  key: KeyEvent,
  state: {
    mode: ReviewMode
    /**
     * Whether a turn is in flight, so `esc` can mean "stop it" rather than "leave".
     *
     * Read from the screen's abort handle rather than from a state flag: the handle is
     * set synchronously when a turn starts and cleared when it settles, so this cannot
     * lag the keystroke the way a `pending` boolean committed through a render can.
     */
    chatBusy?: boolean
  },
): ReviewAction => {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'

  if (state.mode === 'rationale') {
    // The focused input owns every other key, including the ones that are
    // commands in browse mode.
    if (isEscape || isCtrlC) return { type: 'cancel-decision' }
    if (isPlainEnterKey(key)) return { type: 'submit-decision' }
    return { type: 'none' }
  }

  if (state.mode === 'codebase') {
    // A read view: `esc` and `f` both leave it, the arrows and the page keys scroll it,
    // and every other letter is deliberately *nothing*. The decision keys are not live
    // here because the researcher is reading a path, not deciding — and because a `b`
    // typed while scanning a directory tree staging a `benign` verdict is the kind of
    // thing that costs a false resolution.
    if (isEscape || key.name === 'f') return { type: 'cancel-codebase' }
    if (isCtrlC || key.name === 'q') return { type: 'quit' }
    if (key.name === 'up' || key.name === 'k') return { type: 'scroll-codebase', delta: -1 }
    if (key.name === 'down' || key.name === 'j') return { type: 'scroll-codebase', delta: 1 }
    if (key.name === 'pageup') return { type: 'scroll-codebase-page', pages: -1 }
    if (key.name === 'pagedown') return { type: 'scroll-codebase-page', pages: 1 }
    return { type: 'none' }
  }

  if (state.mode === 'chat') {
    // Same rule: the input owns the letters. The exceptions are navigation — a
    // transcript is longer than the pane and reading it is the point — and Escape,
    // which leaves the chat rather than the screen, so the researcher keeps their seat
    // in the queue.
    // One key, two meanings, resolved by whether anything is running: while a turn is in
    // flight `esc` stops it, and when nothing is it leaves the chat. Making "stop" a
    // separate key would put it where the researcher is not looking.
    if (isEscape) return state.chatBusy ? { type: 'abort-turn' } : { type: 'cancel-chat' }
    if (isCtrlC) return { type: 'quit' }
    if (key.name === 'tab') return { type: 'switch-agent' }
    if (isPlainEnterKey(key)) return { type: 'submit-chat' }
    // §20.32 puts the queue on screen beside the transcript, so the cursor has to be
    // movable without leaving the chat. A *modified* arrow, because the plain arrow is
    // the transcript's own scroll and because no letter may be claimed here: `ctrl+↓`
    // moves the seat without becoming part of the question being typed.
    if (key.ctrl && key.name === 'up') return { type: 'select', delta: -1 }
    if (key.ctrl && key.name === 'down') return { type: 'select', delta: 1 }
    if (key.name === 'up') return { type: 'scroll-chat', delta: -1 }
    if (key.name === 'down') return { type: 'scroll-chat', delta: 1 }
    if (key.name === 'pageup') return { type: 'scroll-chat-page', pages: -1 }
    if (key.name === 'pagedown') return { type: 'scroll-chat-page', pages: 1 }
    return { type: 'none' }
  }

  if (isEscape || isCtrlC || key.name === 'q') return { type: 'quit' }

  if (key.name === 'up' || key.name === 'k') return { type: 'select', delta: -1 }
  if (key.name === 'down' || key.name === 'j') return { type: 'select', delta: 1 }

  // `r`/`b` are the two §5.3 outcomes, named after the researcher's conclusion
  // rather than after which model they sided with: the queue exists because the
  // models disagreed, so "the Proposer won" is not a decision the researcher is
  // making — "the bug is real" is.
  if (key.name === 'r') return { type: 'begin-decision', decision: 'real' }
  if (key.name === 'b') return { type: 'begin-decision', decision: 'benign' }

  if (key.name === 'a') return { type: 'toggle-resolved' }

  // `f` for files. Unclaimed, and next to the other view keys; the screen refuses it
  // when there is no inventory, the same way it refuses `c` without an investigator.
  if (key.name === 'f') return { type: 'enter-codebase' }

  // `c` for chat. It is the only unclaimed letter left that names its surface, and the
  // keys that surround it (`r`/`b`) are the decisions — which is the right neighbourhood,
  // because asking the investigator is what a researcher does when they cannot decide.
  if (key.name === 'c') return { type: 'enter-chat' }

  // `L` rather than `l`: the plain letter is close enough to the decision keys
  // that a researcher reaching for a rationale could rearrange the screen
  // instead. Both spellings are accepted because terminals disagree about
  // whether a shifted letter arrives as `L` or as `l` with a modifier.
  if (key.name === 'L' || (key.name === 'l' && key.shift)) {
    return { type: 'cycle-layout' }
  }
  if (key.name === 't' && !key.ctrl && !key.meta) return { type: 'cycle-theme' }

  // The detail pane is mouse-scrollable; these keep it reachable without one,
  // which matters because the case for a finding is read, not skimmed.
  if (key.name === 'pageup') return { type: 'scroll-detail', pages: -1 }
  if (key.name === 'pagedown') return { type: 'scroll-detail', pages: 1 }

  return { type: 'none' }
}
