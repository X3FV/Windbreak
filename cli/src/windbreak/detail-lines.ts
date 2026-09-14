import { pluralize } from '@codebuff/common/util/string'

import { shortenPath, wrapText } from './text'

import type { ReviewArgument, ReviewEntryDetail } from '@codebuff/windbreak/review'

/**
 * The detail pane's content as data.
 *
 * The pane used to be JSX with the wrapping interleaved, which made two things
 * impossible: knowing how many rows the content needs *before* rendering it
 * (so a scrollbar can be honest about whether there is anything to scroll), and
 * scrolling at all, since the lines were never addressable. Building the lines
 * here makes the pane a view over an array, and makes the content testable
 * without a renderer.
 */

/**
 * How a line is meant, not what colour it is.
 *
 * The pane maps these to the theme, so this module has no dependency on it and a
 * test can assert meaning ("this is the refuter's verdict") instead of a hex
 * value.
 */
export type DetailTone =
  | 'normal'
  | 'muted'
  | 'warning'
  | 'info'
  /** The code snippet the arguments are about, kept apart from their prose. */
  | 'evidence'
  /** The Proposer's own answer: the finding is claimed to be real. */
  | 'real'
  /** The Refuter's own answer: the finding is claimed to be benign. */
  | 'benign'
  /** A horizontal rule, drawn as a run of `─`. */
  | 'rule'

export interface DetailSpan {
  text: string
  tone: DetailTone
}

export interface DetailLine {
  spans: DetailSpan[]
}

const line = (text: string, tone: DetailTone = 'normal'): DetailLine => ({
  spans: [{ text, tone }],
})

const argumentLines = (
  argument: ReviewArgument,
  contentWidth: number,
): DetailLine[] => {
  const verdictTone: DetailTone =
    argument.verdict === 'real' ? 'real' : argument.verdict === 'benign' ? 'benign' : 'muted'

  const lines: DetailLine[] = [
    {
      spans: [
        { text: argument.role, tone: 'info' },
        {
          text: ` ${argument.modelId} (${argument.provider}) → `,
          tone: 'muted',
        },
        { text: argument.verdict ?? '(unreadable answer)', tone: verdictTone },
      ],
    },
  ]

  for (const wrapped of wrapText(argument.reasoning, contentWidth)) {
    lines.push(line(`  ${wrapped}`, 'normal'))
  }

  if (argument.preconditions.length > 0) {
    lines.push(line(`  preconditions (${argument.preconditions.length}):`, 'muted'))
    for (const precondition of argument.preconditions) {
      const parts = wrapText(precondition, contentWidth - 4)
      parts.forEach((part, index) => {
        lines.push(line(`    ${index === 0 ? '- ' : '  '}${part}`, 'muted'))
      })
    }
  }

  return lines
}

/**
 * Build the pane's rows.
 *
 * Order matters and is the point: the evidence comes first, because every
 * argument below it is a claim *about that code*. A researcher reading a
 * disagreement needs the thing being disagreed about before either side's case.
 */
export const buildDetailLines = (
  detail: ReviewEntryDetail | null,
  contentWidth: number,
): DetailLine[] => {
  if (!detail) return []

  const lines: DetailLine[] = []

  lines.push(
    line(
      detail.evidence
        ? `${detail.evidence.engine}/${detail.evidence.ruleId} (${detail.evidence.level})`
        : 'evidence bundle unreadable — the arguments below are about code you cannot see',
      detail.evidence ? 'muted' : 'warning',
    ),
  )

  if (detail.evidence?.snippet) {
    for (const wrapped of wrapText(detail.evidence.snippet, contentWidth)) {
      lines.push(line(`  ${wrapped}`, 'evidence'))
    }
  }

  // §5.1's pre-pass neutralized these before any model saw them. Shown rather
  // than hidden: a target trying to steer a model is evidence about the finding.
  if (detail.evidence && detail.evidence.injectionSignals.length > 0) {
    lines.push(
      line(
        `⚠ ${pluralize(
          detail.evidence.injectionSignals.length,
          'instruction-like line',
        )} neutralized before the models saw this`,
        'warning',
      ),
    )
  }

  const rule = '─'.repeat(Math.max(1, Math.min(contentWidth, 80)))
  lines.push(line(rule, 'rule'))

  lines.push(
    ...(detail.proposer
      ? argumentLines(detail.proposer, contentWidth)
      : [line('proposer: no verdict row found', 'muted')]),
  )

  lines.push(line(rule, 'rule'))

  lines.push(
    ...(detail.refuter
      ? argumentLines(detail.refuter, contentWidth)
      : [line('refuter: no verdict row found', 'muted')]),
  )

  lines.push(line(footerLine(detail), 'muted'))

  return lines
}

const footerLine = (detail: ReviewEntryDetail): string => {
  const { summary } = detail

  if (summary.decision !== null) {
    return (
      `recorded as ${summary.decision}` +
      (summary.rationale ? ` — "${summary.rationale}"` : '')
    )
  }

  return (
    `escalated by disagreement · state ${detail.candidateState} · target ` +
    `${detail.target ? shortenPath(detail.target.location, 2) : '(unknown)'}`
  )
}
