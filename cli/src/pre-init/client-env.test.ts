import { describe, test, expect, afterEach } from 'bun:test'

import { clientEnvSchema, clientEnvVars } from '@codebuff/common/env-schema'

/**
 * The CLI is the process that actually dies without this: `index.tsx` reaches
 * `@codebuff/common/env` through its own static imports, and that module throws
 * during evaluation — an uncatchable failure before `main`, which is why the
 * fix has to be a pre-init import rather than a `try`/`catch`.
 *
 * The module is imported dynamically so it is evaluated against the emptied
 * environment below rather than at file load.
 */
describe('pre-init/client-env', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of clientEnvVars) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  test('gives index.tsx an environment @codebuff/common/env accepts', async () => {
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
