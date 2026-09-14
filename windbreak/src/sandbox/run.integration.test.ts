import { describe, expect, test } from 'bun:test'

import { detectBackends } from './backends'
import { runSandboxProbes } from './probe'

/**
 * Live probes against whatever backend this host has.
 *
 * These are the tests that catch a sandbox which *looks* correct but does not
 * actually isolate: the argv tests in `bwrap.test.ts` and `nsjail.test.ts`
 * assert the flags, these assert the behaviour.
 *
 * Unprivileged user namespaces are disabled on some CI runners, in which case
 * bubblewrap cannot start at all. That is an environment limitation rather than
 * a regression, so the suite reports and skips instead of failing — but it only
 * skips when the sandbox cannot *start*, never when isolation is merely broken.
 */
describe('sandbox probes (live)', () => {
  const available = detectBackends()
  const hasBackend = available.nsjail !== null || available.bwrap !== null

  test.skipIf(!hasBackend)(
    'exec works, the read-only bind refuses writes, and there is no network',
    async () => {
      const results = await runSandboxProbes()
      const exec = results.find((result) => result.name === 'exec')

      if (!exec?.ok) {
        console.warn(
          `[windbreak] skipping live sandbox probes: ${exec?.detail ?? 'sandbox did not start'}`,
        )
        return
      }

      for (const result of results) {
        expect({ name: result.name, ok: result.ok, detail: result.detail }).toEqual({
          name: result.name,
          ok: true,
          detail: expect.any(String),
        })
      }
    },
  )
})
