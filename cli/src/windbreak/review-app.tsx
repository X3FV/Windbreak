import { useKeyboard } from '@opentui/react'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'

import { resolveReviewAction, WHEEL_ROWS } from './actions'
import { WindbreakColorsProvider } from './colors-context'
import { buildDecisionCard, type DecisionNotice } from './decision-lines'
import { DecisionPane } from './decision-pane'
import { buildDetailLines } from './detail-lines'
import { DetailPane } from './detail-pane'
import {
  COLUMN_CHROME_ROWS,
  LAYOUT_LABELS,
  MIN_CARD_ROWS,
  MIN_PANE_ROWS,
  PANE_CHROME,
  PANE_FRAME_ROWS,
  chatColumnsFor,
  computeColumnPlan,
  nextLayout,
} from './layout'
import {
  DEFAULT_WINDBREAK_PREFERENCES,
  type WindbreakPreferences,
} from './preferences'
import { DEFAULT_MAX_VISIBLE_ROWS, QueueList, windowStart } from './queue-list'
import { buildHintLine, shortenPath } from './text'
import {
  WINDBREAK_THEME_LABELS,
  nextWindbreakTheme,
  resolveWindbreakColors,
} from './theme'

import { ChatPane } from './chat-pane'
import {
  buildChatHintLine,
  buildChatLines,
  describeAgentSwitch,
  describeBudget,
  describeChatAgent,
  describeChatTarget,
  parseChatInput,
  wrapChatLines,
} from './chat-lines'
import { CodebasePane } from './codebase-pane'
import { buildCodebaseLines } from './codebase-lines'

import type { KeyEvent } from '@opentui/core'
import type {
  ConversationBudgetState,
  InvestigatorAgentName,
  ReviewEntrySummary,
  ReviewInvestigator,
  ReviewSession,
} from '@codebuff/windbreak/review'
import type { ReviewDecision, ReviewMode } from './actions'
import type { ChatTurn } from './chat-lines'

interface ReviewAppProps {
  session: ReviewSession
  /** Where the queue came from, shown so a researcher can tell two databases apart. */
  dbPath: string
  /** Filtered to one run, when the subcommand was given `--run`. */
  runId?: string | undefined
  includeResolvedInitially?: boolean
  /** The saved arrangement and palette; the defaults are used when omitted. */
  preferences?: WindbreakPreferences | undefined
  /**
   * Called when a key changes the arrangement or the palette.
   *
   * The screen never touches the filesystem itself: it reports the new value and
   * the caller persists it. That is what lets the tests cycle the layout without
   * writing to a real home directory.
   */
  onPreferencesChange?: ((next: WindbreakPreferences) => void) | undefined
  /** Called when the researcher leaves the screen. */
  onExit: () => void
  /**
   * §20.29's investigator, when the caller could build one.
   *
   * Optional, and its absence is a supported state rather than a degraded one: the queue
   * is a database and reviewing a disagreement needs no model, so a review with no
   * credentials must still work. When it is missing, or when it reports its own
   * `unavailableReason`, the pane says why instead of looking ready (\u00a718).
   */
  investigator?: ReviewInvestigator | undefined
}

/**
 * §5.3's human tiebreak, as a screen (D32, §20.16).
 *
 * The screen is a *reading* surface before it is a deciding one. A queue entry
 * exists because two providers disagreed, so the first job is to show both
 * arguments whole — with the model that made each — next to the code they are
 * about. Only then does `r`/`b` mean anything.
 *
 * The arrangement is three panes — queue, argument, decision — degrading to two
 * and then to a stack as the terminal narrows. The arguments keep their column
 * longest: the queue is a fixed shape and the card is a handful of fields, while
 * every column a wrapped sentence does not get is a line the researcher scrolls.
 *
 * Nothing is decided by omission: there is no timeout, no "accept all", and
 * leaving the screen records nothing. The decision and its rationale go through
 * the session, which writes them with the pipeline's own
 * `recordAdjudicationDecision`, so a decision made here is the same kind of
 * record as one made by `windbreak review --decide`.
 */
export const ReviewApp: React.FC<ReviewAppProps> = ({
  session,
  dbPath,
  runId,
  includeResolvedInitially = false,
  preferences,
  onPreferencesChange,
  onExit,
  investigator,
}) => {
  const theme = useTheme()

  // ---- state --------------------------------------------------------------
  const [includeResolved, setIncludeResolved] = useState(includeResolvedInitially)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mode, setMode] = useState<ReviewMode>('browse')
  /**
   * The mode, readable synchronously.
   *
   * `useKeyboard`'s handler closes over the mode from the render that installed
   * it, and a key can arrive in the window between `setMode('rationale')` and
   * the commit that installs the new handler. Reading the render's value there
   * would resolve that keystroke as a *browse* command — so a researcher who
   * typed `r` and then `b` quickly would silently stage a `benign` decision
   * instead of starting their rationale with that letter. The ref closes the
   * window: the mode is the researcher's intent, not the last painted frame.
   */
  const modeRef = useRef<ReviewMode>('browse')
  const enterMode = useCallback((next: ReviewMode) => {
    modeRef.current = next
    setMode(next)
  }, [])
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null)
  const [rationale, setRationale] = useState('')
  /**
   * Bumped on every write. `session.detail` re-reads the database, so the memo
   * below has to know when the database changed rather than when a React value
   * did.
   */
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState<DecisionNotice | null>(null)
  /**
   * First visible row of the detail pane.
   *
   * A view position, not a selection: moving the cursor to another disagreement
   * resets it, because a scroll offset means nothing on a page of different
   * text. Keeping it in one piece of state and clearing it on selection is
   * cheaper than a map keyed by candidate that would only ever hold one entry.
   */
  const [detailOffset, setDetailOffset] = useState(0)
  /**
   * First visible row of the file listing.
   *
   * A view position like `detailOffset`, and cleared on the same events for the same
   * reason: an offset means nothing on a listing of a different target, and the two
   * panes share a slot, so a stale offset would open the files halfway down.
   */
  const [codebaseOffset, setCodebaseOffset] = useState(0)
  const [prefs, setPrefs] = useState<WindbreakPreferences>(
    preferences ?? DEFAULT_WINDBREAK_PREFERENCES,
  )

  const changePreferences = useCallback(
    (next: WindbreakPreferences) => {
      setPrefs(next)
      onPreferencesChange?.(next)
    },
    [onPreferencesChange],
  )

  // ---- the queue ----------------------------------------------------------
  const entries = useMemo<ReviewEntrySummary[]>(
    () => session.list({ includeResolved }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, includeResolved, revision],
  )

  const counts = useMemo(
    () => session.counts(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, revision],
  )

  const safeIndex = Math.max(0, Math.min(selectedIndex, entries.length - 1))
  const selected = entries[safeIndex] ?? null

  /**
   * Move the cursor, and reset the detail's scroll with it.
   *
   * The setter form is used so the reset decision is made against the index the
   * commit actually applied: a wheel notch that would clamp to where the cursor
   * already is must not discard the researcher's place in the argument.
   */
  const selectIndex = useCallback(
    (index: number) => {
      setSelectedIndex((current) => {
        const clamped = Math.max(0, Math.min(entries.length - 1, index))
        if (clamped !== current) {
          setDetailOffset(0)
          setCodebaseOffset(0)
        }
        return clamped
      })
    },
    [entries.length],
  )

  const selectBy = useCallback(
    (delta: number) => selectIndex(safeIndex + delta),
    [selectIndex, safeIndex],
  )

  // --- the investigator's pane (§20.29.4) ---------------------------------------

  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatOffset, setChatOffset] = useState(0)
  const [chatPending, setChatPending] = useState(false)
  /**
   * Which agent the next question goes to (§20.30).
   *
   * Screen state rather than bridge state, because it is a choice the researcher
   * makes about the question they are about to ask — not a property of the
   * conversation. The bridge is told which agent per turn, so the two cannot
   * disagree about a running turn's agent.
   */
  const [chatAgent, setChatAgent] = useState<InvestigatorAgentName>('investigator')
  /**
   * The conversation's ceiling and usage (§20.29.6), read from the bridge.
   *
   * Seeded from the bridge rather than assumed, because a conversation that already
   * spent something — a second mount, a hot reload — must not display as unspent. The
   * count lives on the bridge, which outlives this render.
   */
  const [chatBudget, setChatBudget] = useState<ConversationBudgetState | null>(
    () => investigator?.budget() ?? null,
  )
  /**
   * The in-flight turn's abort handle, or null.
   *
   * A ref rather than state, because `esc` has to see it the instant a turn starts: a
   * `pending` boolean is committed by a render, and a key arriving in the gap would be
   * resolved against a screen that does not know a turn is running. The ref is also what
   * `resolveReviewAction` reads, so there is one source of "is it busy".
   */
  const chatAbortRef = useRef<AbortController | null>(null)

  /**
   * What the next question will be about.
   *
   * `modeFor` is the bridge's, not a guess: the mode follows what is selected, and a
   * queue with nothing in it has nothing to explain.
   */
  const chatMode = investigator?.modeFor(selected?.candidateId ?? null) ?? 'hunt'
  const chatTargetLabel = describeChatTarget(chatMode, {
    filePath: selected?.filePath ?? null,
    startLine: selected?.startLine ?? null,
  })
  const chatUnavailable = investigator?.unavailableReason ?? null
  const chatExhausted = chatBudget?.exhausted === true

  // One row above the input, three readings joined: which agent the next question goes
  // to, how much of the conversation's ceiling is spent, and what it would be about.
  // They share a row because all three answer "what happens if I type here", which is
  // the question that row exists for — and the agent leads, because on this pane it is
  // the one that changes what the words mean.
  const chatInfoLine = [
    describeChatAgent(chatAgent, investigator?.workingCopy() ?? null),
    describeBudget(chatBudget),
    chatTargetLabel,
  ]
    .filter((part) => part.length > 0)
    .join(' · ')

  // The browse arrangements' segment for the chat key. The *inside* of the chat has a hint
  // row of its own (`buildChatHintLine`), because in that arrangement the browse keys are
  // inert rather than secondary — the input owns every letter — and a row that listed them
  // would be claiming functions the screen does not have.
  const chatHintLine =
    chatUnavailable !== null || !investigator ? '' : 'c ask'

  const submitChat = useCallback(() => {
    // The ceiling is checked here as well as in the bridge: a spent conversation must not
    // put a pending turn on screen, because there is nothing for it to become.
    if (!investigator || chatUnavailable !== null || chatPending || chatExhausted) return

    const parsed = parseChatInput(chatInput, chatMode)
    if (!parsed) return

    // An `explain` turn is about the row that was on screen when the question was
    // asked, so the candidate is captured now rather than read later: the answer must
    // not change if the cursor moves while the model is working. The agent is captured
    // the same way, so a `tab` pressed while a turn runs cannot relabel it.
    const candidateId = parsed.mode === 'explain' ? (selected?.candidateId ?? null) : null
    const agent = chatAgent
    const turn: ChatTurn = {
      mode: parsed.mode,
      agent,
      workingCopyId: null,
      writes: [],
      prompt: parsed.prompt,
      answer: null,
      error: null,
      toolsUsed: [],
      proposals: [],
      proposalRejections: [],
      injectionSignals: [],
      recordedTurnId: null,
      pending: true,
    }

    // One controller per turn: `esc` aborts exactly the turn that is running, and a
    // settled turn's handle is replaced rather than reused, so a late `esc` cannot stop
    // the question after it.
    const controller = new AbortController()
    chatAbortRef.current = controller

    setChatInput('')
    setChatOffset(0)
    setChatPending(true)
    setChatTurns((turns) => [...turns, turn])

    const settle = (next: Omit<ChatTurn, 'pending'>) => {
      setChatTurns((turns) => {
        const settled = [...turns]
        const index = settled.length - 1
        if (index >= 0) settled[index] = next
        return settled
      })
    }

    void investigator
      .ask({
        runId: runId ?? null,
        candidateId,
        mode: parsed.mode,
        agent,
        prompt: parsed.prompt,
        signal: controller.signal,
      })
      .then((result) => {
        settle({
          mode: parsed.mode,
          // The bridge's answer, not the captured request: if the two ever disagree the
          // transcript must show what actually ran, and only the bridge knows that.
          agent: result.agent,
          workingCopyId: result.workingCopyId,
          writes: result.writes,
          prompt: parsed.prompt,
          answer: result.answer,
          error: result.error,
          toolsUsed: result.toolsUsed,
          proposals: result.proposals,
          proposalRejections: result.proposalRejections,
          injectionSignals: result.injectionSignals,
          recordedTurnId: result.recordedTurnId,
          cancelled: result.cancelled,
        })
        // The turn's own reading of the budget, so the pane cannot show a count the turn
        // did not actually charge.
        setChatBudget(result.budget)
      })
      .catch((error: unknown) =>
        settle({
          mode: parsed.mode,
          agent,
          workingCopyId: null,
          writes: [],
          prompt: parsed.prompt,
          answer: null,
          error: `the investigator failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          toolsUsed: [],
          proposals: [],
          proposalRejections: [],
          injectionSignals: [],
          recordedTurnId: null,
          cancelled: false,
        }),
      )
      .finally(() => {
        // Cleared before the re-read so `esc` stops targeting a turn that is over. The
        // identity check keeps a stale settle from clearing a newer turn's handle.
        if (chatAbortRef.current === controller) chatAbortRef.current = null
        setChatBudget(investigator.budget())
        setChatPending(false)
      })
  }, [
    investigator,
    chatUnavailable,
    chatPending,
    chatExhausted,
    chatInput,
    chatMode,
    chatAgent,
    selected,
    runId,
  ])

  const scrollChat = useCallback((delta: number) => {
    setChatOffset((offset) => Math.max(0, offset + delta))
  }, [])

  const detail = useMemo(
    () => (selected ? session.detail(selected.candidateId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, selected?.candidateId, revision],
  )

  /**
   * The codebase behind the selected disagreement (§20.30).
   *
   * Read regardless of the mode, because whether an inventory exists is what decides
   * whether `f` is offered at all — and offering a key that opens an empty pane is the
   * mistake §18's rule covers in the pane's own chrome. The read is one indexed query
   * against `recon_files`, the same shape `list` and `counts` already make per render.
   */
  // ---- geometry -----------------------------------------------------------
  const { terminalWidth, terminalHeight } = useTerminalDimensions()
  const width = '100%'
  const columns = Math.max(40, terminalWidth)

  const colors = useMemo(
    () => resolveWindbreakColors(theme, prefs.theme, prefs.colors),
    [theme, prefs.theme, prefs.colors],
  )

  const plan = useMemo(
    () =>
      computeColumnPlan({
        columns,
        rows: terminalHeight,
        layout: prefs.layout,
        queueWidth: prefs.queueWidth,
        decisionWidth: prefs.decisionWidth,
      }),
    [columns, terminalHeight, prefs.layout, prefs.queueWidth, prefs.decisionWidth],
  )

  /**
   * The vertical budget, spent explicitly.
   *
   * A scrolling pane needs a viewport height, and a viewport is only honest if
   * the rows above it are known — so the queue's block is measured rather than
   * left to flex: its rows, plus the two "more" indicators it may draw, plus its
   * border. Everything that is not a pane is a fixed two rows. What is left is
   * the panes'.
   */
  const body = Math.max(0, terminalHeight - COLUMN_CHROME_ROWS)

  /**
   * The card, then the rows it needs.
   *
   * Built before the heights are known because its own line count is what
   * decides how many rows it gets when it is not a column. Its *width*, though,
   * depends on the arrangement: a column is its own width, a bottom block spans
   * the screen.
   */
  const cardWidth = plan.mode === 'columns' ? plan.decisionWidth : columns

  const card = useMemo(
    () =>
      buildDecisionCard({
        entry: selected,
        candidateState: detail?.candidateState ?? null,
        counts,
        pendingDecision,
        mode,
        notice,
        includeResolved,
        layoutLabel: LAYOUT_LABELS[prefs.layout],
        themeLabel: WINDBREAK_THEME_LABELS[prefs.theme],
        contentWidth: cardWidth - PANE_CHROME,
      }),
    [
      selected,
      detail?.candidateState,
      counts,
      pendingDecision,
      mode,
      notice,
      includeResolved,
      prefs.layout,
      prefs.theme,
      cardWidth,
    ],
  )

  /**
   * The card's block height when it is *not* a column.
   *
   * Capped at half the body and at what the panes can spare, so a long notice or
   * a wrapped pattern id cannot grow the card until the arguments are a sliver.
   */
  const cardBlockRows =
    Math.min(
      card.lines.length,
      Math.max(MIN_CARD_ROWS, Math.floor(body / 2)),
      Math.max(MIN_CARD_ROWS, body - MIN_PANE_ROWS - PANE_FRAME_ROWS),
    ) + PANE_FRAME_ROWS

  const detailBlocks = useMemo(() => {
    if (plan.mode === 'columns') {
      return { rows: Math.max(MIN_PANE_ROWS, body - PANE_FRAME_ROWS), card: 0 }
    }
    if (plan.mode === 'split') {
      return {
        rows: Math.max(MIN_PANE_ROWS, body - cardBlockRows - PANE_FRAME_ROWS),
        card: cardBlockRows,
      }
    }

    const queueRows =
      entries.length === 0 ? 1 : Math.min(entries.length, DEFAULT_MAX_VISIBLE_ROWS)
    const queueStart = windowStart(safeIndex, entries.length, DEFAULT_MAX_VISIBLE_ROWS)
    const queueBlock =
      queueRows +
      PANE_FRAME_ROWS +
      (queueStart > 0 ? 1 : 0) /* "N more" above */ +
      (queueStart + queueRows < entries.length ? 1 : 0) /* "N more" below */

    const detailBlock = Math.max(
      MIN_PANE_ROWS + PANE_FRAME_ROWS,
      Math.min(
        Math.floor(body * 0.45),
        body - queueBlock - MIN_CARD_ROWS - PANE_FRAME_ROWS,
      ),
    )

    // The card takes the remainder rather than a share: on a terminal this small
    // the panes are already at their minimum, and a card with no rows at all is
    // the honest outcome — the screen says nothing rather than a truncated claim.
    return {
      rows: Math.max(MIN_PANE_ROWS, detailBlock - PANE_FRAME_ROWS),
      card: Math.max(0, body - queueBlock - detailBlock),
    }
  }, [plan.mode, body, cardBlockRows, entries.length, safeIndex])

  // Pane width for the detail is the plan's; the wrapped prose is told exactly
  // what the pane has left after its border and padding.
  const detailContentWidth =
    plan.mode === 'stacked' ? columns - PANE_CHROME : plan.detailWidth - PANE_CHROME

  const detailLines = useMemo(
    () => buildDetailLines(detail, detailContentWidth),
    [detail, detailContentWidth],
  )

  // ---- the full-size chat (§20.32) -----------------------------------------

  /**
   * How the body is split when the chat is open: a narrow queue rail, and prose.
   *
   * `chatColumnsFor` decides whether the rail fits at all, so this is also what the hint
   * row reads to know whether to name the key that moves the rail's cursor.
   */
  const chatColumns = chatColumnsFor(columns)
  const chatContentWidth = chatColumns.chat - PANE_CHROME

  /**
   * The transcript, wrapped to the width the chat is actually drawn at.
   *
   * Wrapped *here* rather than inside the pane, because the two must agree about what a
   * row is: the pane scrolls by row index and the scroll arithmetic counts lines, so a
   * pane that wrapped as it drew would be scrolling in a unit nobody had counted. The
   * width is a dependency rather than a constant because it changes with the terminal and
   * with whether the rail fits — and a stale wrap is a transcript that overflows its pane
   * or leaves half of it empty.
   */
  const chatLines = useMemo(
    () => wrapChatLines(buildChatLines(chatTurns), chatContentWidth),
    [chatTurns, chatContentWidth],
  )

  const maxDetailOffset = Math.max(0, detailLines.length - detailBlocks.rows)
  // The stored offset is clamped at render rather than corrected in an effect:
  // resizing the terminal or deciding an entry shrinks the content, and a stale
  // offset would otherwise paint a blank pane until the next key.
  const safeDetailOffset = Math.max(0, Math.min(detailOffset, maxDetailOffset))

  const scrollDetail = useCallback(
    (delta: number) => {
      setDetailOffset((current) => Math.max(0, Math.min(maxDetailOffset, current + delta)))
    },
    [maxDetailOffset],
  )

  // ---- the codebase (§20.30) ----------------------------------------------

  /**
   * The codebase behind the selected disagreement.
   *
   * Read regardless of the mode, because whether an inventory exists is what decides
   * whether `f` is offered at all — and offering a key that opens an empty pane is the
   * mistake §18's rule covers in the pane's own chrome. The read is one indexed query
   * against `recon_files`, the same shape `list` and `counts` already make per render.
   */
  const codebase = useMemo(
    () => session.codebase(selected?.candidateId ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, selected?.candidateId, revision],
  )

  const codebaseLines = useMemo(() => buildCodebaseLines(codebase), [codebase])

  const maxCodebaseOffset = Math.max(0, codebaseLines.lines.length - detailBlocks.rows)
  const safeCodebaseOffset = Math.max(0, Math.min(codebaseOffset, maxCodebaseOffset))

  const scrollCodebase = useCallback(
    (delta: number) => {
      setCodebaseOffset((current) =>
        Math.max(0, Math.min(maxCodebaseOffset, current + delta)),
      )
    },
    [maxCodebaseOffset],
  )

  // The files segment. Omitted when the target has no inventory rather than shown
  // greyed, which is the rule the chat segment already follows: a key that does nothing
  // is worse than a key that is not offered.
  const codebaseHintLine =
    codebase === null
      ? ''
      : mode === 'codebase'
        ? 'esc back · ↑↓ scroll'
        : 'f files'

  // ---- deciding -----------------------------------------------------------
  /**
   * Enter arrives twice, deliberately: once from the focused input's own
   * `onSubmit` and once from the screen's global handler. The duplication is the
   * point — terminals disagree about which of them sees a given Enter, and
   * missing the key entirely would strand the researcher in the rationale mode.
   * Both paths are therefore wired, and this guard makes the second one a no-op,
   * so the recorded notice names the decision the entry actually had.
   */
  const decisionInFlight = useRef(false)

  const decide = useCallback(
    (decision: ReviewDecision) => {
      if (!selected) return

      const candidateId = selected.candidateId
      const answeredRationale = rationale.trim()

      try {
        const { previous } = session.decide({
          candidateId,
          decision,
          rationale: answeredRationale.length > 0 ? answeredRationale : null,
        })

        setNotice({
          text:
            `recorded ${candidateId} as ${decision}` +
            (previous ? ` (was ${previous}, changed)` : '') +
            (answeredRationale.length > 0 ? '' : ' with no rationale'),
          failed: false,
        })
        setRevision((value) => value + 1)
        // The decided entry leaves the pending list, so the same index now
        // points at the next one. In `--all` mode it stays put and is shown
        // with its recorded decision, which is what "show them" means.
      } catch (error) {
        // §18: a decision that could not be written is not a decision. It is
        // reported as a failure, in the failure's own colour, and the screen
        // stays on the entry.
        setNotice({
          text: error instanceof Error ? error.message : String(error),
          failed: true,
        })
      } finally {
        // The guard is *not* cleared here. Enter reaches this screen twice (the
        // input's `onSubmit` and the global handler), and both keystrokes are
        // resolved against the same pre-commit closure, so clearing it now would
        // let the second Enter record the decision a second time. It is cleared
        // where a new decision begins, which is what makes it a guard on one
        // decision rather than on the screen.
        setPendingDecision(null)
        setRationale('')
        // Through `enterMode`, not `setMode`: the ref has to move with the
        // state or the next keystroke is still read as rationale text.
        enterMode('browse')
      }
    },
    [selected, rationale, session, enterMode],
  )

  const submitDecision = useCallback(() => {
    if (!pendingDecision || decisionInFlight.current) return
    decisionInFlight.current = true
    decide(pendingDecision)
  }, [pendingDecision, decide])

  // ---- keys ---------------------------------------------------------------
  /**
   * Content rows the chat pane's transcript gets.
   *
   * The pane spends two of its rows on the target label and the input (see
   * `chat-pane.tsx`), so this is the slot height minus those, and a page is this figure
   * minus one row for continuity.
   */
  const chatRows = Math.max(1, detailBlocks.rows - 2)

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        const action = resolveReviewAction(key, {
          mode: modeRef.current,
          // Read from the handle, not from `chatPending`: the handle is set synchronously
          // when a turn starts, so `esc` cannot miss the window a state commit leaves.
          chatBusy: chatAbortRef.current !== null,
        })

        switch (action.type) {
          case 'quit':
            onExit()
            return
          case 'select':
            selectBy(action.delta)
            return
          case 'begin-decision':
            decisionInFlight.current = false
            setPendingDecision(action.decision)
            setRationale('')
            enterMode('rationale')
            return
          case 'cancel-decision':
            decisionInFlight.current = false
            setPendingDecision(null)
            setRationale('')
            enterMode('browse')
            return
          case 'submit-decision':
            submitDecision()
            return
          case 'toggle-resolved':
            setIncludeResolved((value) => !value)
            // The list is about to be a different list; neither the cursor nor
            // the scroll position carries over to it.
            setSelectedIndex(0)
            setDetailOffset(0)
            setCodebaseOffset(0)
            return
          case 'scroll-detail':
            // A page is the viewport minus one row, so one line of the previous
            // page stays for continuity.
            scrollDetail(action.pages * Math.max(1, detailBlocks.rows - 1))
            return
          case 'cycle-layout':
            changePreferences({ ...prefs, layout: nextLayout(prefs.layout) })
            return
          case 'cycle-theme':
            changePreferences({ ...prefs, theme: nextWindbreakTheme(prefs.theme) })
            return
          case 'enter-chat':
            // Refused without an investigator rather than opened empty: a pane that takes
            // a question and cannot answer it is worse than one that is not there.
            //
            // `enterMode`, not `setMode`. The resolver reads `modeRef`, and a plain
            // `setMode` leaves it saying `browse` — so every key in the chat would be
            // resolved as a browse command: `escape` would quit the whole screen instead
            // of leaving the pane, and an `r` or `b` typed into a question would stage a
            // decision behind it. Found by pressing the keys rather than by reading the
            // code, which is the only way this class of defect shows up.
            if (investigator && investigator.unavailableReason === null) enterMode('chat')
            return
          case 'cancel-chat':
            // Escape leaves the chat, not the screen: the researcher keeps their place in
            // the queue, which is the whole reason the two are one surface. `enterMode`
            // for the same reason as above — the ref has to agree with the mode the pane
            // was drawn in.
            enterMode('browse')
            return
          case 'switch-agent':
            // The model after the next question, not the one after this click: a turn
            // already running keeps the agent it was sent with (`submitChat` captures
            // it), so switching mid-turn changes what happens next and not what is
            // happening.
            setChatAgent((agent) => (agent === 'engineer' ? 'investigator' : 'engineer'))
            return
          case 'abort-turn':
            // Fires the signal the running turn was given; the turn settles as cancelled
            // and is still recorded. Nothing is cleared here — the settle path does that,
            // so a slow abort cannot leave the pane thinking it is idle while a run is
            // still winding down.
            chatAbortRef.current?.abort()
            return
          case 'submit-chat':
            submitChat()
            return
          case 'scroll-chat':
            scrollChat(action.delta * WHEEL_ROWS)
            return
          case 'scroll-chat-page':
            scrollChat(action.pages * Math.max(1, chatRows - 1))
            return
          case 'enter-codebase':
            // Refused without an inventory, the same way `c` is refused without an
            // investigator: a pane that can only say it has nothing is worse than one
            // that is not offered. The header says which of the two absences it is.
            if (codebase !== null) enterMode('codebase')
            return
          case 'cancel-codebase':
            // Back to the arguments, not out of the screen: the researcher keeps their
            // place in the queue, which is what makes the files one surface with the
            // disagreement rather than a detour from it.
            enterMode('browse')
            return
          case 'scroll-codebase':
            scrollCodebase(action.delta * WHEEL_ROWS)
            return
          case 'scroll-codebase-page':
            scrollCodebase(action.pages * Math.max(1, detailBlocks.rows - 1))
            return
          case 'none':
            return
        }
      },
      [
        changePreferences,
        codebase,
        detailBlocks.rows,
        enterMode,
        onExit,
        prefs,
        scrollCodebase,
        scrollDetail,
        selectBy,
        submitDecision,
      ],
    ),
  )

  // ---- the arrangement ----------------------------------------------------
  //
  // Three ways to have nothing to show, and the screen has to say which one it
  // is: a missing database is not an empty queue (§18), and an all-resolved
  // queue is not either. The absent case is the one a reader is most likely to
  // misread as good news, so it names the path it looked in and the way out.
  const emptyMessage =
    counts.total > 0
      ? 'Every disagreement here is resolved. Press a to show them.'
      : session.source.absent
        ? 'No state database. Nothing has been scanned here — this is not an empty ' +
          'queue. Run a scan, or point --db at one.'
        : 'Nothing is queued. §5.3 only escalates a candidate when two providers disagree about it.'

  const nothingToAdjudicate =
    entries.length > 0
      ? plan.mode === 'stacked'
        ? 'Select a disagreement in the list above.'
        : 'Select a disagreement in the list to the left.'
      : session.source.absent
        ? 'Nothing has been scanned here.'
        : 'There is nothing to adjudicate.'

  /**
   * The queue, as a column in an arrangement or as §20.32's rail.
   *
   * `railWidth` is an override rather than a second component: the rail is the same list
   * with less room and no keyboard, so it keeps the same selection, the same counters and
   * the same empty message. `focused` stays tied to `browse` — while the chat is open the
   * input has the keyboard, and a rail that looked focused would be advertising keys that
   * are going into a question.
   */
  const queue = (visibleRows: number, height: number | undefined, railWidth?: number) => (
    <QueueList
      entries={entries}
      selectedIndex={safeIndex}
      maxVisibleRows={visibleRows}
      height={height}
      width={railWidth ?? plan.queueWidth}
      emptyMessage={emptyMessage}
      onSelectIndex={selectIndex}
      onScroll={selectBy}
      focused={mode === 'browse'}
    />
  )

  const argumentPane = (height: number) => (
    <DetailPane
      detail={detail}
      lines={detailLines}
      offset={safeDetailOffset}
      height={height}
      width={plan.detailWidth}
      onScroll={scrollDetail}
      emptyMessage={nothingToAdjudicate}
    />
  )

  /**
   * The file listing, in the detail pane's slot (§20.30).
   *
   * The detail slot rather than the decision card's, which is where the chat went: a
   * path is read left to right, and the detail pane is the only one sized for prose. The
   * queue and the card stay, so opening the files costs neither the researcher's place
   * nor the disagreement they were reading.
   */
  const codebasePane = (height: number) => (
    <CodebasePane
      lines={codebaseLines.lines}
      offset={safeCodebaseOffset}
      height={height}
      width={plan.detailWidth}
      onScroll={scrollCodebase}
      location={codebase?.location ?? null}
    />
  )

  /**
   * One slot, two readings: the arguments, or the codebase they are about.
   *
   * Switching rather than splitting, because the two answer the same question in
   * sequence — "what did they say" and "what does the code say" — and a terminal that
   * can hold three panes cannot profitably hold four.
   */
  const argumentSlot = (height: number) =>
    mode === 'codebase' ? codebasePane(height) : argumentPane(height)

  const decisionCard = (height: number) => (
    <DecisionPane
      lines={card.lines}
      rationaleRow={card.rationaleRow}
      height={height}
      width={plan.mode === 'columns' ? plan.decisionWidth : columns}
      rationale={rationale}
      onRationaleInput={setRationale}
      onRationaleSubmit={submitDecision}
      focused={mode === 'rationale'}
    />
  )

  /**
   * The chat pane (§20.29.4, §20.32).
   *
   * It takes the body rather than a column since §20.32: a model's answer is prose, and
   * prose in a 30-column slot was arriving truncated. The default width is the full-size
   * one, so the only caller that passes anything is a test.
   */
  const chatPane = (height: number, paneWidth: number = chatColumns.chat) => (
    <ChatPane
      lines={chatLines}
      offset={chatOffset}
      height={height}
      width={paneWidth}
      agentLabel={chatAgent}
      infoLine={chatInfoLine}
      pending={chatPending}
      exhausted={chatExhausted}
      unavailableReason={chatUnavailable}
      input={chatInput}
      onInput={setChatInput}
      onSubmit={submitChat}
      focused={mode === 'chat'}
    />
  )

  /**
   * The full-size chat: the queue rail beside the conversation (§20.32).
   *
   * The arguments and the card are gone, and that is the trade the researcher chose by
   * pressing `c` — this is the one arrangement where the question is *not* asked with the
   * disagreement in view. Nothing is lost that matters, because a question is composed
   * against the selected row and the turn records which candidate it was about; what is
   * gained is a transcript that can be read.
   */
  const fullChat = (
    <box style={{ flexDirection: 'row', width }}>
      {chatColumns.rail === null
        ? null
        : /* Two rows are held back for the rail's own "N more" counters, the same
             reservation the column arrangement makes. */
          queue(Math.max(1, body - 2 - PANE_FRAME_ROWS), body - PANE_FRAME_ROWS, chatColumns.rail)}
      {chatPane(body - PANE_FRAME_ROWS)}
    </box>
  )

  let arrangement: React.ReactNode
  if (mode === 'chat') {
    arrangement = fullChat
  } else if (plan.mode === 'columns') {
    arrangement = (
      <box style={{ flexDirection: 'row', width }}>
        {/* Two rows are held back for the queue's "N more" counters: reserving
            the whole pane for entries would push them outside the frame. */}
        {queue(Math.max(1, detailBlocks.rows - 2), detailBlocks.rows)}
        {argumentSlot(detailBlocks.rows)}
        {decisionCard(detailBlocks.rows)}
      </box>
    )
  } else if (plan.mode === 'split') {
    arrangement = (
      <>
        <box style={{ flexDirection: 'row', width }}>
          {queue(Math.max(1, detailBlocks.rows - 2), detailBlocks.rows)}
          {argumentSlot(detailBlocks.rows)}
        </box>
        {detailBlocks.card > PANE_FRAME_ROWS
          ? decisionCard(detailBlocks.card - PANE_FRAME_ROWS)
          : null}
      </>
    )
  } else {
    arrangement = (
      <>
        {queue(DEFAULT_MAX_VISIBLE_ROWS, undefined)}
        {argumentSlot(detailBlocks.rows)}
        {detailBlocks.card > PANE_FRAME_ROWS
          ? decisionCard(detailBlocks.card - PANE_FRAME_ROWS)
          : null}
      </>
    )
  }

  return (
    <WindbreakColorsProvider colors={colors}>
      <box
        style={{
          width,
          height: '100%',
          flexDirection: 'column',
          paddingLeft: 0,
          paddingRight: 0,
        }}
      >
        <box style={{ flexDirection: 'row', width, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: colors.headerText }}>WindBreak adjudication</text>
          <text style={{ fg: colors.headerMeta }}>
            {'  '}
            {shortenPath(dbPath, 3)}
            {session.source.absent ? ' · not found' : ''}
            {runId ? ` · run ${runId}` : ''}
            {includeResolved ? ' · showing resolved' : ''}
          </text>
        </box>

        {arrangement}

        <box style={{ flexDirection: 'row', width, paddingLeft: 1, paddingRight: 1 }}>
          <text style={{ fg: colors.hintsText }}>
            {/* One list of keys, in one place: the card says what is staged, the
                hint row says what can be pressed and what the screen is doing. Two
                builders because the chat claims the whole keyboard, so the keys that are
                live in it are a different set rather than a subset (§20.32). */}
            {mode === 'chat'
              ? buildChatHintLine({
                  columns,
                  agent:
                    investigator && chatUnavailable === null ? chatAgent : null,
                  pending: chatPending,
                  exhausted: chatExhausted,
                  rail: chatColumns.rail !== null,
                })
              : buildHintLine({
                  columns,
                  includeResolved,
                  layoutLabel: LAYOUT_LABELS[prefs.layout],
                  themeLabel: WINDBREAK_THEME_LABELS[prefs.theme],
                  chatHint: chatHintLine,
                  codebaseHint: codebaseHintLine,
                })}
          </text>
        </box>
      </box>
    </WindbreakColorsProvider>
  )
}
