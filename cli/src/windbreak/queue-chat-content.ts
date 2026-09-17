/**
 * What the queue view's investigator pane says (§20.29.4, §20.29.6, §18).
 *
 * Pure content again, and the honesty rules are the reason it is a module rather than JSX in the
 * view — every one of them is a rule about *what may not be implied*:
 *
 * 1. **A pending turn stops before its answer.** The transcript is built from finished turns, and
 *    the running one is drawn as "investigating", so a reply cannot be read before it arrives.
 * 2. **A stopped turn is not a broken one.** `cancelled` is said in its own words, because the
 *    researcher who pressed `esc` needs to know that is what happened.
 * 3. **An answer is not a decision.** The pane says so where a reader starts using it, and a
 *    recorded candidate is drawn as *recorded*, in its own block, with the model's own CWE label —
 *    never as an assessed class (§20.29.4). What it says is recorded beside the two arguments; the
 *    row's decision is still `recordAdjudicationDecision`.
 * 4. **A turn that is not on record says so.** §20.29.3 makes the answer a stored artifact, so a
 *    turn whose `investigator_turns` write failed must not read as one that will still be there.
 * 5. **The ceiling is stated when it is spent, with the way out.** A disabled input with no
 *    explanation is §18 in the pane's own chrome.
 * 6. **A refusal is a state of the conversation, not of the question.** An account-level failure
 *    repeats for every question, so it belongs above the input and not only in the transcript.
 */

import { describeProviderFailure } from '@codebuff/windbreak/review'

import type { ProviderFailure } from '@codebuff/windbreak/review'
import type { ConversationBudgetState } from '@codebuff/windbreak/review'
import type { InvestigatorAgentName, InvestigatorMode } from '@codebuff/windbreak/review'
import type { ProposedSite, ProposalRejection } from '@codebuff/windbreak/review'
import type { InjectionSignal } from '@codebuff/windbreak/review'
import type { QueueLine, QueueTone } from './queue-content'

/** `/hunt` asks the whole target instead of the selected row (§20.29.4's two modes). */
export const QUEUE_HUNT_PREFIX = '/hunt'

export const QUEUE_CHAT_HINTS =
  'type a question · enter sends · /hunt asks the whole target · esc closes'

/**
 * Why the input is gone rather than empty.
 *
 * `esc` is the way out and it is named: a ceiling with no stated exit is a broken pane.
 */
export const QUEUE_CHAT_EXHAUSTED_NOTE =
  'ceiling spent — esc closes this pane; reopening starts a fresh conversation'

/** One question and what came back, as the pane holds them. */
export interface QueueChatTurn {
  /**
   * Who answered. Widened to the engine's union rather than narrowed to the read-only investigator,
   * because a turn the engineer answered wrote to a working copy and must not read as one that
   * only read (§20.30).
   */
  agent: InvestigatorAgentName
  mode: InvestigatorMode
  prompt: string
  answer: string | null
  error: string | null
  cancelled: boolean
  pending: boolean
  writes: readonly { action: string; path: string; inserted: number; removed: number }[]
  proposals: readonly ProposedSite[]
  proposalRejections: readonly ProposalRejection[]
  injectionSignals: readonly InjectionSignal[]
  toolsUsed: readonly string[]
  recordedTurnId: string | null
  budget: ConversationBudgetState
}

export interface ParsedQueueChatInput {
  mode: InvestigatorMode
  prompt: string
}

/**
 * Read one line of input.
 *
 * Null for whitespace and for a bare `/hunt`: sending either would spend a model call to ask
 * nothing, and a pane that did is worse than one that did not.
 */
export const parseQueueChatInput = (
  input: string,
  fallbackMode: InvestigatorMode,
): ParsedQueueChatInput | null => {
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed === QUEUE_HUNT_PREFIX) return null

  if (trimmed.startsWith(`${QUEUE_HUNT_PREFIX} `)) {
    const prompt = trimmed.slice(QUEUE_HUNT_PREFIX.length).trim()
    return prompt.length > 0 ? { mode: 'hunt', prompt } : null
  }

  return { mode: fallbackMode, prompt: trimmed }
}

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`

/** Tokens over a thousand, abbreviated: the exact figure is not the point. */
const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`

/**
 * The conversation's budget, one line (§20.29.6).
 *
 * `used/limit` rather than "n left", because that pair says both what was spent and what the
 * ceiling is — a remaining count alone cannot distinguish "nearly over" from "barely begun". Null
 * renders as the empty string so a caller without a bridge has no line rather than a wrong one.
 */
export const describeQueueBudget = (state: ConversationBudgetState | null): string => {
  if (state === null) return ''

  const spent = `${state.calls}/${state.limit} model calls`
  const turns = state.turns === 0 ? 'no turns yet' : countLabel(state.turns, 'turn')
  const tokens = state.tokens > 0 ? ` · ${formatTokens(state.tokens)} tokens` : ''

  return state.exhausted
    ? `budget spent: ${spent} · ${turns}${tokens}`
    : `budget: ${spent} · ${turns}${tokens}`
}

/**
 * What the next question is about.
 *
 * The pane's own header line, so a researcher cannot ask about one candidate while looking at
 * another — the selection is the subject, and saying which row it is costs one line.
 */
export const describeQueueChatTarget = (input: {
  candidateId: string | null
  /** `/hunt` typed but not yet sent is not bindable to a row: it says so. */
  mode: InvestigatorMode
  filePath: string | null
  startLine: number | null
}): string => {
  if (input.mode === 'hunt') {
    return 'hunting the whole target: candidates it proposes are recorded, not decided'
  }
  if (input.candidateId === null) {
    return 'no candidate selected — questions are answered about the target as a whole'
  }
  const location =
    input.filePath === null
      ? 'a candidate with no location on record'
      : input.startLine === null
        ? input.filePath
        : `${input.filePath}:${input.startLine}`
  return `about ${location}`
}

/** Where a proposal came from, one line, with the model's own class label if it gave one. */
export const describeQueueProposal = (site: ProposedSite): string => {
  const range =
    site.endLine !== site.startLine
      ? `${site.filePath}:${site.startLine}-${site.endLine}`
      : `${site.filePath}:${site.startLine}`
  return site.cwe === null ? range : `${range} (${site.cwe}, as the model labelled it)`
}

const line = (text: string, tone: QueueTone = 'normal', indent = 0): QueueLine => ({
  kind: 'text',
  text,
  tone,
  indent,
})

/**
 * The question, with the qualifiers that change what the answer means.
 *
 * Named only when present: a `you ›` line with no qualifier is the common case, and a qualifier that
 * is always there stops being read. `engineer` is one of them deliberately — that turn held a
 * writable copy.
 */
const questionLine = (turn: QueueChatTurn): string => {
  const qualifiers = [
    turn.mode === 'hunt' ? 'hunt' : null,
    turn.agent === 'engineer' ? 'engineer' : null,
  ].filter((qualifier): qualifier is string => qualifier !== null)

  return qualifiers.length === 0
    ? `you › ${turn.prompt}`
    : `you (${qualifiers.join(', ')}) › ${turn.prompt}`
}

/** The pane before anything has been asked. */
const openingLines = (): QueueLine[] => [
  line(
    'Ask about the candidate that is selected, or start a line with /hunt to search the whole target.',
  ),
  line(''),
  line(
    'The investigator answers from the target: it can read the checkout and run commands in it, sandboxed, and it cannot change it.',
    'muted',
  ),
  line(''),
  line(
    'It does not decide anything. What it says is recorded beside the two arguments and you still rule on the row — which is why the decision keys stay where they are.',
    'muted',
  ),
]

/**
 * The transcript, as the pane's lines.
 *
 * Finished turns only; the running one is rendered by its own branch so its answer cannot appear
 * before it exists, and its `pending` flag is what the pane uses to refuse a second question.
 */
export const buildQueueChatLines = (turns: readonly QueueChatTurn[]): QueueLine[] => {
  // The opening prose stays at the head of the transcript rather than being replaced by the first
  // answer. It carries the pane's own terms — an answer is not a decision, and the target cannot be
  // changed — and a transcript that dropped them would go on answering under terms a reader never
  // saw. It scrolls like any other line; the newest rows are still what the pane opens on.
  const lines: QueueLine[] = openingLines()

  for (const turn of turns) {
    lines.push(line(''))

    lines.push(line(questionLine(turn), 'info'))

    if (turn.pending) {
      lines.push(line('  … investigating (esc stops it)', 'muted'))
      continue
    }

    if (turn.cancelled) {
      // Said first and in its own words, so "you stopped it" cannot read as "it failed".
      lines.push(line('  ! cancelled — you stopped this turn', 'warning'))
    } else if (turn.error !== null) {
      // The failure first and labelled, so it cannot be mistaken for the answer.
      lines.push(line(`  ! ${turn.error}`, 'error'))
    }

    if (turn.answer !== null && turn.answer.trim().length > 0) {
      for (const part of turn.answer.split('\n')) lines.push(line(`  ${part}`))
    } else if (turn.error === null && !turn.cancelled) {
      lines.push(line('  (no answer)', 'muted'))
    }

    if (turn.writes.length > 0) {
      lines.push(
        line(''),
        line(`  edited ${countLabel(turn.writes.length, 'file')} in the working copy:`, 'info'),
      )
      for (const write of turn.writes) {
        const counts =
          write.inserted > 0 || write.removed > 0
            ? ` (+${write.inserted}/-${write.removed})`
            : ''
        lines.push(line(`    ${write.action} ${write.path}${counts}`, 'normal', 0))
      }
      lines.push(line('    the target is unchanged — these edits are in the copy.', 'muted'))
    }

    if (turn.proposals.length > 0) {
      lines.push(
        line(''),
        line(
          `  recorded ${countLabel(turn.proposals.length, 'candidate')} — these enter the pipeline like any other and still have to pass triage and verification:`,
          'warning',
        ),
      )
      for (const site of turn.proposals) {
        lines.push(line(`    ${describeQueueProposal(site)}`, 'normal'))
      }
    }

    for (const rejection of turn.proposalRejections) {
      // Worth showing: it is how a researcher notices a model aiming at files that are not there,
      // which is a fact about the answer's reliability.
      lines.push(line(`    refused ${rejection.requestedPath}: ${rejection.reason}`, 'warning'))
    }

    if (turn.injectionSignals.length > 0) {
      // §5.1 reaches the pane: the reader is being asked to weigh reasoning that a hostile file
      // tried to steer.
      const kinds = [...new Set(turn.injectionSignals.map((signal) => signal.kind))]
      lines.push(
        line(
          `  ! target content tried to instruct the model (${kinds.join(', ')}); its text was neutralised before the model saw it, but weigh the answer accordingly`,
          'warning',
        ),
      )
    }

    if (turn.toolsUsed.length > 0) {
      lines.push(
        line(`  [${countLabel(turn.toolsUsed.length, 'tool call')}: ${turn.toolsUsed.join(', ')}]`, 'muted'),
      )
    }

    if (turn.recordedTurnId === null) {
      lines.push(line('  ! this turn is not on record, so it will not be there next time', 'error'))
    }
  }

  return lines
}

/** The refusal banner above the input, or null when the conversation has not hit one. */
export const describeQueueRefusal = (refusal: ProviderFailure | null): string | null =>
  refusal === null ? null : describeProviderFailure(refusal)
