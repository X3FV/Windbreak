import { wrapText, shortenPath } from './text'

import type { ReviewCounts, ReviewEntrySummary } from '@codebuff/windbreak/review'
import type { ReviewDecision, ReviewMode } from './actions'

/**
 * The decision card's content as data (spec §20.16).
 *
 * The same split the detail pane uses, for the same reason: the card is a narrow
 * column, so what fits is a question worth answering in a test rather than by
 * looking at a terminal. It also keeps the *tone* vocabulary separate from the
 * detail pane's — a decision card has no `evidence` or `rule` tone of its own,
 * and the detail pane has no use for `notice` or `error`.
 */

export type DecisionTone =
  | 'label'
  | 'value'
  | 'muted'
  | 'idle'
  | 'notice'
  | 'error'
  | 'real'
  | 'benign'
  | 'rule'

export interface DecisionSpan {
  text: string
  tone: DecisionTone
}

export interface DecisionLine {
  spans: DecisionSpan[]
}

/**
 * The last write, and whether it landed.
 *
 * A result rather than a string: §18's whole subject is that "it worked" and "it
 * did not" are different claims, and a card that inferred the difference from
 * whether the message matched `error` would eventually colour a success that
 * mentioned an error, or a failure that did not.
 */
export interface DecisionNotice {
  text: string
  failed: boolean
}

export interface DecisionCardInput {
  /** The entry the cursor is on, or null when there is nothing to decide. */
  entry: ReviewEntrySummary | null
  /** The candidate's pipeline state, from the detail read (§5.3). */
  candidateState: string | null
  counts: ReviewCounts
  /** The staged decision, before Enter. */
  pendingDecision: ReviewDecision | null
  mode: ReviewMode
  notice: DecisionNotice | null
  includeResolved: boolean
  layoutLabel: string
  themeLabel: string
  /** Inner width of the column, borders and padding excluded. */
  contentWidth: number
}

export interface DecisionCard {
  lines: DecisionLine[]
  /**
   * The row the rationale input occupies, or null when there is none.
   *
   * The input is a live renderable rather than a line, so it cannot simply live
   * in `lines`; naming its row keeps the rest of the card in the data model and
   * lets the pane render the input at a position the card decided, not the pane.
   * The builder still emits a placeholder line there so the card's row count is
   * the truth.
   */
  rationaleRow: number | null
}

const line = (text: string, tone: DecisionTone = 'value'): DecisionLine => ({
  spans: [{ text, tone }],
})

const rule = (width: number): DecisionLine =>
  line('─'.repeat(Math.max(1, Math.min(width, 60))), 'rule')

/**
 * Build the card, top to bottom.
 *
 * Order is the workflow: what is being decided, what is staged, what happened
 * last, how much is left, and how the screen is arranged. The key hints live on
 * the screen's own hint row rather than here — one list of keys, in one place,
 * is the only way it stays true.
 */
export const buildDecisionCard = (input: DecisionCardInput): DecisionCard => {
  const width = Math.max(8, Math.floor(input.contentWidth))
  const lines: DecisionLine[] = []

  // ---- the entry ----------------------------------------------------------
  lines.push(line('entry', 'label'))
  if (!input.entry) {
    lines.push(line('  nothing selected', 'idle'))
  } else {
    lines.push(
      line(
        `  ${input.entry.candidateId}${input.candidateState ? `  ${input.candidateState}` : ''}`,
        'value',
      ),
    )
    for (const part of wrapText(
      input.entry.filePath
        ? `${shortenPath(input.entry.filePath, 2)}:${input.entry.startLine ?? '?'}`
        : '(location unknown)',
      width - 2,
    )) {
      lines.push(line(`  ${part}`, 'muted'))
    }
    const detected = input.entry.patternId
      ? `${input.entry.source}/${input.entry.patternId}`
      : input.entry.source
    for (const part of wrapText(detected, width - 2)) {
      lines.push(line(`  ${part}`, 'muted'))
    }
  }

  lines.push(rule(width))

  // ---- the staged decision ------------------------------------------------
  lines.push(line('decision', 'label'))
  let rationaleRow: number | null = null
  if (input.pendingDecision) {
    lines.push(
      line(
        `  ${input.pendingDecision}`,
        input.pendingDecision === 'real' ? 'real' : 'benign',
      ),
    )
    // The keys live in the card rather than in the input's placeholder: the
    // decision column can be twenty columns wide, and a placeholder is clipped
    // mid-word there — which would leave a researcher holding a focused input
    // with no visible way out of it. A wrapped line survives any column.
    for (const part of wrapText('Enter records · Esc cancels', width - 2)) {
      lines.push(line(`  ${part}`, 'muted'))
    }
    // A placeholder rather than a gap: the input is a live renderable, but its
    // row has to exist in the line list for the card's height arithmetic — and
    // the pane's index — to stay honest.
    lines.push(line('  ', 'idle'))
    rationaleRow = lines.length - 1
  } else {
    for (const part of wrapText('none staged — r real, b benign', width - 2)) {
      lines.push(line(`  ${part}`, 'idle'))
    }
  }

  lines.push(rule(width))

  // ---- what happened last -------------------------------------------------
  lines.push(line('last', 'label'))
  if (input.notice) {
    for (const part of wrapText(input.notice.text, width - 2)) {
      lines.push(line(`  ${part}`, input.notice.failed ? 'error' : 'notice'))
    }
  } else {
    lines.push(line('  nothing recorded yet', 'idle'))
  }

  lines.push(rule(width))

  // ---- the queue ----------------------------------------------------------
  lines.push(line('queue', 'label'))
  lines.push(
    line(`  ${input.counts.pending} pending · ${input.counts.resolved} resolved`, 'value'),
  )
  if (input.includeResolved) lines.push(line('  showing resolved', 'muted'))

  lines.push(rule(width))

  // ---- how the screen is arranged -----------------------------------------
  lines.push(line('view', 'label'))
  lines.push(line(`  ${input.layoutLabel} · ${input.themeLabel}`, 'muted'))
  lines.push(line('  L layout · t theme', 'muted'))

  return { lines, rationaleRow }
}
