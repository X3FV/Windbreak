/**
 * The queue view's investigator: a bridge built over the configured database, or a stated reason
 * why there is not one (§20.29.4, §20.29.6, §20.31).
 *
 * Three things this module owns, and the view owns none of them:
 *
 * 1. **The transport.** This process's own client and live Freebuff session (§20.41.5), through
 *    `createCliModelHost`: `getCodebuffClient` reports a missing login rather than throwing, and
 *    a session is *read* rather than opened. Both absences are *normal* for this surface — the
 *    queue is readable and decidable offline, which is the whole point of §20.37 — so they become
 *    a sentence the pane shows instead of an exception inside a render. Before §20.41's wiring
 *    this module built a WindBreak client of its own from the environment, which is the shape
 *    that made a turn taken in this pane indistinguishable from a direct API call.
 * 2. **The connection.** The bridge gets a **second** connection to the same file rather than the
 *    session's. `openReviewSession`'s session is a queue reader by its own description, and the
 *    bridge writes `investigator_turns` — widening that interface so one object could do both
 *    would make "which reads are the queue's" unanswerable. SQLite in WAL takes two readers and a
 *    writer, which is what the retired screen did for the same reason.
 * 3. **The limits.** §20.29.6's ceiling comes from the config the *subject* already resolved, so a
 *    `maxConversationCalls` written in `.windbreak/config.json` bounds this conversation whichever
 *    way the tool was launched. The retired screen read it only from a `--config` it was handed.
 *
 * What it does **not** do is decide anything. A turn is recorded and rendered; the decision on the
 * row stays `recordAdjudicationDecision` (§5.3), and the invariant `models.ts` states at the type
 * level — the investigator is not a `ModelRole`, so no answer it gives can reach
 * `runVerification`'s disposition — is what keeps the two apart.
 */

import { createReviewInvestigator } from '@codebuff/windbreak/review'
import { openStateDatabase } from '@codebuff/windbreak/state'

import { createCliModelHost } from './model-host'

import type { CreateReviewInvestigatorOptions } from '@codebuff/windbreak/review'

import type { CodebuffClient } from '@codebuff/sdk'
import type {
  FreebuffSessions,
  WindbreakModelHost,
} from '@codebuff/windbreak/client'
import type { ReviewInvestigator } from '@codebuff/windbreak/review'

/**
 * The subject's two ceilings, under the engine's own names for them.
 *
 * A mapping function with a **declared return type** rather than two properties spread into the
 * call, and that is the whole point of it existing. Spreading `{ maxSteps }` into an options
 * object escaped the excess-property check — the engine's option is `maxAgentSteps` — so the
 * configured per-turn step ceiling was accepted, ignored, and never reached the agent, which
 * then ran on its own default of sixteen. Nothing failed: the pane worked, the ceiling that
 * *was* wired (`maxConversationCalls`) still bound the spend, and the only symptom was a limit
 * the researcher had written down not applying. Typing the return as
 * `Pick<CreateReviewInvestigatorOptions, …>` makes a rename in the engine a compile error here
 * instead of a silent default, and the test beside this module pins the key names for the case
 * where the engine adds an alias next to the old one.
 */
export const investigatorLimitOptions = (limits: {
  maxConversationCalls: number
  maxSteps: number
}): Pick<CreateReviewInvestigatorOptions, 'maxConversationCalls' | 'maxAgentSteps'> => ({
  maxConversationCalls: limits.maxConversationCalls,
  maxAgentSteps: limits.maxSteps,
})

/** `maxSteps` is required, not optional, and that is part of the same guard. */

export interface QueueInvestigator {
  /** Null when the investigator is usable; the reason, in the pane's words, when it is not. */
  unavailableReason: string | null
  /**
   * The bridge. Present even when `unavailableReason` is set — the reason is a state of the
   * conversation, not a missing object, and `ask` answers with it as the turn's `error` rather
   * than throwing. One path in the pane, not two.
   */
  investigator: ReviewInvestigator
  /** Closes the bridge's own connection. */
  close: () => void
}

export interface CreateQueueInvestigatorInput {
  /** The queue's database. A missing file is read as `:memory:`, as the session reads it. */
  dbPath: string
  /** The checkout a turn reads when the database has no run to resolve a target (§20.31). */
  repoRoot: string
  /** §20.29.6's ceiling, as `resolveScanSubject` resolved it. */
  maxConversationCalls: number
  /**
   * Agent steps allowed in one turn, as the config resolved them.
   *
   * **Required**, and that is deliberate: it is the one input with no safe default this side
   * of the engine, and both callers already have the resolved value in hand (`resolveScanSubject`
   * returns `investigator.maxSteps`). Named `maxSteps` because that is the config's own key;
   * `investigatorLimitOptions` is what maps it to the engine's `maxAgentSteps`, and why that
   * mapping is a typed function rather than a spread is in its docstring — for one release the
   * difference between the two names cost this setting its effect entirely.
   */
  maxSteps: number
  /**
   * The model client. Injected so the whole feature is testable without credentials, and so a
   * caller that already holds one does not pay for a second.
   */
  client?: CodebuffClient | null | undefined
  /**
   * The Freebuff sessions a turn is billed to (§20.41). Injected alongside `client`,
   * for the same reason: a caller that already holds a client holds its sessions too.
   * A client without sessions is a denied turn, not a billed one.
   */
  sessions?: FreebuffSessions | null | undefined
  /** Injected alongside `client`, for the same reason: tests name their own reason. */
  clientUnavailableReason?: string | undefined
  /**
   * How the transport is resolved when neither `client` nor `sessions` was injected: this
   * CLI's own client and live Freebuff session by default (§20.41.5).
   *
   * A function rather than a value because resolution is async and may legitimately produce
   * nothing — and injectable because the default reads this process's login and session, which
   * is exactly what a test about the pane should not touch.
   */
  hostResolver?: (() => Promise<WindbreakModelHost | null>) | undefined
  log?: ((line: string) => void) | undefined
}

/**
 * Build the bridge, or say why it cannot exist.
 *
 * Never throws. The two ways this can fail — no credentials, an unusable database — are both
 * reported as `unavailableReason`, because the pane has to render *something* and "the
 * investigator is not available" is a different statement from "the investigator found nothing"
 * (§18 applied to a pane's own chrome).
 */
export const createQueueInvestigator = async (
  input: CreateQueueInvestigatorInput,
): Promise<QueueInvestigator> => {
  const db = openStateDatabase(input.dbPath)

  // The connection is the bridge's own and is closed with it. The **session is not**: the host
  // this bridge was handed owns it, and releasing it would end the chat the pane was opened in
  // (§20.41.3's rule, which is why an injected host carries no `close` to call).
  const close = (): void => {
    db.close()
  }

  let client = input.client ?? null
  let sessions: FreebuffSessions | null = input.sessions ?? null
  let clientUnavailableReason = input.clientUnavailableReason

  if (input.client === undefined) {
    const host = await (input.hostResolver ?? createCliModelHost)()
    if (host === null) {
      client = null
      clientUnavailableReason =
        'this CLI has no model credentials, so the investigator cannot run. ' +
        'The queue still works: deciding a disagreement needs no model.'
    } else {
      client = host.client
      sessions = host.sessions
    }
  }

  const investigator = createReviewInvestigator({
    db,
    client,
    sessions,
    ...investigatorLimitOptions({
      maxConversationCalls: input.maxConversationCalls,
      maxSteps: input.maxSteps,
    }),
    // Offered, and only reached when no run resolves a target: with a scan the run's own
    // target wins, so this cannot quietly redirect an investigation away from the evidence
    // the row it was opened for cites.
    fallbackTargetRoot: input.repoRoot,
    ...(clientUnavailableReason === undefined ? {} : { clientUnavailableReason }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })

  return { unavailableReason: investigator.unavailableReason, investigator, close }
}
