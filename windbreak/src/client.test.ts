import { describe, expect, test } from 'bun:test'

import { resolveModelHost } from './client'
import { createMeteredSessions } from './freebuff-session'

import type { CodebuffClient } from '@codebuff/sdk'
import type { WindbreakModelHost } from './client'

/**
 * The injected-host seam (spec §20.41).
 *
 * What this has to guarantee, and why each half matters:
 *
 * - An injected host is used **as given**, so a caller inside the freebuff CLI can run a
 *   stage on the client and session that CLI already holds. Free mode is admitted to no
 *   other caller, so a stage that quietly built its own transport would be refused at the
 *   provider no matter what the host passed in.
 * - An injected host is **not closable by the borrower.** The session belongs to whoever
 *   handed it over, and a scan releasing it would end a chat it is not party to. That is
 *   asserted as an absent function rather than as a flag, because "nothing to call" is the
 *   property the stages depend on.
 *
 * Only the injected path is tested here. The other branch builds a client from the
 * environment, which on a developer machine with credentials resolves for real — a test
 * that passes here and fails in CI is worse than no test, and the behaviour it would cover
 * is already pinned by the credentials tests in `auth.test.ts`.
 */

const fakeClient = (): CodebuffClient => ({ run: async () => ({}) }) as unknown as CodebuffClient

const host = (): WindbreakModelHost => ({
  client: fakeClient(),
  sessions: createMeteredSessions(),
})

describe('resolveModelHost', () => {
  test('hands back an injected host unchanged, with no close to call', async () => {
    const injected = host()

    const resolved = await resolveModelHost(injected)

    expect(resolved.host).toBe(injected)
    expect(resolved.host.client).toBe(injected.client)
    expect(resolved.host.sessions).toBe(injected.sessions)
    // Absent, not a no-op function: a stage that receives this has nothing to release, and
    // the type says so where the release is issued.
    expect(resolved.close).toBeUndefined()
  })

  test('resolves with no token in the environment, because it asks for none', async () => {
    // The discriminator against the ownership branch: that one reaches
    // `getAuthTokenDetails` and throws `MissingCredentialsError` without credentials. This
    // resolves, which is only possible if the injected path consults nothing — asserted by
    // value rather than by observing a call, since the absence of a lookup is the point.
    const resolved = await resolveModelHost(host())

    expect(resolved).toEqual({ host: expect.anything() })
  })

  test('does not rewrite the billing the caller chose', async () => {
    // A resolver that defaulted a borrowed host to its own cost mode would silently change
    // who pays, which is the whole subject of §20.41. `'free'` here is not a working
    // configuration — the server refuses it for this caller — it is a marker that survives
    // or does not.
    const injected: WindbreakModelHost = {
      client: fakeClient(),
      sessions: { ...createMeteredSessions(), costMode: 'free' },
    }

    const resolved = await resolveModelHost(injected)

    expect(resolved.host.sessions.costMode).toBe('free')
  })
})
