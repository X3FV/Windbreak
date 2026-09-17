import { openReviewSession } from '@codebuff/windbreak/review'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createQueueInvestigator } from '../windbreak/investigator'
import { parseQueueChatInput } from '../windbreak/queue-chat-content'
import { queueClosingLine } from '../windbreak/queue-content'
import { resolveScanSubject } from '../windbreak/subject'
import { WindbreakQueueView } from './windbreak-queue-view'

import type {
  OpenReviewSessionResult,
  ProviderFailure,
  ReviewCounts,
  ReviewDecision,
  ReviewEntryDetail,
  ReviewEntrySummary,
  ReviewSession,
} from '@codebuff/windbreak/review'
import type { QueueInvestigator } from '../windbreak/investigator'
import type { QueueChatTurn } from '../windbreak/queue-chat-content'
import type {
  WindbreakQueueNotice,
  WindbreakQueueState,
} from './windbreak-queue-view'

/**
 * The queue view's own session: what it is opened with, and the seam a test replaces.
 *
 * A parameter rather than an import at the call site, the same rule the scan screen follows. A
 * queue has no expensive resource to fake, but the *database* is the interesting part of every one
 * of these tests — a schema-version mismatch, a missing file, and a row that was already decided
 * are the cases that matter — so the injectable seam is a real `openReviewSession` against a
 * fixture more often than it is a stub.
 */
export type QueueOpener = (input: {
  dbPath: string
  repoRoot: string
}) => OpenReviewSessionResult

const defaultOpener: QueueOpener = ({ dbPath, repoRoot }) =>
  openReviewSession({ dbPath, repoRoot })

/**
 * How the investigator bridge is built, as a seam.
 *
 * The default reaches for credentials and opens a second connection to the database, which is
 * exactly why it is injectable: a test about the pane's behaviour should need neither, and a test
 * about the recording wants a client it controls.
 */
export type QueueInvestigatorFactory = (input: {
  dbPath: string
  repoRoot: string
  maxConversationCalls: number
  maxSteps: number
}) => Promise<QueueInvestigator>

const defaultInvestigatorFactory: QueueInvestigatorFactory = (input) =>
  createQueueInvestigator(input)

const EMPTY_COUNTS: ReviewCounts = { total: 0, pending: 0, resolved: 0 }

export interface WindbreakQueueScreenProps {
  /** The checkout the session is about; also the fallback target a turn may read. */
  repoRoot: string
  /** Leaving the view. Given the one line the transcript should keep. */
  onClose: (summary: string | null) => void
  opener?: QueueOpener
  investigatorFactory?: QueueInvestigatorFactory
}

/** Everything the view draws, read from the session in one place. */
interface QueueRead {
  counts: ReviewCounts
  entries: readonly ReviewEntrySummary[]
  selectedIndex: number
  detail: ReviewEntryDetail | null
}

const read = (
  session: ReviewSession,
  index: number,
  includeResolved: boolean,
): QueueRead => {
  const entries = session.list({ includeResolved })
  const selectedIndex = Math.max(0, Math.min(index, entries.length - 1))
  return {
    counts: session.counts(),
    entries,
    selectedIndex,
    detail: entries.length === 0 ? null : session.detail(entries[selectedIndex]!.candidateId),
  }
}

/**
 * Which database the queue comes from.
 *
 * The same resolution a scan uses (`windbreak/subject.ts`), and deliberately the *same* one rather
 * than a second reading of "where is state": a view that read `<repo>/.windbreak/state.db` while
 * `windbreak scan` wrote to a configured path would show an empty queue to the researcher who
 * configured it — §18's substitution, arriving through the one door a screen cannot label
 * afterwards.
 *
 * A configuration that cannot be read is a **refusal**, not a fallback. The conventional path is
 * also the default, so falling back would be indistinguishable from success: an unreadable config
 * naming a database elsewhere would open the wrong one, and the empty queue in it would look like
 * an answer.
 */
export const WindbreakQueueScreen: React.FC<WindbreakQueueScreenProps> = ({
  repoRoot,
  onClose,
  opener = defaultOpener,
  investigatorFactory = defaultInvestigatorFactory,
}) => {
  const resolution = useMemo(() => resolveScanSubject({ repoRoot }), [repoRoot])

  /**
   * The session, opened once during the first render and closed on unmount.
   *
   * Opened there rather than in an effect because `openReviewSession` is synchronous: a phase that
   * existed only to say "opening" would be a frame nobody can read. A refusal is a *value*, which
   * is why a screen can hold one as state instead of throwing inside a render.
   */
  const opened = useMemo<OpenReviewSessionResult>(() => {
    if (!resolution.ok) return { ok: false, reason: resolution.reason }
    return opener({ dbPath: resolution.subject.dbPath, repoRoot: resolution.subject.targetRoot })
  }, [opener, resolution])

  const session: ReviewSession | null = opened.ok ? opened.session : null
  const refused = opened.ok ? null : opened.reason

  const [includeResolved, setIncludeResolved] = useState(false)
  const [suite, setSuite] = useState<QueueRead>({
    counts: EMPTY_COUNTS,
    entries: [],
    selectedIndex: 0,
    detail: null,
  })
  const [decided, setDecided] = useState<readonly ReviewDecision[]>([])
  const [notice, setNotice] = useState<WindbreakQueueNotice | null>(null)

  const [chatOpen, setChatOpen] = useState(false)
  const [turns, setTurns] = useState<readonly QueueChatTurn[]>([])
  const [pending, setPending] = useState(false)
  const [bridge, setBridge] = useState<QueueInvestigator | null>(null)
  const build = useRef<Promise<QueueInvestigator> | null>(null)
  const controller = useRef<AbortController | null>(null)

  /**
   * One read per interaction, not one per render.
   *
   * `list` and `counts` are SQL, and the container re-renders whenever the chat above it does —
   * so a read in the render body would query the queue on keystrokes that have nothing to do with
   * it. The cursor is reset to the top by a toggle, which is the only list change the reader did
   * not make by moving the cursor.
   */
  useEffect(() => {
    if (session === null) return
    setSuite(read(session, 0, includeResolved))
  }, [session, includeResolved])

  /**
   * The investigator bridge, built on the first `c` rather than on mount.
   *
   * It resolves credentials and opens a second connection to the database, and a researcher who
   * only reads the queue and decides should pay for neither. `build` holds the promise so two
   * keystrokes cannot construct two bridges — and therefore two conversations with two ceilings.
   */
  const ensureBridge = useCallback(async (): Promise<QueueInvestigator | null> => {
    if (!resolution.ok) return null

    if (build.current === null) {
      build.current = investigatorFactory({
        dbPath: resolution.subject.dbPath,
        repoRoot: resolution.subject.targetRoot,
        maxConversationCalls: resolution.subject.investigator.maxConversationCalls,
        maxSteps: resolution.subject.investigator.maxSteps,
      })
    }

    try {
      const built = await build.current
      setBridge(built)
      return built
    } catch (error) {
      // A throw here would be a pane that never renders; the bridge's own contract is that it
      // reports unavailability rather than raising, so this is the backstop for a caller's factory.
      build.current = null
      setBridge(null)
      throw error
    }
  }, [investigatorFactory, resolution])

  useEffect(
    () => () => {
      controller.current?.abort()
      if (build.current !== null) {
        build.current.then(
          (built) => built.close(),
          () => undefined,
        )
      }
    },
    [],
  )

  useEffect(
    () => () => {
      if (opened.ok) opened.session.close()
    },
    [opened],
  )

  const handleSelect = useCallback(
    (delta: number) => {
      if (session === null) return
      setSuite((current) => read(session, current.selectedIndex + delta, includeResolved))
    },
    [includeResolved, session],
  )

  const handleToggleResolved = useCallback(() => {
    setNotice(null)
    setIncludeResolved((previous) => !previous)
  }, [])

  const handleDecide = useCallback(
    (input: { candidateId: string; decision: ReviewDecision; rationale: string }) => {
      if (session === null) return

      // §5.3's state transition, through the pipeline's own function: this view writes no SQL and
      // does not know the queue's columns. That is what keeps one implementation of "resolved" —
      // the batch `--decide` and this keystroke reach the same code.
      const outcome = session.decide({
        candidateId: input.candidateId,
        decision: input.decision,
        rationale: input.rationale.length === 0 ? null : input.rationale,
      })

      setDecided((previous) => [...previous, input.decision])
      setNotice({
        candidateId: input.candidateId,
        decision: input.decision,
        previous: outcome.previous,
      })

      setSuite((current) => {
        // A decided row leaves a pending-only list, so the cursor stays *where it is* and the next
        // candidate takes its place: the queue is worked, and moving the cursor too would skip one.
        // When decided rows are shown the row stays put, so the cursor follows the candidate
        // instead — a reader should be able to see what their keystroke recorded.
        const index = current.selectedIndex
        const anchor = includeResolved
          ? current.entries.findIndex((entry) => entry.candidateId === input.candidateId)
          : index
        return read(session, anchor === -1 ? index : anchor, includeResolved)
      })
    },
    [includeResolved, session],
  )

  const handleOpenChat = useCallback(() => {
    setChatOpen(true)
    if (bridge === null) void ensureBridge()
  }, [bridge, ensureBridge])

  const handleCloseChat = useCallback(() => {
    setChatOpen(false)
  }, [])

  const handleCancelTurn = useCallback(() => {
    // The engine turns this into a recorded `cancelled` turn rather than a failure: a turn the
    // researcher stopped is not a turn that broke (§20.29.5).
    controller.current?.abort()
  }, [])

  /** The mode the next line runs in when it does not say `/hunt`: the selection decides. */
  const selected = suite.entries[suite.selectedIndex] ?? null
  const nextMode = selected === null ? 'hunt' : 'explain'

  const handleAsk = useCallback(
    (text: string) => {
      if (session === null || pending) return
      const parsed = parseQueueChatInput(text, nextMode)
      if (parsed === null) return

      const candidateId = parsed.mode === 'hunt' ? null : (selected?.candidateId ?? null)
      const runId = selected?.runId ?? null

      setPending(true)
      const abort = new AbortController()
      controller.current = abort

      void (async () => {
        const built = bridge ?? (await ensureBridge())
        if (built === null) {
          setPending(false)
          return
        }

        // The bridge resolves the target from the run, records the turn in `investigator_turns`
        // before it returns, charges the conversation ceiling, and answers with the account
        // refusal when the call was refused. This container decides none of that; it places the
        // turn and reads the bridge's session state.
        const turn = await built.investigator.ask({
          runId,
          candidateId,
          mode: parsed.mode,
          prompt: parsed.prompt,
          signal: abort.signal,
        })

        // `pending: false` because this turn is finished by construction: the pane draws the
        // running one separately, so a returned turn is never the one in flight.
        setTurns((previous) => [
          ...previous,
          { ...turn, mode: parsed.mode, prompt: parsed.prompt, pending: false },
        ])
        setPending(false)
      })()
    },
    [bridge, ensureBridge, nextMode, pending, selected, session],
  )

  const refusal: ProviderFailure | null = bridge?.investigator.refusal ?? null
  const budget = turns.at(-1)?.budget ?? bridge?.investigator.budget() ?? null

  const state: WindbreakQueueState =
    session === null
      ? {
          phase: 'refused',
          reason: refused ?? 'the queue for this repository could not be opened',
          // Named whenever the configuration resolved, because the usual refusal is about a file
          // — a schema version that does not match — and a message that does not say which file
          // leaves the reader unable to act on it.
          dbPath: resolution.ok ? resolution.subject.dbPath : null,
        }
      : {
          phase: 'open',
          source: session.source,
          counts: suite.counts,
          entries: suite.entries,
          detail: suite.detail,
          selectedIndex: suite.selectedIndex,
          includeResolved,
          notice,
          chat: {
            open: chatOpen,
            starting: bridge === null,
            unavailableReason: bridge?.unavailableReason ?? null,
            turns,
            pending,
            budget,
            refusal,
            mode: nextMode,
          },
        }

  const dbPathForSummary = resolution.ok ? resolution.subject.dbPath : null

  const handleClose = useCallback(() => {
    onClose(
      queueClosingLine({
        // The configuration's own failure is what the header showed, so it is what the transcript
        // keeps: a line that said "0 pending" here would be the substitution §18 forbids.
        refusal:
          refused === null
            ? null
            : `${refused}${dbPathForSummary === null ? '' : ` (${dbPathForSummary})`}`,
        source: session?.source ?? null,
        counts: session === null ? null : suite.counts,
        decided,
        questions: turns.length,
      }),
    )
  }, [dbPathForSummary, decided, onClose, refused, session, suite.counts, turns.length])

  return (
    <WindbreakQueueView
      repoRoot={repoRoot}
      state={state}
      onClose={handleClose}
      onSelect={handleSelect}
      onToggleResolved={handleToggleResolved}
      onDecide={handleDecide}
      onChat={{
        open: handleOpenChat,
        close: handleCloseChat,
        ask: handleAsk,
        cancel: handleCancelTurn,
      }}
    />
  )
}
