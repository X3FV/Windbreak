/**
 * What the /windbreak queue view says, and in what tone (§5.2, §5.3, §18, §20.32, D32).
 *
 * Pure content, no renderer and no theme: the view decides geometry and colour, this decides the
 * sentences. It is separate because the sentences are the part that can be *wrong*, and three of
 * them are rules rather than copy:
 *
 * 1. **A missing database is not an empty queue** (§18's substitution). `openReviewSession`
 *    opens a missing database rather than refusing, precisely so the screen can say which one it
 *    is looking at — `source.absent` is the field that keeps them apart, and this module is where
 *    it is spent. "Nothing has been scanned here" and "no disagreements were escalated" are
 *    different facts, and only one of them is good news.
 * 2. **Both model answers are shown in full**, with the model and the provider that gave them,
 *    because resolving a disagreement *is* reading two answers. The evidence comes too: the §5.1
 *    pre-pass's injection signals are evidence about the finding, so a candidate whose file tried
 *    to steer a model is shown with that fact rather than without it.
 * 3. **A decision is the researcher's**, so a resolved row shows the decision and the rationale
 *    exactly as stored, and a second look is announced (`ReviewDecisionResult.previous`) rather
 *    than quietly overwriting the first.
 *
 * A line is `field` (a labelled value, wrapped by the view with a hanging indent), `text` (a
 * sentence, or a snippet line), or `rule` (a section divider). Tones are semantic names; the view
 * maps them to the theme, which is why nothing here imports one.
 */

import type {
  ReviewArgument,
  ReviewCounts,
  ReviewDecision,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewQueueSource,
} from '@codebuff/windbreak/review'

export type QueueTone = 'normal' | 'muted' | 'info' | 'error' | 'warning' | 'success'

export type QueueLine =
  | { kind: 'field'; label: string; value: string; tone: QueueTone }
  | { kind: 'text'; text: string; tone: QueueTone; indent: number }
  | { kind: 'rule'; label: string }

/** A sentence rather than a labelled value, for the callers that only ever emit those. */
export type QueueTextLine = Extract<QueueLine, { kind: 'text' }>

/** The label column. Shared so every pane reads as one table, and the view wraps against it. */
export const QUEUE_LABEL_WIDTH = 12

const field = (label: string, value: string, tone: QueueTone = 'normal'): QueueLine => ({
  kind: 'field',
  label,
  value,
  tone,
})

const text = (line: string, tone: QueueTone = 'normal', indent = 0): QueueTextLine => ({
  kind: 'text',
  text: line,
  tone,
  indent,
})

const rule = (label: string): QueueLine => ({ kind: 'rule', label })

/** `src/foo.c:41`, or the absence of a location said plainly. */
export const candidateLocation = (entry: {
  filePath: string | null
  startLine: number | null
}): string => {
  if (entry.filePath === null) return '(no file recorded)'
  if (entry.startLine === null) return entry.filePath
  return `${entry.filePath}:${entry.startLine}`
}

/**
 * A candidate id short enough for a list row.
 *
 * Truncated rather than wrapped, and the *detail* pane prints it in full — the id is what a
 * researcher types into `windbreak review --decide`, so the view has to offer a path to the whole
 * of it rather than only a form that fits.
 */
export const shortCandidateId = (id: string): string =>
  id.length <= 14 ? id : `${id.slice(0, 13)}…`

/** What a decision does downstream, in §5.3's own terms. */
export const decisionConsequence = (decision: ReviewDecision): string =>
  decision === 'real'
    ? 'joins verification as confirmed'
    : 'is dropped from verification, and kept as a negative example for tuning Phase A patterns'

export type QueueHeaderInput = { repoRoot: string } & (
  /**
   * The queue could not be read. `dbPath` is the path that was *resolved*, when one was: a
   * schema-version mismatch is a refusal about a file, and a refusal that did not name the file
   * would leave the reader unable to tell which database to point at or delete.
   */  
  | {
      refusal: string
      dbPath: string | null
      source: null
      counts: null
      includeResolved: boolean
    }
  /** A queue was read, and this is where from. */
  | {
      refusal: null
      dbPath?: never
      source: ReviewQueueSource
      counts: ReviewCounts
      includeResolved: boolean
    }
)

export const queueHeaderLines = (input: QueueHeaderInput): QueueLine[] => {
  const lines: QueueLine[] = [field('repository', input.repoRoot)]

  if (input.refusal !== null) {
    // The path when it is known, and `not resolved` when the configuration could not even say
    // which database it meant. The queue row says `not read` rather than `0 pending`, which would
    // be a number this screen has no basis for (§18).
    lines.push(
      field(
        'database',
        input.dbPath ?? 'not resolved — the configuration could not be read',
        input.dbPath === null ? 'error' : 'muted',
      ),
      field('queue', 'not read', 'warning'),
    )
    return lines
  }

  lines.push(
    field('database', input.source.path ?? 'a connection the caller opened'),
    input.source.absent
      ? field('queue', 'nothing here — no scan has written to this path', 'warning')
      : field(
          'queue',
          `${input.counts.pending} pending · ${input.counts.resolved} of ${input.counts.total} decided`,
        ),
  )

  if (input.counts.total > 0) {
    lines.push(
      field(
        'showing',
        input.includeResolved
          ? 'pending and decided — `a` hides the decided ones'
          : 'pending only — `a` also shows the decided ones',
        'muted',
      ),
    )
  }

  return lines
}

/**
 * The placeholder body: what the screen says when there is no row to show.
 *
 * Four states, four sentences, and no shared wording — the whole point is that a reader can tell
 * them apart. `refused` and `absent` are the two §18 cares about; `none` and `all-resolved` differ
 * because "this database holds no disagreements" and "you have decided all of them" are different
 * pieces of news, and the second one is the good one.
 */
export type QueuePlaceholderInput =
  /** The session could not be opened, so there is no database behind this pane. */
  | { refusal: string; source: null; counts: null; includeResolved: boolean }
  /** There is a queue, and it has no pending rows to show. */
  | {
      refusal: null
      source: ReviewQueueSource
      counts: ReviewCounts
      includeResolved: boolean
    }

export const queuePlaceholderLines = (input: QueuePlaceholderInput): QueueLine[] => {
  // Each paragraph is one string. The pane wraps it at the width it actually has — hand-wrapping
  // the copy here would be wrapped a second time by a narrower terminal, and a sentence broken
  // mid-clause reads as a rendering fault rather than as prose.
  if (input.refusal !== null) {
    return [
      text('The queue was not opened.', 'error'),
      text(''),
      text(input.refusal),
      text(''),
      text(
        'This is not an empty queue: nothing in this database has been read, so nothing about the disagreements it holds has been claimed either way.',
      ),
      text(
        'Fix what the message names — a database written by another schema version is the usual cause — and open /windbreak again.',
      ),
    ]
  }

  if (input.source.absent) {
    return [
      text(`No state database exists at ${input.source.path ?? 'the resolved path'}.`, 'warning'),
      text(''),
      text(
        'An empty queue and a missing database are different facts, and only one of them is good news: nothing has been scanned into this path, so nothing here has been escalated to decide.',
      ),
      text(
        'Run /scan (or `windbreak scan`) and the disagreements it records will appear in this view.',
      ),
    ]
  }

  const { counts } = input

  if (counts.total === 0) {
    return [
      text('This database holds no disagreements.', 'muted'),
      text(''),
      text(
        'The queue is not every candidate: it is the ones where the Proposer said real and the Refuter said benign (§5.3).',
      ),
      text(
        'So an empty queue is a statement about disagreements, not about the code — a scan that found nothing and a scan that never ran look the same from here. `windbreak review --target <repo>` reads a run’s own summary instead.',
      ),
    ]
  }

  // Total > 0, nothing pending, and the decided rows are hidden. The only way to see what was
  // decided is the toggle, so the placeholder names the key rather than leaving a reader with a
  // screen that looks empty.
  return [
    text(
      `Every disagreement in this database has been decided: ${counts.resolved} of ${counts.total}.`,
      'success',
    ),
    text(''),
    text('Press `a` to list them, with the decision and the rationale each one carries.', 'muted'),
  ]
}

/** One list row per entry: id, location, class, source, and how it was resolved. */
export const queueListLines = (
  entries: readonly ReviewEntrySummary[],
  selectedIndex: number,
): QueueTextLine[] =>
  entries.map((entry, index) => {
    const selection = index === selectedIndex ? '❯ ' : '  '
    const decided =
      entry.decision === null
        ? ''
        : `  ${entry.decision}${entry.decidedAt === null ? '' : ` ${entry.decidedAt.slice(0, 10)}`}`

    const row = [
      shortCandidateId(entry.candidateId).padEnd(15),
      candidateLocation(entry).padEnd(30),
      (entry.cwe ?? '—').padEnd(12),
      entry.source,
      decided,
    ].join('')

    return {
      kind: 'text',
      text: `${selection}${row}`,
      // A decided row is dimmer than a pending one, but the cursor still has to be findable in a
      // list where every row has been decided (`a`).
      tone: index === selectedIndex ? 'info' : entry.decision === null ? 'normal' : 'muted',
      indent: 0,
    }
  })

const argumentLines = (
  argument: ReviewArgument | null,
  role: 'proposer' | 'refuter',
): QueueLine[] => {
  const lines: QueueLine[] = [rule(role)]

  if (argument === null) {
    lines.push(
      text(
        `The ${role}’s verdict record is missing from this database. The queue row references it, so this is a record that was removed rather than a model that said nothing — §5.3 only escalated the candidate because two answers existed.`,
        'error',
      ),
    )
    return lines
  }

  // The section rule above names the role, so the labels inside stay short enough for the column
  // the rest of the pane uses.
  lines.push(field('model', `${argument.modelId} via ${argument.provider}`))
  lines.push(
    field(
      'said',
      argument.verdict ?? 'nothing readable',
      argument.verdict === null ? 'warning' : 'normal',
    ),
  )

  const reasoning = argument.reasoning.trim()
  if (reasoning.length > 0) lines.push(field('because', reasoning))
  else {
    lines.push(
      text(
        'No reasoning was recorded for this side. That is what the record says, not an argument that it did not give one.',
        'muted',
      ),
    )
  }

  if (argument.preconditions.length > 0) {
    lines.push(field('requires', argument.preconditions[0]!))
    for (const precondition of argument.preconditions.slice(1)) {
      lines.push(text(precondition, 'normal', QUEUE_LABEL_WIDTH))
    }
  } else if (role === 'proposer') {
    lines.push(
      text(
        'No preconditions were recorded, so the Proposer claimed the finding holds as written.',
        'muted',
      ),
    )
  }

  return lines
}

const evidenceLines = (detail: ReviewEntryDetail): QueueLine[] => {
  const lines: QueueLine[] = [rule('evidence')]

  if (detail.evidence === null) {
    lines.push(
      text(
        'The evidence bundle for this candidate could not be read from the database. That is not the same as a finding with no evidence: the row exists and its bundle does not parse, so nothing here is a statement about the code.',
        'warning',
      ),
    )
    return lines
  }

  const evidence = detail.evidence
  lines.push(field('engine', `${evidence.engine} · ${evidence.ruleId}`))
  lines.push(field('level', evidence.level))
  lines.push(field('detector', evidence.message))
  lines.push(
    field(
      'at',
      `${evidence.filePath}:${evidence.startLine}${
        evidence.endLine === null ? '' : `–${evidence.endLine}`
      }`,
    ),
  )

  if (evidence.snippet === null) {
    lines.push(
      text(
        'No code snippet was stored with this candidate, so the detector’s region is not shown.',
        'muted',
      ),
    )
  } else {
    lines.push(text('snippet:', 'muted'))
    for (const snippetLine of evidence.snippet.split('\n')) {
      lines.push(text(snippetLine, 'normal', 4))
    }
  }

  if (evidence.injectionSignals.length === 0) {
    // "None recorded" rather than "none found": an unreadable or empty column is not the same as a
    // pre-pass that ran and stayed quiet, and only one of those is a clean bill of health.
    lines.push(
      text(
        'Injection signals: none recorded for this candidate. The §5.1 pre-pass neutralises instruction-like lines in the target before a model reads them.',
        'muted',
      ),
    )
  } else {
    lines.push(
      text(
        'Injection signals: instruction-like lines were neutralised before the models read this file (§5.1). They are shown because an attempt to steer a model is evidence about the finding, not because the models may have followed it — what they answered is above.',
        'warning',
      ),
    )
    for (const signal of evidence.injectionSignals) {
      lines.push(text(`- ${signal}`, 'warning', 4))
    }
  }

  return lines
}

const decisionLines = (detail: ReviewEntryDetail): QueueLine[] => {
  const { summary } = detail
  if (summary.decision === null) return []

  const lines: QueueLine[] = [rule('your decision')]
  lines.push(
    field(
      'decision',
      `${summary.decision} — the candidate ${decisionConsequence(summary.decision)}`,
      summary.decision === 'real' ? 'success' : 'info',
    ),
  )
  lines.push(
    field('recorded', summary.decidedAt ?? 'no timestamp was stored with it', 'muted'),
  )
  const rationale = summary.rationale?.trim() ?? ''
  lines.push(
    rationale.length > 0
      ? field('rationale', rationale)
      : field('rationale', 'none recorded — the decision stands without one', 'muted'),
  )

  return lines
}

/**
 * The detail pane: the whole row, in the order a researcher needs it.
 *
 * Identity, then the decision if there is one, then the evidence, then both arguments. The
 * decision goes high because a queue worked in a sitting is mostly *revisits* — a reader who came
 * back to a candidate they already decided wants to see what they said before they read the two
 * model answers again, and a reader who has not decided one is not slowed down by a section that
 * is absent.
 */
export const queueDetailLines = (detail: ReviewEntryDetail): QueueLine[] => {
  const { summary } = detail
  const target = detail.target

  const lines: QueueLine[] = [
    field('candidate', summary.candidateId),
    field(
      'run',
      [
        summary.runId,
        target === null ? 'target not on record' : `target ${target.location}`,
        target?.commitSha ? `@ ${target.commitSha.slice(0, 12)}` : 'revision unpinned',
        `state ${detail.candidateState}`,
      ].join(' · '),
    ),
    field('file', candidateLocation(summary)),
    field('cwe', summary.cwe ?? 'not classified', summary.cwe === null ? 'muted' : 'normal'),
    field(
      'source',
      summary.patternId === null ? summary.source : `${summary.source} · ${summary.patternId}`,
    ),
  ]

  lines.push(...decisionLines(detail))
  lines.push(...evidenceLines(detail))

  lines.push(
    text(
      'Two models were asked the same question about this candidate and disagreed; that disagreement is why it is in the queue. Both answers follow, in full.',
      'muted',
    ),
  )

  lines.push(...argumentLines(detail.proposer, 'proposer'))
  lines.push(...argumentLines(detail.refuter, 'refuter'))

  return lines
}

/** The one line the transcript keeps when the view closes. */
export const queueClosingLine = (input: {
  refusal: string | null
  source: ReviewQueueSource | null
  counts: ReviewCounts | null
  decided: readonly ReviewDecision[]
  /**
   * How many questions went to the investigator (§20.38).
   *
   * Carried into the transcript because a conversation is a **spend** — model calls against a
   * configured ceiling — and the one place a researcher can see that afterwards is here. The
   * rationale for a decision still lives in the database, which is where the decision's own
   * record belongs; this line is what the session cost to produce.
   */
  questions?: number
}): string => {
  if (input.refusal !== null) {
    return `WindBreak queue: not opened — ${input.refusal}`
  }

  if (input.source === null) {
    return 'WindBreak queue: no database was resolved, so there was no queue to read.'
  }

  if (input.source.absent) {
    return (
      `WindBreak queue: no database at ${input.source.path ?? 'the resolved path'} — ` +
      'nothing has been scanned there, so nothing was queued to decide.'
    )
  }

  const counts = input.counts ?? { total: 0, pending: 0, resolved: 0 }
  const parts = [
    `WindBreak queue: ${counts.pending} pending`,
    `${counts.resolved} of ${counts.total} decided`,
  ]

  if (input.decided.length === 0) {
    parts.push('nothing was decided in this view')
  } else {
    const real = input.decided.filter((decision) => decision === 'real').length
    const benign = input.decided.length - real
    const tally = [
      real > 0 ? `real ×${real}` : null,
      benign > 0 ? `benign ×${benign}` : null,
    ].filter((part): part is string => part !== null)
    parts.push(`decided here: ${tally.join(', ')}`)
  }

  if ((input.questions ?? 0) > 0) {
    parts.push(`asked the investigator ${input.questions} question(s)`)
  }

  return parts.join(' · ')
}

/** The confirmation shown after `recordAdjudicationDecision` wrote the row. */
export const queueNoticeLines = (input: {
  candidateId: string
  decision: ReviewDecision
  previous: ReviewDecision | null
}): QueueTextLine[] => {
  const lines: QueueTextLine[] = [
    text(
      `recorded ${input.decision} for ${shortCandidateId(input.candidateId)} — the candidate ${decisionConsequence(input.decision)}.`,
      input.previous === null ? 'success' : 'warning',
    ),
  ]

  if (input.previous !== null) {
    // §5.3 does not forbid a second look; it forbids one happening out of sight.
    lines.push(
      text(
        `This replaces an earlier ${input.previous}, which is now the previous decision on the row.`,
        'warning',
      ),
    )
  }

  return lines
}
