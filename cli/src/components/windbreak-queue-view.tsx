import { useKeyboard } from '@opentui/react'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import { createPasteHandler } from '../utils/strings'
import { wrapToVisualLines } from '../utils/text-layout'
import { BORDER_CHARS } from '../utils/ui-constants'
import { resolveWindbreakQueueAction } from '../utils/windbreak-queue-actions'
import {
  QUEUE_LABEL_WIDTH,
  queueDetailLines,
  queueHeaderLines,
  queueListLines,
  queueNoticeLines,
  queuePlaceholderLines,
  shortCandidateId,
} from '../windbreak/queue-content'
import {
  buildQueueChatLines,
  describeQueueBudget,
  describeQueueChatTarget,
  describeQueueRefusal,
  QUEUE_CHAT_EXHAUSTED_NOTE,
  QUEUE_CHAT_HINTS,
} from '../windbreak/queue-chat-content'
import { MultilineInput } from './multiline-input'

import type { KeyEvent } from '@opentui/core'
import type {
  ConversationBudgetState,
  InvestigatorMode,
  ProviderFailure,
  ReviewCounts,
  ReviewDecision,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewQueueSource,
} from '@codebuff/windbreak/review'
import type { ChatTheme } from '../types/theme-system'
import type { QueueChatTurn } from '../windbreak/queue-chat-content'
import type { QueueLine, QueueTone } from '../windbreak/queue-content'

/**
 * WindBreak's adjudication queue, on screen (§5.3, §18, §20.32, §20.38).
 *
 * The view that replaces the sentence *"run `windbreak review --decide --rationale \"...\"`"*. The
 * difference is who writes the record: a decision submitted through the chat is a command a model
 * composed from a brief, and §5.3 makes the researcher's disagreement the tiebreak — so the verdict
 * is a keystroke here, `session.decide` calls the pipeline's own `recordAdjudicationDecision`, and
 * the rationale is the researcher's text rather than a model's paraphrase of it.
 *
 * `c` opens the other half: a conversation about the selected row, answered by §20.29's investigator
 * — confined to the target, sandboxed, recorded in `investigator_turns`, bounded by the config's
 * own ceiling. It is deliberately *not* a decision path: it answers, the researcher still rules, and
 * that is the invariant `models.ts` states at the type level (the investigator is not a `ModelRole`,
 * so nothing it says can reach `runVerification`'s disposition). The two panes share the body and
 * never the input: whatever is typed is either a rationale or a question, never ambiguous.
 *
 * The state is `windbreak-queue-screen.tsx`, which is what makes this testable without a database.
 * Two things it must not do, both of them §18's rule at screen resolution:
 *
 * - **Not present an absent database as an empty queue.** The sentences are in
 *   `windbreak/queue-content.ts` and this view only places them.
 * - **Not hide a model's answer, or an absence of one.** Both arguments are rendered in full; the
 *   investigator's turns say when they are cancelled, refused, unrecorded, or still running.
 */

/** What the container keeps after a decision, so the view can say what was written. */
export interface WindbreakQueueNotice {
  candidateId: string
  decision: ReviewDecision
  previous: ReviewDecision | null
}

/** The investigator pane, as the view reads it. Owned by the container. */
export interface WindbreakQueueChat {
  open: boolean
  /** True until the bridge has been built: credentials and a connection take a moment. */
  starting: boolean
  /** Null when the investigator is usable; the reason to show instead of an input when not. */
  unavailableReason: string | null
  turns: readonly QueueChatTurn[]
  /** True while a turn is in flight, which is what `esc` cancels rather than closing. */
  pending: boolean
  budget: ConversationBudgetState | null
  /** The account-level refusal the conversation last hit, or null (§18). */
  refusal: ProviderFailure | null
  /** The mode the next line will run in, given what is selected. */
  mode: InvestigatorMode
}

export type WindbreakQueueState =
  | {
      phase: 'refused'
      reason: string
      /**
       * The database that was resolved, when one was, so the refusal can name the file it is
       * about. Null when the configuration itself is what could not be read.
       */
      dbPath: string | null
    }
  | {
      phase: 'open'
      source: ReviewQueueSource
      counts: ReviewCounts
      entries: readonly ReviewEntrySummary[]
      detail: ReviewEntryDetail | null
      selectedIndex: number
      includeResolved: boolean
      /** Null until a decision is recorded in this view. */
      notice: WindbreakQueueNotice | null
      chat: WindbreakQueueChat
    }

/** The pane's own callbacks, grouped so the view's signature stays readable. */
export interface WindbreakQueueChatHandlers {
  open: () => void
  close: () => void
  /** Send one line. The container parses `/hunt` out of it and charges the budget. */
  ask: (input: string) => void
  /** Stop the turn in flight. The engine records it as cancelled, not as failed. */
  cancel: () => void
}

export interface WindbreakQueueViewProps {
  /** The checkout the session is about. Shown even when no database could be resolved. */
  repoRoot: string
  state: WindbreakQueueState
  /** Leaving the view. The transcript's line is computed by the container. */
  onClose: () => void
  /** Move the cursor by `delta` rows; the container clamps it and re-reads the detail. */
  onSelect: (delta: number) => void
  onToggleResolved: () => void
  onDecide: (input: {
    candidateId: string
    decision: ReviewDecision
    rationale: string
  }) => void
  onChat: WindbreakQueueChatHandlers
}

/** Which input the pane is showing. Never two: the letters belong to one of them. */
type ViewInput =
  | { kind: 'none' }
  | { kind: 'rationale'; decision: ReviewDecision }
  | { kind: 'question' }

const toneColor = (tone: QueueTone, theme: ChatTheme): string => {
  switch (tone) {
    case 'muted':
      return theme.muted
    case 'info':
      return theme.info
    case 'error':
      return theme.error
    case 'warning':
      return theme.warning
    case 'success':
      return theme.success
    default:
      return theme.foreground
  }
}

/** One row each, so a list row cannot wrap and turn a queue into a paragraph. */
const fit = (line: string, width: number): string =>
  line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`

interface Row {
  text: string
  tone: string
}

const ruleRow = (label: string, cols: number, theme: ChatTheme): Row => {
  const head = `── ${label} `
  return {
    text: `${head}${'─'.repeat(Math.max(0, cols - head.length))}`,
    tone: theme.border,
  }
}

/**
 * Wrap content lines into the rows the terminal will print.
 *
 * `field` rows hang: the continuation of a value lines up under the value rather than under the
 * label, so a long rationale reads as one paragraph instead of a column of numbers.
 */
const toRows = (lines: readonly QueueLine[], cols: number, theme: ChatTheme): Row[] => {
  const rows: Row[] = []

  for (const line of lines) {
    if (line.kind === 'rule') {
      rows.push(ruleRow(line.label, cols, theme))
      continue
    }

    const colour = toneColor(line.tone, theme)

    if (line.kind === 'field') {
      const valueWidth = Math.max(10, cols - QUEUE_LABEL_WIDTH)
      const wrapped = line.value === '' ? [''] : wrapToVisualLines(line.value, valueWidth)
      rows.push({
        text: `${line.label.padEnd(QUEUE_LABEL_WIDTH)}${wrapped[0] ?? ''}`,
        tone: colour,
      })
      for (const continuation of wrapped.slice(1)) {
        rows.push({ text: `${' '.repeat(QUEUE_LABEL_WIDTH)}${continuation}`, tone: colour })
      }
      continue
    }

    const width = Math.max(10, cols - line.indent)
    const wrapped = line.text === '' ? [''] : wrapToVisualLines(line.text, width)
    for (const part of wrapped) {
      rows.push({ text: `${' '.repeat(line.indent)}${part}`, tone: colour })
    }
  }

  return rows
}

/**
 * The chat pane's chrome above the input, as the rows it will print.
 *
 * Returned as rows rather than as a count so the reservation and the render cannot disagree, and
 * **wrapped rather than truncated**: the reason an investigator cannot run carries the sentence
 * that says the queue still works, and clipping it at the terminal edge hides the one fact a reader
 * needs (§18 applied to the pane's own chrome).
 */
const chatChromeLines = (input: {
  chat: WindbreakQueueChat
  cols: number
  target: string
  theme: ChatTheme
}): Row[] => {
  const { chat, cols, theme } = input
  if (!chat.open) return []

  const wrap = (text: string, colour: string): Row[] =>
    wrapToVisualLines(text, Math.max(10, cols)).map((part) => ({ text: part, tone: colour }))

  // The finished turn's own state once there is one: it is the freshest account of the
  // conversation, and reading the bridge's instead would let the two numbers drift apart on screen.
  const budget = chat.turns.at(-1)?.budget ?? chat.budget

  const rows = wrap(
    `${input.target}${budget === null ? '' : ` · ${describeQueueBudget(budget)}`}`,
    theme.muted,
  )

  if (chat.starting) {
    rows.push(...wrap('starting the investigator — credentials and a connection', theme.muted))
  } else if (chat.unavailableReason !== null) {
    // The reason instead of an input. A pane that looks ready and silently does nothing is §18 in
    // the pane's own chrome.
    rows.push(...wrap(chat.unavailableReason, theme.error))
  } else if (budget?.exhausted === true) {
    rows.push(...wrap(QUEUE_CHAT_EXHAUSTED_NOTE, theme.error))
  }

  const refusal = describeQueueRefusal(chat.refusal)
  if (refusal !== null) rows.push(...wrap(`! ${refusal}`, theme.warning))

  return rows
}

export const WindbreakQueueView: React.FC<WindbreakQueueViewProps> = ({
  repoRoot,
  state,
  onClose,
  onSelect,
  onToggleResolved,
  onDecide,
  onChat,
}) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  /**
   * Rows hidden *below* the window, so 0 is the end of the pane and a large number is its top.
   *
   * The same convention the scan view uses: the detail opens at its **top**, because the first
   * lines are which candidate this is, while a transcript is read from its newest row.
   */
  const [scroll, setScroll] = useState(Number.MAX_SAFE_INTEGER)
  const [input, setInput] = useState<ViewInput>({ kind: 'none' })
  const [draft, setDraft] = useState({ text: '', cursorPosition: 0 })

  const open = state.phase === 'open'
  const entries = open ? state.entries : []
  const includeResolved = open && state.includeResolved
  const chat = open ? state.chat : null
  const chatting = chat?.open === true
  const hasSelection = open && entries.length > 0 && entries[state.selectedIndex] !== undefined

  // A new selection is a new document, so the pane starts at its top again — except in the chat,
  // where the subject changing does not move the conversation.
  const selectedCandidateId = hasSelection ? entries[state.selectedIndex]!.candidateId : null
  useEffect(() => {
    setScroll(Number.MAX_SAFE_INTEGER)
  }, [selectedCandidateId, includeResolved, chatting])

  const header = useMemo(() => {
    if (state.phase === 'refused') {
      return queueHeaderLines({
        repoRoot,
        refusal: state.reason,
        dbPath: state.dbPath,
        source: null,
        counts: null,
        includeResolved: false,
      })
    }
    return queueHeaderLines({
      repoRoot,
      refusal: null,
      source: state.source,
      counts: state.counts,
      includeResolved: state.includeResolved,
    })
  }, [repoRoot, state])

  const placeholder = useMemo(() => {
    if (state.phase === 'refused') {
      return queuePlaceholderLines({
        refusal: state.reason,
        source: null,
        counts: null,
        includeResolved: false,
      })
    }
    if (state.entries.length > 0) return null
    return queuePlaceholderLines({
      refusal: null,
      source: state.source,
      counts: state.counts,
      includeResolved: state.includeResolved,
    })
  }, [state])

  const listLines = useMemo(
    () => (entries.length === 0 ? [] : queueListLines(entries, open ? state.selectedIndex : 0)),
    [entries, open, state],
  )

  const detailLines = useMemo(
    () => (open && state.detail !== null ? queueDetailLines(state.detail) : []),
    [open, state],
  )

  // Two border columns and two padding columns come out of the content width.
  const cols = Math.max(20, terminalWidth - 4)

  const bodyPlain = useMemo<readonly QueueLine[]>(() => {
    if (chat?.open === true) {
      return chat.starting && chat.turns.length === 0
        ? [
            {
              kind: 'text',
              text: 'starting the investigator…',
              tone: 'muted',
              indent: 0,
            },
          ]
        : buildQueueChatLines(chat.turns)
    }
    return detailLines.length > 0 ? detailLines : (placeholder ?? [])
  }, [chat, detailLines, placeholder])

  const bodyRows = useMemo(() => toRows(bodyPlain, cols, theme), [bodyPlain, cols, theme])

  /**
   * The confirmation of what was just written, wrapped rather than fitted.
   *
   * The one line in this view that must never be truncated: it is the record of a decision the
   * researcher just took responsibility for, on the surface whose whole purpose is that the record
   * says what *they* decided.
   */
  const noticeRows = useMemo(
    () =>
      open && state.notice !== null
        ? toRows(queueNoticeLines(state.notice), cols, theme)
        : [],
    [cols, open, state, theme],
  )

  const chatTarget = useMemo(
    () =>
      chat === null
        ? ''
        : describeQueueChatTarget({
            candidateId: chatting && hasSelection ? entries[state.selectedIndex]!.candidateId : null,
            mode: chat.mode,
            filePath: hasSelection ? entries[state.selectedIndex]!.filePath : null,
            startLine: hasSelection ? entries[state.selectedIndex]!.startLine : null,
          }),
    [chat, chatting, entries, hasSelection, state],
  )

  const chatBudget = chat === null ? null : (chat.turns.at(-1)?.budget ?? chat.budget)
  const chatChrome = chat === null ? [] : chatChromeLines({ chat, cols, target: chatTarget, theme })

  /**
   * The pane's rows, reserved rather than measured.
   *
   * The box cannot overflow — the hint carries how to leave and the notice carries what was just
   * recorded, and both are below the body — so every row this view draws is subtracted from the
   * terminal height up front, including the ones that appear only sometimes.
   */
  const reservedRows =
    2 /* box borders */ +
    1 /* the divider under the header */ +
    1 /* the hint */ +
    noticeRows.length +
    (input.kind === 'rationale' ? 5 : 0) /* consequence, prompt, three-line input */ +
    chatChrome.length +
    header.length

  const inner = Math.max(2, terminalHeight - reservedRows)
  // A conversation gets a rail of the queue rather than a third of the body: the row is context
  // for the answer, and §20.32 already made this choice for the same reason.
  const listBudget =
    listLines.length === 0
      ? 0
      : chatting
        ? Math.min(listLines.length, 3)
        : Math.min(listLines.length, Math.max(1, Math.floor(inner / 3)))
  const detailBudget = Math.max(1, inner - listBudget - (listBudget > 0 ? 1 : 0))
  // Two rows are held back for the scroll indicators, so the window does not move when one
  // appears — the scan view reserves for the same reason.
  const detailWindow = Math.max(1, detailBudget - 2)

  const maxScroll = Math.max(0, bodyRows.length - detailWindow)
  const clamped = Math.min(scroll, maxScroll)
  const end = bodyRows.length - clamped
  const start = Math.max(0, end - detailWindow)
  const visible = bodyRows.slice(start, end)

  const pasteIntoDraft = useMemo(
    () =>
      createPasteHandler({
        text: draft.text,
        cursorPosition: draft.cursorPosition,
        onChange: (value) => {
          setDraft({ text: value.text, cursorPosition: value.cursorPosition })
        },
      }),
    [draft.text, draft.cursorPosition],
  )

  const beginDecision = useCallback((decision: ReviewDecision) => {
    setInput({ kind: 'rationale', decision })
    setDraft({ text: '', cursorPosition: 0 })
  }, [])

  const submitDecision = useCallback(() => {
    if (input.kind !== 'rationale' || !hasSelection) return
    const candidateId = entries[state.selectedIndex]!.candidateId
    onDecide({ candidateId, decision: input.decision, rationale: draft.text.trim() })
    setInput({ kind: 'none' })
    setDraft({ text: '', cursorPosition: 0 })
  }, [draft.text, entries, hasSelection, input, onDecide, state])

  const submitQuestion = useCallback(() => {
    if (chat?.pending === true) return
    const text = draft.text.trim()
    if (text.length === 0) return
    onChat.ask(text)
    setDraft({ text: '', cursorPosition: 0 })
  }, [chat, draft.text, onChat])

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const action = resolveWindbreakQueueAction(key, {
        typing: input.kind !== 'none',
        hasSelection,
        chatting,
      })

      switch (action.type) {
        case 'close':
          onClose()
          return
        case 'open-chat':
          setInput({ kind: 'none' })
          setDraft({ text: '', cursorPosition: 0 })
          onChat.open()
          return
        case 'chat-escape':
          // Two meanings, and which one applies is a fact about the conversation rather than a
          // preference: a turn in flight is stopped, an idle pane is closed. Closing first would
          // leave the turn running with its answer going nowhere.
          if (chat?.pending === true) onChat.cancel()
          else onChat.close()
          return
        case 'cancel-rationale':
          // Nothing has been written at this point: `session.decide` is only reached from
          // `submitDecision`, so abandoning the input really does abandon the decision.
          setInput({ kind: 'none' })
          setDraft({ text: '', cursorPosition: 0 })
          return
        case 'select':
          onSelect(action.delta)
          return
        case 'scroll':
          setScroll(Math.min(maxScroll, Math.max(0, clamped + action.delta)))
          return
        case 'toggle-resolved':
          onToggleResolved()
          return
        case 'begin-rationale':
          beginDecision(action.decision)
          return
        default:
          return
      }
    },
    [
      beginDecision,
      chat,
      chatting,
      clamped,
      hasSelection,
      input.kind,
      maxScroll,
      onChat,
      onClose,
      onSelect,
      onToggleResolved,
    ],
  )

  useKeyboard(handleKey)

  const hint = chatting
    ? chat?.pending === true
      ? 'a turn is in flight · esc stops it · the question is still recorded as cancelled'
      : `${QUEUE_CHAT_HINTS} · ↑↓ scroll the transcript`
    : input.kind === 'rationale'
      ? 'type the rationale · enter records the decision · esc abandons it'
      : hasSelection
        ? '↑↓ select · r real · b benign · c ask about this row · a show decided · esc back to chat'
        : 'esc back to chat'

  const chatInputRows = (): number =>
    chat === null || !chat.open || chat.starting || chat.unavailableReason !== null
      ? 0
      : chatBudget?.exhausted === true
        ? 0
        : 3

  return (
    <box
      title=" WindBreak queue "
      titleAlignment="center"
      style={{
        width: '100%',
        borderStyle: 'single',
        borderColor: theme.border,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      {header.map((line, index) => (
        <text
          key={`${index}-${line.kind === 'field' ? line.label : 'line'}`}
          style={{ wrapMode: 'none' }}
        >
          {line.kind === 'field' ? (
            <>
              <span style={{ fg: theme.muted }}>{line.label.padEnd(QUEUE_LABEL_WIDTH)}</span>
              <span style={{ fg: toneColor(line.tone, theme) }}>
                {fit(line.value, Math.max(10, cols - QUEUE_LABEL_WIDTH))}
              </span>
            </>
          ) : (
            <span style={{ fg: theme.foreground }}>
              {line.kind === 'text' ? `${' '.repeat(line.indent)}${line.text}` : line.label}
            </span>
          )}
        </text>
      ))}

      <text style={{ fg: theme.border }}>{'─'.repeat(Math.max(1, cols))}</text>

      {listLines.map((line, index) => (
        <text key={index} style={{ fg: toneColor(line.tone, theme), wrapMode: 'none' }}>
          {fit(line.text, cols)}
        </text>
      ))}

      {listBudget > 0 && (
        <text style={{ fg: theme.border }}>{'─'.repeat(Math.max(1, cols))}</text>
      )}

      {start > 0 && <text style={{ fg: theme.muted }}>{`  ↑ ${start} more row(s)`}</text>}

      {visible.map((row, index) => (
        <text key={`${start + index}`} style={{ fg: row.tone, wrapMode: 'none' }}>
          {row.text === '' ? ' ' : row.text}
        </text>
      ))}

      {end < bodyRows.length && (
        <text style={{ fg: theme.muted }}>{`  ↓ ${bodyRows.length - end} more row(s)`}</text>
      )}

      {noticeRows.map((row, index) => (
        <text key={`notice-${index}`} style={{ fg: row.tone, wrapMode: 'none' }}>
          {row.text === '' ? ' ' : row.text}
        </text>
      ))}

      {chat !== null && chat.open && (
        <>
          {chatChrome.map((row, index) => (
            <text key={`chat-chrome-${index}`} style={{ fg: row.tone, wrapMode: 'none' }}>
              {row.text === '' ? ' ' : row.text}
            </text>
          ))}

          {chatInputRows() > 0 && (
            <MultilineInput
              value={draft.text}
              cursorPosition={draft.cursorPosition}
              onChange={(value) => {
                setDraft({ text: value.text, cursorPosition: value.cursorPosition })
              }}
              onSubmit={submitQuestion}
              onPaste={pasteIntoDraft}
              // Disabled while a turn is in flight: a second question would be a second
              // conversation on one budget, and the engine has no way to keep them apart.
              focused={!chat.pending}
              placeholder={QUEUE_CHAT_HINTS}
              maxHeight={3}
            />
          )}
        </>
      )}

      {input.kind === 'rationale' && hasSelection && (
        <>
          <text style={{ fg: theme.muted, wrapMode: 'none' }}>
            {fit(
              input.decision === 'real'
                ? 'real — the candidate joins verification as confirmed'
                : 'benign — the candidate is dropped from verification, kept as a negative example',
              cols,
            )}
          </text>
          <text style={{ fg: theme.foreground, wrapMode: 'none' }}>
            {`> rationale for ${shortCandidateId(entries[state.selectedIndex]!.candidateId)} (empty is recorded as none)`}
          </text>
          <MultilineInput
            value={draft.text}
            cursorPosition={draft.cursorPosition}
            onChange={(value) => {
              setDraft({ text: value.text, cursorPosition: value.cursorPosition })
            }}
            onSubmit={submitDecision}
            onPaste={pasteIntoDraft}
            focused
            maxHeight={3}
          />
        </>
      )}

      <text style={{ fg: theme.muted, wrapMode: 'none' }}>{fit(hint, cols)}</text>
    </box>
  )
}
