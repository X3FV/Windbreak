import { describe, test, expect, afterEach } from 'bun:test'

import { clientEnvSchema, clientEnvVars } from '@codebuff/common/env-schema'

/**
 * `appliedClientEnvDefaults` is only interesting when the environment it ran
 * against was incomplete, so this clears the public vars and imports the module
 * *after* doing so. A static import would be evaluated at file load, before any
 * test body runs.
 *
 * What this does not cover: deleting the import in `src/index.ts`. Only running
 * the CLI with a scrubbed environment shows that, and that is how it was
 * verified.
 */
describe('pre-init/client-env', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of clientEnvVars) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  test('leaves process.env sufficient for @codebuff/common/env', async () => {
    for (const key of clientEnvVars) {
      delete process.env[key]
    }
    delete process.env.CODEBUFF_IS_BINARY

    const { appliedClientEnvDefaults } = await import('./client-env')

    expect(appliedClientEnvDefaults).toContain('NEXT_PUBLIC_CB_ENVIRONMENT')
    expect(process.env.NEXT_PUBLIC_CB_ENVIRONMENT).toBe('prod')
    expect(clientEnvSchema.safeParse(process.env).success).toBe(true)
  })
})
