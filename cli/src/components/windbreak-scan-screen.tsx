import { launchScan } from '@codebuff/windbreak/scan'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createCliModelHost } from '../windbreak/model-host'
import { resolveScanSubject } from '../windbreak/subject'
import { WindbreakScanView } from './windbreak-scan-view'

import type { WindbreakModelHost } from '@codebuff/windbreak/client'
import type { LaunchScanOutcome, ScanResult } from '@codebuff/windbreak/scan'
import type { WindbreakScanState } from './windbreak-scan-view'

/**
 * The scan view's own run: what `launchScan` is called with, and what it hands back.
 *
 * A parameter rather than an import at the call site so the container can be tested against a
 * launcher that fails, or that takes a minute it does not have — the repo's rule is dependency
 * injection over module mocking, and a scan is the most expensive thing in the tool to fake
 * with a mock.
 */
export type ScanRunner = (input: {
  dbPath: string
  targetRoot: string
  configPath?: string
  runId?: string
  /**
   * The transport the run makes its model calls on: this CLI's own client and live Freebuff
   * session, or `null` when this CLI has none to lend (§20.41.5).
   *
   * Part of the runner's input rather than something `launchScan` resolves for itself, because
   * the whole experiment is *which* caller a call is made by: free mode answers only the
   * freebuff CLI, and a scan that built its own client from the environment would make the
   * same kind of request the probe did, from inside the same binary. Stating it here also
   * makes the wiring assertable — a test's runner sees exactly the host the view resolved.
   *
   * `null` is not "metered": it is "no host", and the launcher then resolves one from the
   * environment as it always has and reports the credentials failure in its own stage table.
   */
  modelHost: WindbreakModelHost | null
  log: (line: string) => void
}) => Promise<LaunchScanOutcome>

const defaultRunner: ScanRunner = (input) =>
  launchScan({
    dbPath: input.dbPath,
    targetRoot: input.targetRoot,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.modelHost === null ? {} : { modelHost: input.modelHost }),
    log: input.log,
  })

/**
 * How many of the run's own lines are kept for the screen.
 *
 * The log is progress chatter and the durable record is the summary — `ScanResult` carries the
 * stages, the counts and every warning — but the window is not the only reader: this array is
 * re-wrapped on each render, so a run that printed ten thousand lines would make the screen
 * slower than the scan. What is dropped is **counted and shown** rather than silently
 * forgotten, which is §18 applied to a scrollback: a shorter log must not read as a quieter
 * run.
 */
const MAX_LOG_LINES = 2000

/** How often buffered log lines reach the screen. A render per line would gate the scan. */
const FLUSH_INTERVAL_MS = 100

export interface WindbreakScanScreenProps {
  /** The checkout the session is about — what the scan will read. */
  repoRoot: string
  /**
   * Leaving the view. Given the one line the transcript should keep, or null when there is
   * nothing worth saying.
   */
  onClose: (summary: string | null) => void
  runner?: ScanRunner
  /**
   * How this view gets the transport its scan runs on (§20.41.5).
   *
   * `createCliModelHost` by default — this CLI's own client and live Freebuff session.
   * Injectable because the wiring is the claim: the default reaches for credentials, which is
   * exactly what a test about the view's own behaviour should not do, and a test about the
   * wiring wants a host it controls.
   */
  hostResolver?: () => Promise<WindbreakModelHost | null>
}

/**
 * The closing line the chat keeps.
 *
 * §20.33's rule is that a finished scan keeps its summary; this is that rule at the resolution
 * a transcript has room for — the run's identity, its status, and the queue it produced. The
 * numbers are the ones a researcher acts on: a non-zero `escalated` is work in the queue, and
 * naming `review --run` is what turns that into a next step rather than a statistic.
 */
const closingLine = (
  state: WindbreakScanState,
  repoRoot: string,
): string | null => {
  if (state.phase === 'running') {
    return (
      'WindBreak: the scan view was left while a scan was running — the run carries on in ' +
      "this process, but its log is not kept here. Whatever it records is in the database."
    )
  }

  if (state.phase === 'refused') {
    return `WindBreak: no scan was started — ${state.reason}`
  }

  const { result } = state
  const parts = [
    `WindBreak scan ${result.runId}: ${result.status}`,
    `${result.counts.candidates} candidate(s)`,
    `${result.counts.escalated} escalated`,
  ]
  if (result.providerFailure) parts.push('BLOCKED by a provider refusal')
  if (result.counts.escalated > 0) {
    parts.push(`windbreak review --run ${result.runId} --target ${repoRoot}`)
  } else if (result.resumeFrom) {
    parts.push(`windbreak resume --run ${result.runId} --target ${repoRoot}`)
  }

  return parts.join(' · ')
}

export const WindbreakScanScreen: React.FC<WindbreakScanScreenProps> = ({
  repoRoot,
  onClose,
  runner = defaultRunner,
  hostResolver = createCliModelHost,
}) => {
  const resolution = useMemo(() => resolveScanSubject({ repoRoot }), [repoRoot])

  const [refusal, setRefusal] = useState<string | null>(
    resolution.ok ? null : resolution.reason,
  )
  const [lines, setLines] = useState<readonly string[]>([])
  const [droppedLines, setDroppedLines] = useState(0)
  const [result, setResult] = useState<ScanResult | null>(null)
  /**
   * Which run this screen is driving: the checkout's next one, then a continuation of it.
   *
   * A token rather than just the run id, because a run continued twice is the *same* run — a
   * dependency that only carried the id would make the second `r` a silent no-op.
   */
  const [start, setStart] = useState<{ runId: string | undefined; token: number }>({
    runId: undefined,
    token: 0,
  })

  const buffer = useRef<string[]>([])
  const dropped = useRef(0)
  const live = useRef(true)
  const started = useRef(0)

  // One scan per start, and a resume is a second start — not a second effect. The token is
  // what keeps an earlier run's late lines out of a later run's log.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!resolution.ok) return

    const token = ++started.current
    const subject = resolution.subject
    buffer.current = []
    dropped.current = 0
    setLines([])
    setDroppedLines(0)
    setResult(null)

    const flush = (): void => {
      if (!live.current || token !== started.current) return
      if (buffer.current.length === 0) return
      const incoming = buffer.current
      buffer.current = []
      setLines((prev) => {
        const merged = [...prev, ...incoming]
        const overflow = Math.max(0, merged.length - MAX_LOG_LINES)
        if (overflow > 0) {
          dropped.current += overflow
          setDroppedLines(dropped.current)
          return merged.slice(overflow)
        }
        return merged
      })
    }

    const interval = setInterval(flush, FLUSH_INTERVAL_MS)

    void (async () => {
      // Resolved before the run rather than inside it: which caller the scan runs as is part
      // of what the run *is*, and a scan that resolved its own transport would be the case
      // §20.41.5's experiment is trying to tell apart from this one.
      const modelHost = await hostResolver()

      const outcome = await runner({
        dbPath: subject.dbPath,
        targetRoot: subject.targetRoot,
        ...(subject.configPath === null ? {} : { configPath: subject.configPath }),
        ...(start.runId === undefined ? {} : { runId: start.runId }),
        modelHost,
        log: (line) => {
          buffer.current.push(line)
        },
      })

      clearInterval(interval)
      flush()

      if (!live.current || token !== started.current) return
      if (outcome.ok) setResult(outcome.result)
      else setRefusal(outcome.reason)
    })()

    return () => {
      clearInterval(interval)
    }
  }, [hostResolver, resolution, runner, start])

  const state: WindbreakScanState = useMemo(() => {
    if (refusal !== null) return { phase: 'refused', reason: refusal }
    if (result !== null) return { phase: 'done', result }
    return { phase: 'running', lines, droppedLines }
  }, [refusal, result, lines, droppedLines])

  const handleClose = useCallback(() => {
    onClose(closingLine(state, repoRoot))
  }, [onClose, state, repoRoot])

  const handleResume = useCallback(() => {
    if (state.phase !== 'done' || state.result.resumeFrom === null) return
    setRefusal(null)
    // `launchScan` reads the target back from the run's own record rather than from the
    // working directory, so a continuation cannot attach itself to a different checkout.
    setStart((prev) => ({ runId: state.result.runId, token: prev.token + 1 }))
  }, [state])

  return (
    <WindbreakScanView
      repoRoot={repoRoot}
      subject={resolution.ok ? resolution.subject : null}
      state={state}
      onClose={handleClose}
      onResume={handleResume}
    />
  )
}
