import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  API_KEY_ENV_VAR,
  getAuthTokenDetails,
  getConfigDir,
  getCredentialsPath,
  readAuthTokenFromCredentials,
} from './auth'

let tmpDir: string

const writeCredentials = (contents: unknown): string => {
  const credentialsPath = path.join(tmpDir, 'credentials.json')
  fs.writeFileSync(credentialsPath, JSON.stringify(contents))
  return credentialsPath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-auth-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('getConfigDir', () => {
  test('honours an absolute FREEBUFF_CONFIG_DIR', () => {
    expect(getConfigDir({ FREEBUFF_CONFIG_DIR: tmpDir })).toBe(tmpDir)
  })

  test('refuses a relative FREEBUFF_CONFIG_DIR', () => {
    expect(() => getConfigDir({ FREEBUFF_CONFIG_DIR: './relative' })).toThrow(
      /absolute path/,
    )
  })

  test('suffixes the environment onto the default path', () => {
    const dev = getConfigDir({ NEXT_PUBLIC_CB_ENVIRONMENT: 'dev' })
    const prod = getConfigDir({ NEXT_PUBLIC_CB_ENVIRONMENT: 'prod' })

    expect(dev.endsWith(`manicode-dev`)).toBe(true)
    expect(prod.endsWith(`manicode`)).toBe(true)
  })
})

describe('readAuthTokenFromCredentials', () => {
  test('reads the default profile', () => {
    const credentialsPath = writeCredentials({
      default: { authToken: 'token-from-file' },
    })

    expect(readAuthTokenFromCredentials(credentialsPath)).toBe('token-from-file')
  })

  test('ignores non-default profiles', () => {
    const credentialsPath = writeCredentials({
      work: { authToken: 'other-token' },
    })

    expect(readAuthTokenFromCredentials(credentialsPath)).toBeUndefined()
  })

  test('returns undefined for a missing file, malformed json, or empty token', () => {
    expect(
      readAuthTokenFromCredentials(path.join(tmpDir, 'nope.json')),
    ).toBeUndefined()

    const malformed = path.join(tmpDir, 'malformed.json')
    fs.writeFileSync(malformed, '{ not json')
    expect(readAuthTokenFromCredentials(malformed)).toBeUndefined()

    const empty = writeCredentials({ default: { authToken: '' } })
    expect(readAuthTokenFromCredentials(empty)).toBeUndefined()
  })
})

describe('getAuthTokenDetails', () => {
  const env = (): NodeJS.ProcessEnv => ({ FREEBUFF_CONFIG_DIR: tmpDir })

  test('prefers credentials over the environment', () => {
    writeCredentials({ default: { authToken: 'from-file' } })

    const details = getAuthTokenDetails({
      ...env(),
      [API_KEY_ENV_VAR]: 'from-env',
    })

    expect(details.token).toBe('from-file')
    expect(details.source).toBe('credentials')
  })

  test('falls back to the env var when no credentials file exists', () => {
    const details = getAuthTokenDetails({
      ...env(),
      [API_KEY_ENV_VAR]: 'from-env',
    })

    expect(details.token).toBe('from-env')
    expect(details.source).toBe('environment')
  })

  test('reports a null source and the path it looked in when unauthenticated', () => {
    const details = getAuthTokenDetails(env())

    expect(details.token).toBeUndefined()
    expect(details.source).toBeNull()
    expect(details.credentialsPath).toBe(getCredentialsPath(env()))
  })
})
