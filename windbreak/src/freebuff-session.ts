import fs from 'fs'
import path from 'path'

import { getConfigDir } from './auth'

/**
 * The Freebuff free session, without which every model call is metered (spec §20.41).
 *
 * **The defect this module exists to fix.** Windbreak routed every model call through
 * `@codebuff/sdk` with nothing but an API key, so the backend read the request as an
 * ordinary metered Codebuff call. The token windbreak resolves comes from
 * `~/.config/manicode/credentials.json`, which is the **Freebuff login token** — the
 * account was a Freebuff account all along, and windbreak was sending its key without
 * the session that makes calls free. The result was HTTP 402 `Out of credits` on a
 * command whose own model table says those models are unmetered.
 *
 * Two fields carry the difference, both documented by the SDK (`RunOptions`):
 *
 * - `costMode: 'free'` — `run.ts` defaults the absent value to `'normal'`.
 * - `extraCodebuffMetadata.freebuff_instance_id` — "client-scoped identifiers like
 *   `freebuff_instance_id` that server-side gates read from the request body".
 *
 * The instance id is the whole point: it names the session the call is billed to, and
 * there is no free call without one. This module obtains it.
 *
 * ## A session is bound to exactly one model
 *
 * `POST`ing a second model while a session is live returns `model_locked` (and a
 * mismatched model on a live instance returns `session_model_mismatch`, which *ends* the
 * session). So this module keeps one lease per model rather than one per process, and
 * Windbreak's two-vendor configuration — §5.2's cross-vendor gate needs a different
 * vendor for the refuter than the proposer — therefore runs on two sessions, not one.
 * That is the free tier's own shape: `rateLimitsByModel` is keyed per model because each
 * model has its own daily allotment.
 *
 * ## Reusing a slot rather than taking one
 *
 * Freebuff grants one live session per account, and the CLI may be holding it for a chat
 * the operator is in the middle of. §20.41's decision is **reuse, never take over**: if a
 * local process holds a live slot whose model matches, this module adopts that instance
 * and never releases it; if the held slot is for a *different* model, it refuses with the
 * holder's model named, because ending someone's chat to start a scan is not a trade a
 * scanner gets to make. Only sessions this module admitted are released.
 *
 * ## The constants are reimplemented, not imported
 *
 * They live in `@codebuff/common/constants/freebuff-models`, and `common` is a
 * *transitive* dependency of this package — see `investigate/tools.ts`'s note on why a
 * type-only import of an undeclared package is not taken. So the wire strings are
 * repeated here with their source named, the same call `auth.ts` makes for
 * `API_KEY_ENV_VAR` and the config directory.
 */

/** `@codebuff/common/constants/freebuff-models` -> `FREEBUFF_INSTANCE_HEADER`. */
export const INSTANCE_HEADER = 'x-freebuff-instance-id'
/** `@codebuff/common/constants/freebuff-models` -> `FREEBUFF_MODEL_HEADER`. */
export const MODEL_HEADER = 'x-freebuff-model'
/** `@codebuff/common/constants/freebuff-models` -> `FREEBUFF_WALLET_SPEND_LIMIT_HEADER`.
 *  `0` is what the CLI sends: spend nothing on a session windbreak starts. */
export const WALLET_SPEND_LIMIT_HEADER = 'x-freebuff-wallet-spend-limit'
/** `@codebuff/common/constants/freebuff-models` -> `FREEBUFF_SESSION_ADMISSION_PATH`. */
export const ADMISSION_PATH = '/api/v1/freebuff/session/admission'
/** `@codebuff/common/constants/freebuff-models` -> the shared `/api/v1/freebuff/session`
 *  endpoint (GET to read, DELETE to release). */
export const SESSION_PATH = '/api/v1/freebuff/session'
/** `@codebuff/common/constants/free-agents` -> `FREE_COST_MODE`. Absent, the SDK sends
 *  `'normal'` and the provider bills an account that has no credits. */
export const FREE_COST_MODE = 'free'
/** `cli/src/utils/freebuff-instance-owner.ts` -> `OWNER_FILE`. Written by the CLI when
 *  it admits a session, so a non-CLI process can discover the live slot. */
const OWNER_FILE = 'freebuff-instance-owner.json'

const SESSION_FETCH_TIMEOUT_MS = 20_000

/** Where the API lives. `client-env.ts` has already defaulted this for a CLI run; the
 *  fallback is for a library consumer and matches the CLI's own (`freebuff-session-api`). */
const apiBaseUrl = (env: NodeJS.ProcessEnv): string =>
  (env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://codebuff.com').replace(/\/$/, '')

export interface FreebuffSessionLease {
  instanceId: string
  model: string
  /** True when this is a session another process already held. Never released by us. */
  reused: boolean
  accessTier?: string
}

/**
 * A session could not be obtained, with the reason said in the operator's terms.
 *
 * Distinct from `ProviderFailure` (`provider-failure.ts`): that classifies a *model call*
 * the provider refused, and this is the refusal that happens before any model call is
 * attempted. A scan that meets this one made no request at all.
 */
export class FreebuffSessionError extends Error {
  constructor(
    readonly kind: FreebuffSessionFailureKind,
    message: string,
  ) {
    super(message)
    this.name = 'FreebuffSessionError'
  }
}

export type FreebuffSessionFailureKind =
  /** Another process holds the slot for a different model. We never take it. */
  | 'model_locked'
  /** The account already holds a slot whose model we cannot identify. */
  | 'slot_held'
  | 'model_unavailable'
  | 'country_blocked'
  | 'banned'
  | 'rate_limited'
  | 'spend_limited'
  | 'ip_capped'
  | 'capacity'
  /** The server predates the admission routes and fails closed. */
  | 'unsupported'
  | 'http'

/** The subset of the session response this module reads. Loose on purpose: the server
 *  owns the full union, and an unknown status must not be read as success. */
interface SessionResponse {
  status?: string
  instanceId?: string
  model?: string
  accessTier?: string
  message?: string
  currentModel?: string
  requestedModel?: string
  countryCode?: string
}

const isLive = (response: SessionResponse): boolean =>
  (response.status === 'active' || response.status === 'ended') &&
  typeof response.instanceId === 'string' &&
  response.instanceId.length > 0

/** What the holder's model is, when the response names one. */
const heldModel = (response: SessionResponse): string | undefined =>
  typeof response.model === 'string'
    ? response.model
    : typeof response.currentModel === 'string'
      ? response.currentModel
      : undefined

const refusalFor = (response: SessionResponse, requestedModel: string): FreebuffSessionError => {
  const said = typeof response.message === 'string' ? ` ${response.message}` : ''
  const current = heldModel(response)

  switch (response.status) {
    case 'model_locked':
      return new FreebuffSessionError(
        'model_locked',
        `the account already holds a Freebuff session for ` +
          `\`${current ?? 'another model'}\`, and a session is bound to one model. ` +
          `Windbreak will not end it — that is the session your own \`freebuff\` chat is ` +
          `using. End it there (or wait for it to expire) and retry.${said}`,
      )
    case 'model_unavailable':
      return new FreebuffSessionError(
        'model_unavailable',
        `the Freebuff free tier is not offering \`${requestedModel}\` right now.${said}`,
      )
    case 'country_blocked':
      return new FreebuffSessionError(
        'country_blocked',
        `Freebuff free mode is not available from this location ` +
          `(${response.countryCode ?? 'unknown'}).${said}`,
      )
    case 'banned':
      return new FreebuffSessionError('banned', `the account cannot start a session.${said}`)
    case 'rate_limited':
      return new FreebuffSessionError('rate_limited', `the session rate limit was reached.${said}`)
    case 'spend_limited':
      return new FreebuffSessionError(
        'spend_limited',
        `today's Freebuff provider-spend ceiling was reached.${said}`,
      )
    case 'ip_capped':
      return new FreebuffSessionError('ip_capped', `this network reached its session cap.${said}`)
    case 'premium_slot_taken':
    case 'capacity':
      return new FreebuffSessionError(
        'capacity',
        `every session slot the account is entitled to is occupied.${said}`,
      )
    default:
      return new FreebuffSessionError(
        'http',
        `the session endpoint answered \`${response.status ?? 'unknown'}\`.${said}`,
      )
  }
}

export interface FreebuffSessionOptions {
  token: string
  env?: NodeJS.ProcessEnv
  /** Injected so the suite drives the protocol without a network. */
  fetch?: typeof globalThis.fetch
  /** Read the local owner file to find a slot another process holds. Off in tests that
   *  are about admission only. */
  reuseLocalSlot?: boolean
}

/**
 * The instance id a local process currently holds, if any.
 *
 * The CLI writes `{instanceId, pid}` when it admits and treats a dead pid as a
 * superseded instance. This reads the same file for the same reason, and checks liveness
 * the same way — a stale file from a killed `freebuff` must not make windbreak think a
 * slot is held, or it would refuse to admit one it is entitled to.
 */
export const readLocalInstanceId = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const ownerPath = path.join(getConfigDir(env), OWNER_FILE)

  let parsed: { instanceId?: unknown; pid?: unknown }
  try {
    parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as {
      instanceId?: unknown
      pid?: unknown
    }
  } catch {
    return undefined
  }

  const { instanceId, pid } = parsed
  if (typeof instanceId !== 'string' || instanceId.length === 0) return undefined
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined

  try {
    process.kill(pid, 0)
  } catch (error) {
    // EPERM means the process exists and belongs to another user.
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return undefined
  }

  return instanceId
}

const requestBody = (response: Response): Promise<SessionResponse> =>
  response.json().catch(() => ({})) as Promise<SessionResponse>

/**
 * Obtain the session a model call must name, reusing a live slot when one matches.
 *
 * The order is the decision (§20.41): a live local slot for this model is adopted; a live
 * local slot for another model is a refusal; only an account holding nothing gets a new
 * admission. The `model` argument is what the caller is about to send, so the returned
 * lease's model always matches the request that will carry its instance id.
 */
export const openFreebuffSession = async (
  options: FreebuffSessionOptions & { model: string },
): Promise<FreebuffSessionLease> => {
  const env = options.env ?? process.env
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = apiBaseUrl(env)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.token}`,
    [MODEL_HEADER]: options.model,
  }

  const call = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> =>
    doFetch(url, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS),
    })

  if (options.reuseLocalSlot !== false) {
    const heldInstance = readLocalInstanceId(env)
    if (heldInstance) {
      let held: SessionResponse
      try {
        const response = await call(`${base}${SESSION_PATH}`, {
          method: 'GET',
          headers: { [INSTANCE_HEADER]: heldInstance },
        })
        held = await requestBody(response)
      } catch {
        // An unreachable session endpoint is not a held slot; fall through and let the
        // admission attempt produce the real diagnosis.
        held = {}
      }

      if (isLive(held) && held.instanceId === heldInstance) {
        const model = heldModel(held)
        if (model === options.model) {
          return {
            instanceId: heldInstance,
            model,
            reused: true,
            ...(held.accessTier ? { accessTier: held.accessTier } : {}),
          }
        }
        throw new FreebuffSessionError(
          'slot_held',
          `another process holds Freebuff session \`${heldInstance}\`` +
            `${model ? ` for \`${model}\`` : ''}, and a session is bound to one model. ` +
            `Windbreak will not take it over. End that session, or wait for it to expire, ` +
            `then retry.`,
        )
      }
    }
  }

  let response: Response
  try {
    response = await call(`${base}${ADMISSION_PATH}`, {
      method: 'POST',
      headers: { [WALLET_SPEND_LIMIT_HEADER]: '0' },
    })
  } catch (error) {
    throw new FreebuffSessionError(
      'http',
      `could not reach the Freebuff session endpoint at ${base}${ADMISSION_PATH}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // A server predating the admission route fails closed rather than admitting nothing: a
  // session-less call is a metered call, which is the failure this module removes.
  if (response.status === 404 || response.status === 405) {
    throw new FreebuffSessionError(
      'unsupported',
      `this Freebuff server cannot start a session (HTTP ${response.status} for ` +
        `${ADMISSION_PATH}), so model calls would be billed instead of free. Update ` +
        'Freebuff and retry.',
    )
  }

  const body = await requestBody(response)
  if (!response.ok) throw refusalFor(body, options.model)
  if (!isLive(body)) throw refusalFor(body, options.model)

  return {
    instanceId: body.instanceId as string,
    model: options.model,
    reused: false,
    ...(body.accessTier ? { accessTier: body.accessTier } : {}),
  }
}

/** End a session this process admitted. Never called for a reused lease. */
export const closeFreebuffSession = async (options: {
  token: string
  instanceId: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
}): Promise<void> => {
  const env = options.env ?? process.env
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  await doFetch(`${apiBaseUrl(env)}${SESSION_PATH}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${options.token}`,
      [INSTANCE_HEADER]: options.instanceId,
    },
    signal: AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS),
  })
}

/**
 * One session per model, admitted when first needed and released at the end of the
 * command.
 *
 * The cache is keyed by model because the protocol binds a session to one, and the
 * ordering matters: two roles sharing a model must share one lease, or the second
 * admission would be refused by the first's own slot.
 *
 * A throw is memoized per model so a pipeline that asks for the same refused model in
 * every candidate does not re-ask the server once per candidate.
 */
export interface FreebuffSessions {
  /** The lease a call for this model must carry. Idempotent per model. */
  forModel(model: string): Promise<FreebuffSessionLease>
  /** Release every session this process admitted. Reused leases are left alone. */
  release(): Promise<void>
  /** The cost mode every call must carry. */
  readonly costMode: string
}

export const createFreebuffSessions = (options: {
  token: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  reuseLocalSlot?: boolean
  log?: (line: string) => void
}): FreebuffSessions => {
  const log = options.log ?? (() => {})
  const leases = new Map<string, Promise<FreebuffSessionLease>>()
  const failures = new Map<string, FreebuffSessionError>()
  const admitted: FreebuffSessionLease[] = []

  return {
    costMode: FREE_COST_MODE,

    async forModel(model: string): Promise<FreebuffSessionLease> {
      const failure = failures.get(model)
      if (failure) throw failure

      const existing = leases.get(model)
      if (existing) return existing

      const pending = openFreebuffSession({
        token: options.token,
        model,
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.reuseLocalSlot === undefined
          ? {}
          : { reuseLocalSlot: options.reuseLocalSlot }),
      }).then(
        (lease) => {
          if (!lease.reused) admitted.push(lease)
          log(
            `freebuff session ${lease.reused ? 'reused' : 'admitted'} for ` +
              `${model} (${lease.instanceId.slice(0, 8)}…)`,
          )
          return lease
        },
        (error: unknown) => {
          const wrapped =
            error instanceof FreebuffSessionError
              ? error
              : new FreebuffSessionError(
                  'http',
                  error instanceof Error ? error.message : String(error),
                )
          failures.set(model, wrapped)
          throw wrapped
        },
      )

      leases.set(model, pending)
      return pending
    },

    async release(): Promise<void> {
      const held = admitted.splice(0, admitted.length)
      for (const lease of held) {
        try {
          await closeFreebuffSession({
            token: options.token,
            instanceId: lease.instanceId,
            ...(options.env ? { env: options.env } : {}),
            ...(options.fetch ? { fetch: options.fetch } : {}),
          })
          log(`freebuff session released for ${lease.model}`)
        } catch {
          // A session that cannot be released expires on its own; that is worth a
          // missing line, not a failed command.
        }
      }
      leases.clear()
    },
  }
}

/**
 * A session **the host already holds**, read rather than opened (spec §20.41.5).
 *
 * The CLI-hosted case is the one the free tier is built for: the freebuff CLI is the caller,
 * and it is inside a session of its own. Windbreak therefore does not admit anything here —
 * it reads the host's live session on every call and hands the caller the instance id that
 * session carries.
 *
 * Three outcomes, and none of them is a silent metered call:
 *
 * - the host's session is for this model — adopt it;
 * - the host's session is for another one — refuse, naming both, because a session is bound
 *   to one model and taking over the researcher's chat is not a trade a scan gets to make
 *   (the same rule `openFreebuffSession` applies to a slot another *process* holds);
 * - the host holds nothing — refuse, because a request carrying no instance id is exactly
 *   the metered call this module exists to remove.
 *
 * **`release` is a no-op, and that is the ownership rule rather than an omission.** The host
 * admitted the session and the host ends it; a scan that released it would end the chat it
 * was launched from. That is the same rule `client.ts` states for an injected host by leaving
 * `close` off the resolved host entirely.
 *
 * Read per call rather than cached: a session that ends mid-run must produce a refusal on the
 * next call, not a stale instance id the server answers with a billing error.
 */
export interface HostedFreebuffSession {
  instanceId: string
  model: string
}

export const createHostedSessions = (
  live: () => HostedFreebuffSession | null,
): FreebuffSessions => {
  return {
    costMode: FREE_COST_MODE,

    async forModel(model: string): Promise<FreebuffSessionLease> {
      const held = live()

      if (held === null) {
        throw new FreebuffSessionError(
          'slot_held',
          'the Freebuff session this run was handed is no longer live, and a call made ' +
            'without one is billed rather than free. Start a session in the client this ' +
            'ran from and retry.',
        )
      }

      if (held.model !== model) {
        throw new FreebuffSessionError(
          'model_locked',
          `the host's live session is for \`${held.model}\`, and a session is bound to one ` +
            `model. \`${model}\` cannot run on it, and windbreak will not end the host's ` +
            'session to free the slot.',
        )
      }

      return { instanceId: held.instanceId, model, reused: true }
    },

    async release(): Promise<void> {
      // Nothing to release: see the docstring. Deliberately not `openFreebuffSession`'s
      // admitted-list logic, because this builder never admits.
    },
  }
}

/**
 * The metadata a free call must carry, or undefined when the call is metered.
 *
 * Exported so the two `client.run` sites cannot disagree about the key name — a typo here
 * presents as the 402 this module was written to remove, which is exactly the failure a
 * silent drift would reproduce.
 *
 * Undefined rather than an empty object for the metered path: `codebuff_metadata` with a
 * blank instance id is a request that *claims* a session it does not have, which is worse
 * than one that claims nothing.
 */
export const freebuffMetadata = (
  lease: FreebuffSessionLease,
): Record<string, string> | undefined =>
  lease.instanceId.length > 0 ? { freebuff_instance_id: lease.instanceId } : undefined

/**
 * The metered path: no session, the account pays.
 *
 * It exists because free mode turned out to be **unavailable to any client but the
 * freebuff CLI itself** (§20.41.5): a correctly-formed request — a live session, the
 * bundled root agent, `costMode: 'free'` — is still refused with
 *
 *     403 {"error":"free_mode_cli_required", ... "Calling the API directly is not
 *          supported and may get your account banned."}
 *
 * So this is the path that works, and it is the default. The free session layer above is
 * opt-in (`WINDBREAK_FREE_MODE=1`) and recorded as refused-by-the-server rather than
 * removed, because the diagnosis is worth keeping and the transport is correct: what
 * fails is an authorization decision the server makes about the caller, not the request.
 */
export const createMeteredSessions = (costMode = 'normal'): FreebuffSessions => ({
  costMode,
  // No instance id, so `freebuffMetadata` returns undefined and the call carries none.
  forModel: async (model) => ({ instanceId: '', model, reused: false }),
  release: async () => {},
})

/** The env var that opts a run into the free path, off by default. */
export const FREE_MODE_ENV_VAR = 'WINDBREAK_FREE_MODE'
