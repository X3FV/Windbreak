import { FREE_MODE_ENV_VAR, createFreebuffSessions, createMeteredSessions } from './freebuff-session'
import { API_KEY_ENV_VAR, getAuthTokenDetails } from './auth'

/**
 * The session builders a **host** needs, re-exported from this entry point.
 *
 * A host that supplies its own `CodebuffClient` (the CLI, in §20.41.5's hosted case) has to
 * supply the billing alongside it, and it cannot import `freebuff-session.ts` directly — this
 * is the package's public entry point. `createHostedSessions` is the one it wants: the
 * sessions *it* already holds, read rather than opened. `createMeteredSessions` is the
 * honest answer for a host with no Freebuff session at all, so that the alternative to a
 * free session is a named decision rather than a default.
 */
export { createHostedSessions, createMeteredSessions, FREE_COST_MODE } from './freebuff-session'
export type {
  FreebuffSessionLease,
  FreebuffSessions,
  HostedFreebuffSession,
} from './freebuff-session'

import type { AuthTokenSource } from './auth'
import type { FreebuffSessions } from './freebuff-session'
import type { CodebuffClient } from '@codebuff/sdk'

export interface WindbreakClient {
  client: CodebuffClient
  authSource: AuthTokenSource
  /**
   * The Freebuff session every model call is billed to (spec §20.41). One per
   * model, opened on first use and reused across the run.
   */
  sessions: FreebuffSessions
  /**
   * Release the sessions this process admitted, and nothing else. A session
   * another process held is left running, because ending it would end somebody's
   * chat — see `freebuff-session.ts`.
   */
  close: () => Promise<void>
}

export interface CreateWindbreakClientOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Where session admissions are reported. */
  log?: (line: string) => void
  /**
   * Use the Freebuff free path. Off by default, and settable with
   * `WINDBREAK_FREE_MODE=1` (§20.41.6).
   *
   * Off because the server refuses it: free mode answers any client that is not the
   * freebuff CLI itself with `403 free_mode_cli_required`, so a run that opts in here
   * fails at every model call. It stays available for the one caller it is for —
   * windbreak hosted *inside* that CLI — and for measuring the refusal, not because a
   * batch run can use it.
   */
  freeMode?: boolean
}

export class MissingCredentialsError extends Error {
  constructor(credentialsPath: string) {
    super(
      `No Freebuff credentials found. Run \`freebuff\` to log in, or set ${API_KEY_ENV_VAR}. ` +
        `Looked for credentials at ${credentialsPath}.`,
    )
    this.name = 'MissingCredentialsError'
  }
}

/**
 * The SDK validates its client environment **at import time** (`@codebuff/common/env`
 * parses `process.env` and throws on the first missing `NEXT_PUBLIC_*` value).
 * Imported without that environment the failure is a zod issue dump from four
 * modules deep, which says nothing about what the operator should do. This
 * turns it into an actionable message.
 *
 * `src/pre-init/client-env.ts` supplies the public production defaults before
 * any of this is reached, so the failure is now the unusual case: a value that
 * was *set* and is invalid, or a run that skipped the pre-init (a library
 * consumer importing this module directly, or a test without the repo's
 * `--preload ../sdk/test/setup-env.ts` fixture). The message says which.
 */
export class SdkEnvironmentError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      'Could not load the model SDK: its client environment is not configured.\n' +
        'The SDK validates the NEXT_PUBLIC_* values at import time. WindBreak fills ' +
        'in the public production defaults for any that are unset ' +
        '(`@codebuff/common/client-env-defaults`), so this usually means one was ' +
        '*set* and is invalid — an exported NEXT_PUBLIC_CODEBUFF_APP_URL that is not ' +
        'a URL, for example. Fix or unset it and retry.\n' +
        'For a hermetic test environment the repo ships a fixture: ' +
        '`bun --preload ../sdk/test/setup-env.ts src/index.ts ...`.\n' +
        `Underlying error: ${detail}`,
      { cause },
    )
    this.name = 'SdkEnvironmentError'
  }
}

/**
 * Build the single model-routing client every WindBreak stage shares.
 *
 * Routing goes through `@codebuff/sdk` in-process so there is exactly one place
 * model calls are made (spec §8), and the token is resolved exactly as the CLI
 * resolves it — `credentials.json` first, `CODEBUFF_API_KEY` second, so the
 * same code path works headless in CI.
 *
 * **The client comes with its sessions.** A `CodebuffClient` on its own makes
 * metered calls; the free tier is a session, and the session is opened here so
 * that no caller has to remember it. §20.41 records what forgetting it cost.
 *
 * The SDK is imported lazily: the CLI's non-model commands (`auth status`,
 * `config validate`, `db init`) must not pay for loading it, and it must not
 * break when the SDK has not been built.
 *
 * The environment the import needs is supplied by `src/pre-init/client-env.ts`,
 * which `index.ts` imports first. This module deliberately does not fill it
 * itself: a builder function that mutates `process.env` would leak into every
 * test that passes an injected env.
 */
export const createWindbreakClient = async (
  options: CreateWindbreakClientOptions = {},
): Promise<WindbreakClient> => {
  const { token, source, credentialsPath } = getAuthTokenDetails(options.env)

  if (!token || !source) {
    throw new MissingCredentialsError(credentialsPath)
  }

  let CodebuffClient: (typeof import('@codebuff/sdk'))['CodebuffClient']
  try {
    ;({ CodebuffClient } = await import('@codebuff/sdk'))
  } catch (error) {
    throw new SdkEnvironmentError(error)
  }

  const client = new CodebuffClient({
    apiKey: token,
    cwd: options.cwd ?? process.cwd(),
  })

  // Built before the SDK is reached on purpose: a missing session is a diagnosis worth
  // having whether or not the SDK loaded.
  const env = options.env ?? process.env
  const freeMode = options.freeMode ?? env[FREE_MODE_ENV_VAR] === '1'

  const sessions = freeMode
    ? createFreebuffSessions({
        token,
        ...(options.env ? { env: options.env } : {}),
        ...(options.log ? { log: options.log } : {}),
      })
    : createMeteredSessions()

  options.log?.(
    freeMode
      ? `model routing: freebuff free mode (${FREE_MODE_ENV_VAR}=1) — the server refuses ` +
          'this for any client but the freebuff CLI'
      : 'model routing: metered (credits), costMode normal',
  )

  return {
    client,
    authSource: source,
    sessions,
    close: () => sessions.release(),
  }
}

/**
 * A model transport the caller already owns (spec §20.41).
 *
 * The batch stages build their own client, which is right for a command and wrong for a
 * host. Freebuff's free mode is admitted only to the freebuff CLI *as a caller*, so a
 * caller that **is** that CLI has to be able to run a scan on the client and the session it
 * already holds rather than on a second pair the scan invents for itself. This is how such
 * a caller supplies its own.
 *
 * **Teardown stays with the owner, and that is not a detail.** An injected host is never
 * closed by the stage that borrows it: the session belongs to whoever handed it over, and a
 * scan releasing it would end a chat it did not open (§20.41.3). There is deliberately no
 * `close` here for the stage to call — a host that wants to release its own session does
 * that where the session was opened.
 */
export interface WindbreakModelHost {
  client: CodebuffClient
  sessions: FreebuffSessions
}

export interface ResolvedModelHost {
  host: WindbreakModelHost
  /** Release the sessions this process opened. **Absent when the host was injected.** */
  close?: () => Promise<void>
}

/**
 * The host a stage runs on: the caller's, or one built from the environment.
 *
 * The `close` in the result is what makes the difference observable downstream — a stage
 * that receives none has nothing to release, because it borrowed rather than opened.
 */
export const resolveModelHost = async (
  injected?: WindbreakModelHost,
): Promise<ResolvedModelHost> => {
  if (injected) return { host: injected }

  const owned = await createWindbreakClient()
  return {
    host: { client: owned.client, sessions: owned.sessions },
    close: owned.close,
  }
}
