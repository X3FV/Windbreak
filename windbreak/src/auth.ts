import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Auth-token fallback env var. Same name the CLI and SDK use
 * (`@codebuff/common/constants/paths` -> `API_KEY_ENV_VAR`), repeated here so
 * this module has no dependency on a private package.
 */
export const API_KEY_ENV_VAR = 'CODEBUFF_API_KEY'

export type AuthTokenSource = 'credentials' | 'environment'

export interface AuthTokenDetails {
  token?: string
  source: AuthTokenSource | null
  credentialsPath: string
}

/**
 * Resolve the on-disk config directory.
 *
 * Mirrors `cli/src/utils/config-dir.ts`. Deliberately reimplemented rather than
 * imported: `@codebuff/cli` is private and is not a workspace dependency, and
 * reading `process.env` directly keeps this module from pulling in
 * `@codebuff/common/env`, which validates and throws at import time.
 */
export const getConfigDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const configuredDir = env.FREEBUFF_CONFIG_DIR
  if (configuredDir) {
    if (!path.isAbsolute(configuredDir)) {
      throw new Error(
        'FREEBUFF_CONFIG_DIR must be an absolute path so CLI settings cannot be written relative to the current project.',
      )
    }
    return configuredDir
  }

  const environment = env.NEXT_PUBLIC_CB_ENVIRONMENT
  const suffix = environment && environment !== 'prod' ? `-${environment}` : ''

  return path.join(os.homedir(), '.config', `manicode${suffix}`)
}

export const getCredentialsPath = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(getConfigDir(env), 'credentials.json')

interface CredentialsFile {
  default?: {
    authToken?: unknown
  }
}

/**
 * Read the auth token out of `credentials.json`.
 *
 * The file is profile-keyed; WindBreak only ever uses the `default` profile,
 * matching the CLI. A missing or malformed file is not an error here — callers
 * report it with the source they resolved instead.
 */
export const readAuthTokenFromCredentials = (
  credentialsPath: string,
): string | undefined => {
  if (!fs.existsSync(credentialsPath)) return undefined

  try {
    const parsed = JSON.parse(
      fs.readFileSync(credentialsPath, 'utf8'),
    ) as CredentialsFile
    const token = parsed?.default?.authToken
    return typeof token === 'string' && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the auth token and record where it came from. Credentials win over
 * the environment, matching `cli/src/utils/auth.ts`.
 *
 * Never log or serialize the returned `token`.
 */
export const getAuthTokenDetails = (
  env: NodeJS.ProcessEnv = process.env,
): AuthTokenDetails => {
  const credentialsPath = getCredentialsPath(env)

  const credentialsToken = readAuthTokenFromCredentials(credentialsPath)
  if (credentialsToken) {
    return { token: credentialsToken, source: 'credentials', credentialsPath }
  }

  const envToken = env[API_KEY_ENV_VAR]
  if (envToken) {
    return { token: envToken, source: 'environment', credentialsPath }
  }

  return { source: null, credentialsPath }
}

export const hasAuthToken = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!getAuthTokenDetails(env).token
