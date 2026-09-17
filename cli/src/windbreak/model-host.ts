/**
 * The model transport an in-CLI WindBreak view runs on: **this CLI's own client, and this
 * CLI's own live Freebuff session** (§20.41.5, §20.41.7).
 *
 * ## Why the CLI injects rather than letting WindBreak resolve one
 *
 * Free mode is scoped to the freebuff CLI *as a caller*: a request from anywhere else is
 * refused with `403 free_mode_cli_required` however well-formed it is. What marks a request
 * as the CLI is server-side and unknowable from this repository — the error string does not
 * exist in this tree, and the CLI's own client carries nothing free-mode-specific — so the
 * one cheap experiment available is to hand WindBreak the client this process already runs
 * on, and see whether that changes the answer. The seams for it have existed since §20.41.6
 * (`LaunchScanOptions.modelHost`, and `client` + `sessions` on the review bridge) and until
 * now **nothing passed them**: a scan or a turn started from inside the CLI built a second
 * client of its own from the environment, and made the very kind of request the probe made.
 *
 * ## The two halves, and where each comes from
 *
 * - **The client** is `getCodebuffClient()`'s — the object a chat turn runs on, with this
 *   CLI's project root, agent registry and tool overrides. It is `null` when there is no
 *   login (that function reports and returns rather than throwing), which callers turn into
 *   a sentence instead of an exception.
 * - **The sessions** are read from this process's live session by
 *   `createHostedSessions`. That builder is WindBreak's rather than this module's on purpose:
 *   "reuse the host's session, never take it over, and never fall through to a metered call"
 *   is protocol, it is tested where the rest of the protocol is, and a second copy here would
 *   be the drift §20.41 is written about. What this module answers is only *what this process
 *   holds right now*.
 *
 * A Codebuff (credits) build has no Freebuff session to hand over, so it hands over the
 * metered sessions — said here rather than left to whether a session happens to exist, since
 * the difference between the two is who pays.
 */

import {
  createHostedSessions,
  createMeteredSessions,
} from '@codebuff/windbreak/client'

import { getFreebuffInstanceId } from '../hooks/use-freebuff-session'
import { getSelectedFreebuffModel } from '../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import { getCodebuffClient } from '../utils/codebuff-client'
import { IS_FREEBUFF } from '../utils/constants'
import { holdsLiveFreebuffSlot } from '../utils/freebuff-session-api'

import type { CodebuffClient } from '@codebuff/sdk'
import type {
  HostedFreebuffSession,
  WindbreakModelHost,
} from '@codebuff/windbreak/client'

/**
 * The session this process holds, in the two fields a model call needs.
 *
 * `null` covers every way there is no usable session — no admission, a state that is not a
 * live slot, an instance id the store cannot name — and it is deliberately one answer rather
 * than several: the caller's only responses are to refuse the call or to report the refusal,
 * and a caller that could tell those cases apart would be tempted to guess at one of them.
 *
 * The model is the session's own, except where the local `ended` state carries none. That
 * state is synthesised by `use-freebuff-session.ts` from the fields the post-session banner
 * needs, and a CLI turn inside the grace window sends the selected model — reading the same
 * value here is what keeps a WindBreak call identical to a chat turn rather than merely
 * similar to one.
 */
export const liveCliSession = (): HostedFreebuffSession | null => {
  const session = useFreebuffSessionStore.getState().session
  if (session === null || !holdsLiveFreebuffSlot(session)) return null

  const instanceId = getFreebuffInstanceId()
  if (instanceId === undefined) return null

  const own = 'model' in session ? session.model : undefined
  const model =
    typeof own === 'string' && own.length > 0 ? own : getSelectedFreebuffModel()
  if (model.length === 0) return null

  return { instanceId, model }
}

export interface CreateCliModelHostInput {
  /**
   * The client to hand over. Defaults to `getCodebuffClient()`; `null` is a real input
   * (a test's, or a caller that has already established there is none), which is why this is
   * checked with `!== undefined` rather than for truthiness.
   */
  client?: CodebuffClient | null | undefined
  /** What this process holds. Defaults to `liveCliSession`. */
  live?: (() => HostedFreebuffSession | null) | undefined
  /** Whether this build is Freebuff. Defaults to `IS_FREEBUFF`. */
  freebuff?: boolean | undefined
}

/**
 * The host, or `null` when this CLI has no client to lend.
 *
 * Never throws: the two modules that call it render either way — a scan reports a refusal in
 * its stage table and the queue pane shows a sentence — and both are surfaces where an
 * exception would land inside a render.
 */
export const createCliModelHost = async (
  input: CreateCliModelHostInput = {},
): Promise<WindbreakModelHost | null> => {
  const client = input.client !== undefined ? input.client : await getCodebuffClient()
  if (client === null) return null

  return {
    client,
    sessions:
      (input.freebuff ?? IS_FREEBUFF)
        ? createHostedSessions(input.live ?? liveCliSession)
        : createMeteredSessions(),
  }
}
