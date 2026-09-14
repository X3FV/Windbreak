/**
 * The chat pane's text (spec §20.29.4, §20.29.5 slice 5).
 *
 * Kept out of the component for the reason `detail-lines.ts` and `decision-lines.ts` are:
 * the transcript is the part that can be *wrong* — a turn that loses its question, an
 * answer that swallows the next prompt, a roll-up that counts proposals as findings — and
 * that is checkable without a renderer.
 *
 * Two jobs, one input, which is §20.29.4's "one surface doing both jobs" made concrete:
 *
 *   `/hunt <question>`   ask about the target as a whole
 *   `<question>`         ask about the candidate currently selected
 *
 * A prefix rather than a key toggling a mode, because the mode is a property of the
 * *question* and not of the pane: a researcher who asks about the target and then about a
 * row has changed what they are asking, not what they are looking at. It also means the
 * transcript is self-describing — every turn records which job it was — which is what
 * §20.29.3's "recorded as a distinct role" needs to be readable later.
 */

import type {
  ConversationBudgetState,
  CopyWriteRecord,
  InjectionSignal,
  InvestigatorAgentName,
  InvestigatorMode,
  ProposalRejection,
  ProposedSite,
  ReviewWorkingCopyInfo,
} from '@codebuff/windbreak/review'

/** One recorded turn, as the pane holds it. */
export interface ChatTurn {
  mode: InvestigatorMode
  /**
   * Which agent answered (§20.30).
   *
   * Captured when the question was sent, not read from the screen when the turn
   * settles: a researcher who switches to the engineer mid-turn must not have the
   * running answer relabelled as the engineer's.
   */
  agent: InvestigatorAgentName
  /** The copy the turn ran against, or null for a target-only turn. */
  workingCopyId: string | null
  /** Files the turn wrote in the copy, in order. */
  writes: CopyWriteRecord[]
  /** The question, verbatim, with the `/hunt` prefix stripped. */
  prompt: string
  /** The assistant's prose. Null when the turn failed. */
  answer: string | null
  error: string | null
  /** Tool names in order, for the audit line. */
  toolsUsed: string[]
  proposals: ProposedSite[]
  proposalRejections: ProposalRejection[]
  injectionSignals: InjectionSignal[]
  /** The `investigator_turns` row, so the pane can say the turn is on record. */
  recordedTurnId: string | null
  /** True when the researcher stopped the turn with `esc` (§20.29.5 slice 6). */
  cancelled?: boolean
  /** True while the turn is still running. */
  pending?: boolean
}

export const HUNT_PREFIX = '/hunt'

export interface ParsedChatInput {
  mode: InvestigatorMode
  prompt: string
}

/**
 * Read one line of input.
 *
 * Returns null for a line that is only whitespace, and for a bare `/hunt` with no
 * question: sending either would spend a model call to ask nothing, and a pane that did
 * so would look broken rather than empty.
 */
export const parseChatInput = (
  input: string,
  fallbackMode: InvestigatorMode,
): ParsedChatInput | null => {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null

  if (trimmed === HUNT_PREFIX) return null

  if (trimmed.startsWith(`${HUNT_PREFIX} `)) {
    const prompt = trimmed.slice(HUNT_PREFIX.length).trim()
    return prompt.length > 0 ? { mode: 'hunt', prompt } : null
  }

  return { mode: fallbackMode, prompt: trimmed }
}

/**
 * Where a proposal came from, one line, for the transcript.
 *
 * The CWE is shown only when the model gave one, and it is labelled as the model's: the
 * pane must not present a proposed class as an assessed one (§20.29.4).
 */
export const describeProposal = (site: ProposedSite): string => {
  const range =
    site.endLine !== site.startLine
      ? `${site.filePath}:${site.startLine}-${site.endLine}`
      : `${site.filePath}:${site.startLine}`
  return site.cwe ? `${range} (${site.cwe})` : range
}

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`

/** Tokens over a thousand, abbreviated, because the exact figure is not the point. */
const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`

/**
 * The conversation's budget, one line (spec §20.29.6).
 *
 * Shown as `used/limit` rather than as "n left", because `used/limit` is the pair that
 * tells a researcher both what they have spent and what the ceiling is — a remaining
 * count alone cannot say whether it is nearly over or barely begun.
 *
 * Null renders as the empty string, so a bridge that predates the budget (or a screen
 * with no investigator at all) simply has no line rather than a wrong one.
 */
export const describeBudget = (state: ConversationBudgetState | null): string => {
  if (!state) return ''

  const spent = `${state.calls}/${state.limit} model calls`
  const turns = state.turns === 0 ? 'no turns yet' : countLabel(state.turns, 'turn')
  const tokens = state.tokens > 0 ? ` · ${formatTokens(state.tokens)} tokens` : ''

  return state.exhausted
    ? `budget spent: ${spent} · ${turns}${tokens}`
    : `budget: ${spent} · ${turns}${tokens}`
}

/**
 * Why the input is gone rather than empty.
 *
 * A ceiling that silently disabled the input would be §18 in the pane's own chrome:
 * "you cannot ask" and "asking would do nothing" are different facts. The way out is
 * named, because a ceiling with no stated exit is just a broken pane.
 */
export const CHAT_EXHAUSTED_NOTE =
  'ceiling spent — esc to leave, reopen for a fresh conversation'

/**
 * The transcript as lines for the pane.
 *
 * Stops before the running turn's answer, which the pane renders as a spinner, so a
 * pending turn cannot show stale text as though it were the reply.
 */
export const buildChatLines = (turns: readonly ChatTurn[]): string[] => {
  if (turns.length === 0) {
    return [
      'Ask about the candidate that is selected, or start a line with',
      `${HUNT_PREFIX} to hunt the whole target.`,
      '',
      'The investigator answers from the target: it can read the checkout and run',
      'commands in it, sandboxed, and it cannot change it. The engineer (tab) works',
      'on a writable copy of the target — it can patch, build and run there — and',
      'the target itself stays exactly as the finding cites it.',
      '',
      'Neither one decides anything: what they say is recorded beside the two',
      'arguments, and you still rule on them.',
    ]
  }

  const lines: string[] = []

  for (const [index, turn] of turns.entries()) {
    if (index > 0) lines.push('')

    // The agent is named only when it is the engineer, and the mode only when it is
    // a hunt. A `you ›` line with no qualifier is the common case — an investigator
    // answering about the selected row — and qualifiers that are always present stop
    // being read.
    const who = [
      turn.agent === 'engineer' ? 'engineer' : null,
      turn.mode === 'hunt' ? 'hunt' : null,
    ].filter((part): part is string => part !== null)

    lines.push(
      who.length > 0 ? `you (${who.join(', ')}) › ${turn.prompt}` : `you › ${turn.prompt}`,
    )

    if (turn.pending) {
      lines.push('  … investigating (esc stops it)')
      continue
    }

    if (turn.cancelled) {
      // A turn the researcher stopped is not a turn that broke: said first and in its
      // own words, so "you stopped it" cannot read as "it failed".
      lines.push('  ! cancelled — you stopped this turn')
    } else if (turn.error) {
      // The failure first and labelled, so it cannot be read as the answer.
      lines.push(`  ! ${turn.error}`)
    }

    if (turn.answer) {
      for (const line of turn.answer.split('\n')) lines.push(`  ${line}`)
    } else if (!turn.error) {
      lines.push('  (no answer)')
    }

    if (turn.writes.length > 0) {
      // A write is not an answer, so it is reported as its own block rather than read
      // into the prose above it. The last line is the claim §20.30's design rests on:
      // the edit landed in a copy, and the target is unchanged.
      lines.push(
        '',
        `  edited ${countLabel(turn.writes.length, 'file')} in the working copy:`,
      )
      for (const write of turn.writes) {
        const counts =
          write.inserted > 0 || write.removed > 0
            ? ` (+${write.inserted}/-${write.removed})`
            : ''
        lines.push(`    ${write.action} ${write.path}${counts}`)
      }
      lines.push(
        '    the target is unchanged — these edits are in the copy, which is what was',
        '    built and run.',
      )
    }

    if (turn.proposals.length > 0) {
      lines.push(
        '',
        `  recorded ${countLabel(turn.proposals.length, 'candidate')} — these enter the`,
        '  pipeline like any other and still have to pass triage and verification:',
      )
      for (const site of turn.proposals) lines.push(`    ${describeProposal(site)}`)
    }

    for (const rejection of turn.proposalRejections) {
      // A refusal is worth showing: it is how a researcher notices a model aiming at
      // files that are not there, which is a fact about the answer's reliability.
      lines.push(`    refused ${rejection.requestedPath}: ${rejection.reason}`)
    }

    if (turn.injectionSignals.length > 0) {
      // §5.1 reaches the screen here. A turn whose tool results carried
      // instruction-like content is marked, because the reader is being asked to weigh
      // reasoning that a hostile file tried to steer.
      const kinds = [...new Set(turn.injectionSignals.map((signal) => signal.kind))]
      lines.push(
        `  ! target content tried to instruct the model (${kinds.join(', ')}); its text`,
        '    was neutralized before the model saw it, but weigh the answer accordingly',
      )
    }

    if (turn.toolsUsed.length > 0) {
      lines.push(
        `  [${countLabel(turn.toolsUsed.length, 'tool call')}: ${turn.toolsUsed.join(', ')}]`,
      )
    }

    if (turn.recordedTurnId === null) {
      lines.push('  ! this turn is not on record, so it will not be there next time')
    }
  }

  return lines
}

/**
 * The one-line summary of the agent the next question goes to (§20.30).
 *
 * Stated because the switch is invisible otherwise: the same box, the same
 * transcript, and a key that changes which root the words are about. A researcher
 * who cannot see who they are talking to cannot tell an answer about the evidence from
 * an answer about a patch.
 */
export const describeChatAgent = (
  agent: InvestigatorAgentName,
  copy: ReviewWorkingCopyInfo | null,
): string => {
  if (agent === 'engineer') {
    // The copy does not exist until the first engineer turn, and the line says so
    // rather than pretending a copy is already being edited (`ReviewInvestigator`'s
    // `workingCopy()` is null until then).
    return copy
      ? `engineer · editing ${copy.root} (${copy.files} files)`
      : 'engineer · a writable copy is made on the first turn'
  }

  return 'investigator · reads the target, cannot change it'
}

/**
 * Wrap the transcript to the pane's content width (§20.32).
 *
 * This exists because the pane used to *truncate*. A model's answer is a paragraph, so at
 * a side pane's ~28 columns every answer arrived as one line ending in `…` — the pane was
 * showing the beginning of the reasoning and hiding the rest behind an ellipsis. The
 * full-size chat gives the transcript the width of the terminal, and this is what turns
 * that width into readable prose rather than merely a longer cut-off.
 *
 * Four rules, each of them a way the obvious implementation is wrong:
 *
 * - **Blank lines stay blank.** They are the transcript's paragraph breaks; dropping them
 *   runs two turns together.
 * - **Indentation is kept on continuation lines.** A tool line or a proposal block is
 *   indented to mark it subordinate to the question above it, and an indent that vanished
 *   on the second line would make one block read as two.
 * - **A word is split only when it cannot fit at all.** A long path or a digest has no
 *   space to break at, and overflowing the pane is worse than breaking it — so it is hard
 *   broken at the width, which is the only case where a break lands mid-token.
 * - **Wrapping happens before the scroll offset is computed**, not inside the pane. The
 *   offset is a *row* index and rows do not exist until the text has been wrapped, so a
 *   pane that wrapped as it drew would scroll by a different unit than it counted in.
 */
export const wrapChatLines = (lines: readonly string[], width: number): string[] => {
  const usable = Math.max(1, Math.floor(width))
  const wrapped: string[] = []

  for (const line of lines) {
    if (line.length === 0) {
      wrapped.push('')
      continue
    }

    const trimmed = line.trimStart()
    const indent = line.slice(0, line.length - trimmed.length)
    // A hanging indent only pays for itself while the content has room beside it; past
    // that it would eat the line rather than mark it.
    const prefix = indent.length < usable ? indent : ''
    const words = trimmed.split(' ').filter((word) => word.length > 0)

    if (words.length === 0) {
      wrapped.push('')
      continue
    }

    const room = Math.max(1, usable - prefix.length)
    let current = ''

    const flush = (): void => {
      if (current.length > 0) {
        wrapped.push(prefix + current)
        current = ''
      }
    }

    for (const word of words) {
      if (current.length > 0 && current.length + 1 + word.length <= room) {
        current += ` ${word}`
        continue
      }

      flush()

      let remaining = word
      while (remaining.length > room) {
        wrapped.push(prefix + remaining.slice(0, room))
        remaining = remaining.slice(room)
      }
      current = remaining
    }

    flush()
  }

  return wrapped
}

/**
 * The hint row while the chat occupies the screen (§20.32).
 *
 * A line of its own rather than the browse tiers with a chat segment appended, because
 * in this arrangement the browse keys are not merely secondary — they are *inert*. The
 * input owns the letters, so `r`, `b`, `a`, `L`, `t` and `q` do nothing here, and the
 * hint row listing them would be the screen claiming functions it does not have. Two
 * keys that do work are worth naming instead: `tab`, which the browse row never mentions,
 * and `esc`, which means two different things depending on whether a turn is running.
 */
export const buildChatHintLine = (input: {
  columns: number
  /** Null when no investigator is available, which is most of the screen's life. */
  agent: InvestigatorAgentName | null
  pending: boolean
  exhausted: boolean
  /** True when the queue rail is on screen, so its movement key is worth naming. */
  rail: boolean
}): string => {
  // Built from parts rather than from a template with holes: the optional segments depend
  // on whether an agent is available and whether the rail is on screen, and a template
  // that leaves `· ·` behind when one is missing is the kind of line a reader stops
  // trusting.
  const join = (...parts: string[]): string =>
    parts.filter((part) => part.length > 0).join(' · ')

  const rail = input.rail ? 'ctrl+↑↓ row' : ''
  const agent = input.agent === null ? '' : describeAgentSwitch(input.agent)
  const scroll = join('↑↓ scroll', rail)

  const tiers = input.pending
    ? [join('esc stop turn', scroll, 'PgUp/PgDn page'), join('esc stop', scroll)]
    : input.exhausted
      ? [join('esc leave chat', scroll, 'PgUp/PgDn page'), join('esc leave', scroll)]
      : [
          join('enter send', 'esc leave', agent, scroll, 'PgUp/PgDn page'),
          join('enter send', 'esc leave', agent, scroll),
          join('enter send', 'esc leave', agent, '↑↓ scroll'),
          join('enter · esc', agent, '↑↓'),
        ]

  const usable = Math.max(1, input.columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

/**
 * The one-line summary above the input: what the next question will be about.
 *
 * Stated rather than implied, because the same input means two different things and the
 * only cue is which row is selected.
 */
export const describeChatTarget = (
  mode: InvestigatorMode,
  selection: { filePath: string | null; startLine: number | null } | null,
): string => {
  if (mode === 'hunt') return `next question hunts the target · ${HUNT_PREFIX} to change`

  if (!selection || !selection.filePath) {
    return 'nothing is selected, so the next question hunts the target'
  }

  return (
    `next question asks about ${selection.filePath}` +
    (selection.startLine !== null ? `:${selection.startLine}` : '')
  )
}

/** Hints for the chat pane, appended to the screen's own hint row. */
export const CHAT_HINTS = 'type a question · enter send · tab switch agent · ↑↓ scroll'

/**
 * The switch key, named once for the hint row and the help text.
 *
 * A function rather than a constant because the hint names the *destination*, and a
 * key that says "switch to engineer" while it would switch to the investigator is the
 * kind of false label the rest of this screen avoids.
 */
export const describeAgentSwitch = (agent: InvestigatorAgentName): string =>
  agent === 'engineer' ? 'tab investigator' : 'tab engineer'

export type {
  ConversationBudgetState,
  CopyWriteRecord,
  InjectionSignal,
  InvestigatorAgentName,
  InvestigatorMode,
  ProposalRejection,
  ProposedSite,
  ReviewWorkingCopyInfo,
}
