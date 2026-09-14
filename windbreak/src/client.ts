import { API_KEY_ENV_VAR, getAuthTokenDetails } from './auth'

import type { AuthTokenSource } from './auth'
import type { CodebuffClient } from '@codebuff/sdk'

export interface WindbreakClient {
  client: CodebuffClient
  authSource: AuthTokenSource
}

export interface CreateWindbreakClientOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
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

  return { client, authSource: source }
}
