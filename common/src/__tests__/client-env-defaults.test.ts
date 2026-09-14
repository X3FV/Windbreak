import { describe, test, expect, afterEach } from 'bun:test'

import {
  CLIENT_ENV_DEFAULTS,
  applyClientEnvDefaults,
  createDefaultClientEnv,
  isCompiledBinary,
} from '../client-env-defaults'
import { clientEnvSchema, clientEnvVars } from '../env-schema'

/**
 * The point of these tests is not that defaults exist, but that they are
 * *sufficient*: §20.19.8 declined this fix because "a partial pre-check would
 * produce a worse answer than the dump". So the central assertion is that the
 * applied environment parses under the real schema, and the rest guard the
 * three rules the applier promises.
 */
describe('client-env-defaults', () => {
  describe('the table', () => {
    test('covers every variable in the schema', () => {
      // `Record<ClientEnvVar, string>` already fails to compile if this is
      // untrue; the runtime check is what catches a deleted key surviving a
      // stale build, and it is what makes the compile-time guard legible.
      expect(Object.keys(CLIENT_ENV_DEFAULTS).sort()).toEqual(
        [...clientEnvVars].sort(),
      )
    })

    test('is a fresh object per call, not shared state', () => {
      const first = createDefaultClientEnv()
      const second = createDefaultClientEnv()

      expect(first).toEqual(second)
      expect(first).not.toBe(second)
    })
  })

  describe('sufficiency', () => {
    test('the applied environment satisfies the schema it exists to satisfy', () => {
      const parsed = clientEnvSchema.safeParse(createDefaultClientEnv())
      if (!parsed.success) {
        // Print the real issue list, since a bare `false` says nothing about
        // which value went stale.
        throw new Error(
          `defaults do not satisfy clientEnvSchema: ${JSON.stringify(parsed.error.issues)}`,
        )
      }

      expect(parsed.data.NEXT_PUBLIC_CB_ENVIRONMENT).toBe('prod')
      expect(parsed.data.NEXT_PUBLIC_WEB_PORT).toBe(3000)
    })

    test('fills every required variable', () => {
      const target: NodeJS.ProcessEnv = {}

      const filled = applyClientEnvDefaults(target)

      // Set-wise: everything but the two no-default entries. The two are the
      // optional variables the release build leaves unset.
      expect([...filled].sort()).toEqual(
        [...clientEnvVars]
          .filter((key) => CLIENT_ENV_DEFAULTS[key] !== '')
          .sort(),
      )
    })

    test('reports what it filled in table order, so a caller need not sort', () => {
      const filled = applyClientEnvDefaults({})

      expect(filled).toEqual(
        Object.keys(CLIENT_ENV_DEFAULTS).filter(
          (key) => CLIENT_ENV_DEFAULTS[key as keyof typeof CLIENT_ENV_DEFAULTS] !== '',
        ),
      )
    })
  })

  describe('only missing values are filled', () => {
    test('an explicit value wins', () => {
      const target: NodeJS.ProcessEnv = {
        NEXT_PUBLIC_CB_ENVIRONMENT: 'dev',
        NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
      }

      const filled = applyClientEnvDefaults(target)

      expect(target.NEXT_PUBLIC_CB_ENVIRONMENT).toBe('dev')
      expect(target.NEXT_PUBLIC_CODEBUFF_APP_URL).toBe('http://localhost:3000')
      expect(filled).not.toContain('NEXT_PUBLIC_CB_ENVIRONMENT')
      expect(filled).not.toContain('NEXT_PUBLIC_CODEBUFF_APP_URL')
    })

    test('an invalid value is kept, so the typo still fails validation', () => {
      const target: NodeJS.ProcessEnv = {
        NEXT_PUBLIC_CODEBUFF_APP_URL: 'not-a-url',
      }

      applyClientEnvDefaults(target)

      expect(target.NEXT_PUBLIC_CODEBUFF_APP_URL).toBe('not-a-url')
      // The point: filling the rest must not paper over the one bad value.
      expect(clientEnvSchema.safeParse(target).success).toBe(false)
    })

    test('an empty string counts as missing', () => {
      const target: NodeJS.ProcessEnv = { NEXT_PUBLIC_SUPPORT_EMAIL: '' }

      const filled = applyClientEnvDefaults(target)

      expect(target.NEXT_PUBLIC_SUPPORT_EMAIL).toBe('support@codebuff.com')
      expect(filled).toContain('NEXT_PUBLIC_SUPPORT_EMAIL')
    })

    test('is idempotent', () => {
      const target: NodeJS.ProcessEnv = {}

      applyClientEnvDefaults(target)

      expect(applyClientEnvDefaults(target)).toEqual([])
    })
  })

  describe('empty table entries are never written', () => {
    test('a variable with no default stays absent rather than present-and-empty', () => {
      const target: NodeJS.ProcessEnv = {}

      applyClientEnvDefaults(target)

      // Writing '' here would be worse than doing nothing: `.optional()` only
      // tolerates *absence*, so a present empty string turns an allowed
      // omission into a validation failure.
      expect('NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY' in target).toBe(false)
      expect('NEXT_PUBLIC_RECAPTCHA_V2_SIZE' in target).toBe(false)
      expect(CLIENT_ENV_DEFAULTS.NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY).toBe('')
      expect(CLIENT_ENV_DEFAULTS.NEXT_PUBLIC_RECAPTCHA_V2_SIZE).toBe('')
    })
  })

  describe('a compiled binary is left alone', () => {
    test('isCompiledBinary reads the flag', () => {
      expect(isCompiledBinary({ CODEBUFF_IS_BINARY: 'true' })).toBe(true)
      expect(isCompiledBinary({})).toBe(false)
      expect(isCompiledBinary({ CODEBUFF_IS_BINARY: 'false' })).toBe(false)
    })

    test('applyClientEnvDefaults fills nothing when the flag is set', () => {
      const target: NodeJS.ProcessEnv = { CODEBUFF_IS_BINARY: 'true' }

      expect(applyClientEnvDefaults(target)).toEqual([])
      expect(target.NEXT_PUBLIC_CB_ENVIRONMENT).toBeUndefined()
    })
  })

  describe('the default target is process.env', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      for (const key of clientEnvVars) {
        delete process.env[key]
      }
      Object.assign(process.env, originalEnv)
    })

    test('fills the real process env', () => {
      for (const key of clientEnvVars) {
        delete process.env[key]
      }
      delete process.env.CODEBUFF_IS_BINARY

      const filled = applyClientEnvDefaults()

      expect(filled).toContain('NEXT_PUBLIC_CB_ENVIRONMENT')
      expect(process.env.NEXT_PUBLIC_CB_ENVIRONMENT).toBe('prod')
      expect(clientEnvSchema.safeParse(process.env).success).toBe(true)
    })
  })
})
