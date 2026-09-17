import { FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID } from '@codebuff/common/constants/freebuff-models'
import { afterEach, describe, expect, test } from 'bun:test'

import { useFreebuffModelStore } from '../../state/freebuff-model-store'
import { useFreebuffSessionStore } from '../../state/freebuff-session-store'
import { createCliModelHost, liveCliSession } from '../model-host'

import type { CodebuffClient } from '@codebuff/sdk'
import type { FreebuffSessionResponse } from '../../types/freebuff-session'

/**
 * What this CLI hands a WindBreak view, and what it refuses to hand (§20.41.5).
 *
 * The two claims worth pinning are both about *not* doing something: the host does not build a
 * client (it lends the one a chat turn runs on), and it does not open a session (it reads the
 * one this process already holds). A regression in either is invisible at the call site — the
 * scan and the pane work exactly as well as before — which is why they are asserted here rather
 * than left to the code that consumes them.
 */

const originalModel = useFreebuffModelStore.getState().selectedModel

afterEach(() => {
  useFreebuffSessionStore.getState().setSession(null)
  useFreebuffModelStore.getState().setSelectedModel(originalModel)
})

const activeSession = (model: string): FreebuffSessionResponse => ({
  status: 'active',
  accessTier: 'full',
  instanceId: 'inst-cli',
  model,
  admittedAt: '2026-09-17T10:00:00.000Z',
  expiresAt: '2026-09-17T11:00:00.000Z',
  remainingMs: 3_600_000,
})

const fakeClient = (): CodebuffClient => ({}) as CodebuffClient

describe('liveCliSession', () => {
  test('names the instance and the model of the session this process holds', () => {
    useFreebuffSessionStore
      .getState()
      .setSession(activeSession(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID))

    expect(liveCliSession()).toEqual({
      instanceId: 'inst-cli',
      model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    })
  })

  test('is null when there is no live slot, however the state reads', () => {
    // Both halves of "no session": nothing at all, and a state that is not a slot. One answer
    // for both, because the caller's responses are the same — refuse, or report the refusal —
    // and a caller able to tell them apart would be tempted to guess at one.
    expect(liveCliSession()).toBeNull()

    useFreebuffSessionStore.getState().setSession({ status: 'none' })
    expect(liveCliSession()).toBeNull()
  })

  test('falls back to the selected model where the state carries none of its own', () => {
    // The `ended` state inside the post-expiry grace window is synthesised locally from the
    // fields the banner needs, and a chat turn there sends the *selected* model. Reading the
    // same value is what keeps a WindBreak call identical to a chat turn rather than merely
    // similar to one.
    useFreebuffSessionStore
      .getState()
      .setSession({ status: 'ended', instanceId: 'inst-grace', accessTier: 'full' })
    useFreebuffModelStore
      .getState()
      .setSelectedModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)

    expect(liveCliSession()).toEqual({
      instanceId: 'inst-grace',
      model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
    })
  })
})

describe('createCliModelHost', () => {
  test('lends this CLI’s client, and adopts the session this process holds', async () => {
    const client = fakeClient()
    const host = await createCliModelHost({
      client,
      freebuff: true,
      live: () => liveCliSession(),
    })

    expect(host).not.toBeNull()
    expect(host!.client).toBe(client)

    useFreebuffSessionStore
      .getState()
      .setSession(activeSession(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID))

    const lease = await host!.sessions.forModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID)

    expect(lease).toEqual({
      instanceId: 'inst-cli',
      model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
      reused: true,
    })
    expect(host!.sessions.costMode).toBe('free')
  })

  test('a model the held session is not bound to is refused rather than metered', async () => {
    const host = await createCliModelHost({
      client: fakeClient(),
      freebuff: true,
      live: () => liveCliSession(),
    })
    useFreebuffSessionStore
      .getState()
      .setSession(activeSession(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID))

    await expect(host!.sessions.forModel('z-ai/glm-5.3-flash')).rejects.toThrow(
      /bound to one model/,
    )
  })

  test('no client is null, and no session is read to find that out', async () => {
    let reads = 0
    const host = await createCliModelHost({
      client: null,
      live: () => {
        reads += 1
        return null
      },
    })

    expect(host).toBeNull()
    expect(reads).toBe(0)
  })

  test('a credits build hands over the metered path even while a session is live', async () => {
    // Who pays is a decision rather than a default: a Codebuff build has no free session to
    // lend, so it lends the metered path — and it does so without consulting the free-session
    // store, which is what would otherwise make the answer depend on whichever state happened
    // to be in memory.
    let reads = 0
    const host = await createCliModelHost({
      client: fakeClient(),
      freebuff: false,
      live: () => {
        reads += 1
        return { instanceId: 'inst-cli', model: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID }
      },
    })

    expect(reads).toBe(0)
    expect(host!.sessions.costMode).toBe('normal')
    await expect(
      host!.sessions.forModel(FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID),
    ).resolves.toMatchObject({ instanceId: '' })
  })
})
