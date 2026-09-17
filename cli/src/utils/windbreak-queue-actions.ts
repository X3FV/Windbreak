import { isPlainEnterKey } from './terminal-enter-detection'

import type { KeyEvent } from '@opentui/core'

import type { ReviewDecision } from '@codebuff/windbreak/review'

/**
 * What a keypress means inside the queue view.
 *
 * Kept out of the component for the same reason `queue-panel-actions.ts` is: the shortcut table is
 * then testable without a renderer, and the rules that decide *whether* a key is listened to are
 * stated in one place instead of being spread through a render.
 *
 * Two of those rules are the load-bearing ones:
 *
 * - **Escape means two different things.** While a rationale is open it cancels the input —
 *   because `recordAdjudicationDecision` has not run yet and a researcher who changes their mind
 *   must be able to take it back without leaving the queue. Otherwise it leaves the view.
 * - **The decisions are keys, not a prompt.** `r` and `b` are the whole reason this view exists:
 *   §5.3 makes the researcher's disagreement the tiebreak, and a decision typed into a chat
 *   message and executed by a model is a decision with an author nobody can name.
 */
export type WindbreakQueueAction =
  | { type: 'close' }
  /** Abandon the rationale input. Nothing is recorded. */
  | { type: 'cancel-rationale' }
  | { type: 'select'; delta: number }
  | { type: 'scroll'; delta: number }
  | { type: 'begin-rationale'; decision: ReviewDecision }
  | { type: 'toggle-resolved' }
  /** Open the investigator pane on the selected row (§20.38). */
  | { type: 'open-chat' }
  /**
   * Escape while the investigator pane is open.
   *
   * One action rather than two, because only the view knows what is in flight: a turn running is
   * stopped, an idle pane is closed.
   */
  | { type: 'chat-escape' }
  | { type: 'none' }

export interface WindbreakQueueKeyboardState {
  /**
   * True while the rationale input owns the keyboard.
   *
   * The input is a real text field — it has to be, because the rationale is this feature's
   * output — so the view listens for the way out and nothing else. `enter` deliberately does not
   * appear here: `MultilineInput.onSubmit` is what records the decision, and handling the key in
   * two places would record it twice.
   */
  typing: boolean
  /** False on an empty queue, a missing database, or a refusal: nothing to decide. */
  hasSelection: boolean
  /**
   * True while the investigator pane is open.
   *
   * Checked before `typing`, because that pane's input is *always* focused: the letters belong to
   * it, and the only keys that mean something to the view are the way out and the scroll.
   */
  chatting: boolean
}

export function resolveWindbreakQueueAction(
  key: KeyEvent,
  state: WindbreakQueueKeyboardState,
): WindbreakQueueAction {
  const isEscape = key.name === 'escape'
  const isCtrlC = key.ctrl && key.name === 'c'

  if (state.chatting) {
    // The one mode where Escape does not leave the view: it stops the turn or closes the pane,
    // and the pane says which. Every other key is the researcher's text — including `q` and the
    // decision keys, which are ordinary letters inside a question.
    if (isEscape || isCtrlC) return { type: 'chat-escape' }
    if (key.name === 'pageup' || key.sequence === 'K') return { type: 'scroll', delta: 1 }
    if (key.name === 'pagedown' || key.sequence === 'J') return { type: 'scroll', delta: -1 }
    return { type: 'none' }
  }

  if (state.typing) {
    return isEscape || isCtrlC ? { type: 'cancel-rationale' } : { type: 'none' }
  }

  // `q` covers ctrl+q too, so the letter that names the queue closes it, and it stays true that
  // Escape leaves — a takeover view with no way out is a trap the composer cannot talk you out of.
  if (isEscape || isCtrlC || key.name === 'q') return { type: 'close' }

  // Page keys scroll the detail pane; selection stays on the arrows so the two never collide on
  // the same keypress. Terminals disagree about modified arrows, so shift+↑/↓ scrolls too —
  // and `K`/`J` are the plain printable stand-ins `queue-panel` settled on for the same reason.
  if (key.name === 'pageup' || (key.name === 'up' && (key.shift || key.ctrl)) || key.sequence === 'K') {
    return { type: 'scroll', delta: 1 }
  }
  if (
    key.name === 'pagedown' ||
    (key.name === 'down' && (key.shift || key.ctrl)) ||
    key.sequence === 'J'
  ) {
    return { type: 'scroll', delta: -1 }
  }

  if (key.name === 'up' || key.name === 'k') return { type: 'select', delta: -1 }
  if (key.name === 'down' || key.name === 'j') return { type: 'select', delta: 1 }

  // `a` for all: the batch command spells the same idea `--all`, and the queue is
  // pending-only by default because that is the work.
  if (key.name === 'a') return { type: 'toggle-resolved' }

  // `c` for chat: asking about the selected row, §20.29's investigator rather than the deciding
  // agent. Offered with no selection too — a question about the target as a whole is answerable
  // and is what `/hunt` is for.
  if (key.name === 'c') return { type: 'open-chat' }

  if (state.hasSelection && key.name === 'r') {
    return { type: 'begin-rationale', decision: 'real' }
  }
  if (state.hasSelection && key.name === 'b') {
    return { type: 'begin-rationale', decision: 'benign' }
  }

  // Enter opens the rationale for `real`, the decision a researcher reaches for when they are
  // sure. It is not a confirm key: there is nothing to confirm until the input is submitted.
  if (state.hasSelection && isPlainEnterKey(key)) {
    return { type: 'begin-rationale', decision: 'real' }
  }

  return { type: 'none' }
}
