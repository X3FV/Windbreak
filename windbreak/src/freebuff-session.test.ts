import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  ADMISSION_PATH,
  FREE_COST_MODE,
  FreebuffSessionError,
  INSTANCE_HEADER,
  MODEL_HEADER,
  SESSION_PATH,
  WALLET_SPEND_LIMIT_HEADER,
  createFreebuffSessions,
  createHostedSessions,
  createMeteredSessions,
  freebuffMetadata,
  openFreebuffSession,
} from './freebuff-session'

import type { HostedFreebuffSession } from './freebuff-session'

/**
 * The protocol the free tier is, without a network (spec §20.41).
 *
 * These tests are the ones that matter for that section, because the defect they cover
 * was *silence*: no session was requested at all, so nothing failed and nothing was
 * logged. What is asserted here is therefore mostly about what is **not** sent — no
 * admission when a slot is already held, no release of a slot this process did not
 * take, no model call at all when the session could not be opened.
 */

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const configDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-session-'))
  dirs.push(dir)
  return dir
}

/** The owner file the CLI writes when *it* admits a session. */
const writeOwner = (dir: string, pid: number): void => {
  fs.writeFileSync(
    path.join(dir, 'freebuff-instance-owner.json'),
    JSON.stringify({ instanceId: 'inst-held', pid }),
  )
}

/** A pid that is an integer, positive, and cannot be running. */
const DEAD_PID = 2 ** 30

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

const fakeFetch = (
  answer: (call: Call) => { status?: number; body?: unknown },
  calls: Call[] = [],
): typeof globalThis.fetch =>
  (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)

    const { status = 200, body = {} } = answer(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch

const options = (dir: string, fetch: typeof globalThis.fetch) => ({
  token: 'token-1',
  env: { FREEBUFF_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
  fetch,
})

describe('openFreebuffSession', () => {
  test('admits a session when the account holds nothing, and asks for no spend', async () => {
    const dir = configDir()
    const calls: Call[] = []
    const fetch = fakeFetch(
      () => ({ body: { status: 'active', instanceId: 'inst-new', model: 'deepseek/v4' } }),
      calls,
    )

    const lease = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'deepseek/v4',
    })

    expect(lease).toEqual({
      instanceId: 'inst-new',
      model: 'deepseek/v4',
      reused: false,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain(ADMISSION_PATH)
    expect(calls[0]?.headers[MODEL_HEADER]).toBe('deepseek/v4')
    // `0` is the CLI's own value: a session windbreak starts buys no provider spend.
    expect(calls[0]?.headers[WALLET_SPEND_LIMIT_HEADER]).toBe('0')
  })

  test('adopts a live slot the account already holds, and admits nothing', async () => {
    const dir = configDir()
    writeOwner(dir, process.pid)
    const calls: Call[] = []
    const fetch = fakeFetch(
      () => ({ body: { status: 'active', instanceId: 'inst-held', model: 'glm/5.3' } }),
      calls,
    )

    const lease = await openFreebuffSession({ ...options(dir, fetch), model: 'glm/5.3' })

    expect(lease).toEqual({
      instanceId: 'inst-held',
      model: 'glm/5.3',
      reused: true,
    })

    // The whole point of reuse: one GET, and the POST that would buy a second seat is
    // never made.
    expect(calls.map((call) => call.method)).toEqual(['GET'])
    expect(calls[0]?.headers[INSTANCE_HEADER]).toBe('inst-held')
  })

  test('refuses rather than take over a slot held for another model', async () => {
    const dir = configDir()
    writeOwner(dir, process.pid)
    const calls: Call[] = []
    const fetch = fakeFetch(
      () => ({ body: { status: 'active', instanceId: 'inst-held', model: 'glm/5.3' } }),
      calls,
    )

    const error = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'deepseek/v4',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FreebuffSessionError)
    expect((error as FreebuffSessionError).kind).toBe('slot_held')
    // Named, so the operator knows which session to end.
    expect((error as FreebuffSessionError).message).toContain('glm/5.3')
    // And no admission was attempted: taking the slot is the thing being refused.
    expect(calls.map((call) => call.method)).toEqual(['GET'])
  })

  test('ignores an owner file whose process is gone', async () => {
    const dir = configDir()
    writeOwner(dir, DEAD_PID)
    const calls: Call[] = []
    const fetch = fakeFetch(
      () => ({ body: { status: 'active', instanceId: 'inst-new', model: 'glm/5.3' } }),
      calls,
    )

    const lease = await openFreebuffSession({ ...options(dir, fetch), model: 'glm/5.3' })

    expect(lease.reused).toBe(false)
    // A stale file must not cost windbreak the seat it is entitled to.
    expect(calls.map((call) => call.method)).toEqual(['POST'])
  })

  test('names the holder when the server says the model is locked', async () => {
    const dir = configDir()
    const fetch = fakeFetch(() => ({
      status: 409,
      body: { status: 'model_locked', currentModel: 'glm/5.3', requestedModel: 'deepseek/v4' },
    }))

    const error = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'deepseek/v4',
    }).catch((caught: unknown) => caught)

    expect((error as FreebuffSessionError).kind).toBe('model_locked')
    expect((error as FreebuffSessionError).message).toContain('glm/5.3')
    expect((error as FreebuffSessionError).message).toContain('will not end it')
  })

  test('fails closed when the server cannot start a session at all', async () => {
    // The dangerous reading of a 404 here is "no session, carry on" — which is a metered
    // call, the exact defect. It has to be an error that says so.
    const dir = configDir()
    const fetch = fakeFetch(() => ({ status: 404, body: {} }))

    const error = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'glm/5.3',
    }).catch((caught: unknown) => caught)

    expect((error as FreebuffSessionError).kind).toBe('unsupported')
    expect((error as FreebuffSessionError).message).toMatch(/would be billed instead of free/)
  })

  test('reports a location refusal as one, and does not retry it as an admission', async () => {
    const dir = configDir()
    const fetch = fakeFetch(() => ({
      status: 403,
      body: { status: 'country_blocked', countryCode: 'XX' },
    }))

    const error = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'glm/5.3',
    }).catch((caught: unknown) => caught)

    expect((error as FreebuffSessionError).kind).toBe('country_blocked')
    expect((error as FreebuffSessionError).message).toContain('XX')
  })

  test('reads a 200 that carries no instance id as a refusal, not as a session', async () => {
    // A body without an instance id is a session that cannot be billed to. Treating it
    // as success would produce a call with no `freebuff_instance_id`, which is the
    // metered shape this module exists to prevent.
    const dir = configDir()
    const fetch = fakeFetch(() => ({ status: 200, body: { status: 'none' } }))

    const error = await openFreebuffSession({
      ...options(dir, fetch),
      model: 'glm/5.3',
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FreebuffSessionError)
  })
})

describe('createFreebuffSessions', () => {
  test('opens one session per model, because a session is bound to one', async () => {
    const dir = configDir()
    const calls: Call[] = []
    const fetch = fakeFetch(
      (call) => ({
        body: {
          status: 'active',
          instanceId: `inst-${call.headers[MODEL_HEADER]}`,
          model: call.headers[MODEL_HEADER],
        },
      }),
      calls,
    )

    const sessions = createFreebuffSessions({
      token: 'token-1',
      env: { FREEBUFF_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
      fetch,
    })

    const first = await sessions.forModel('glm/5.3')
    const second = await sessions.forModel('deepseek/v4')
    // Asked twice, admitted once: a second admission for the same model would be
    // refused by the slot the first one holds.
    const again = await sessions.forModel('glm/5.3')

    expect(first.instanceId).toBe('inst-glm/5.3')
    expect(second.instanceId).toBe('inst-deepseek/v4')
    expect(again).toBe(first)
    expect(calls).toHaveLength(2)
    expect(sessions.costMode).toBe(FREE_COST_MODE)
    expect(sessions.costMode).toBe('free')
  })

  test('a refused model is refused once, not once per candidate', async () => {
    // A scan asks for the same model on every candidate. Re-asking a refusal a hundred
    // times is a hundred requests to be told the same thing.
    const dir = configDir()
    const calls: Call[] = []
    const fetch = fakeFetch(
      () => ({ status: 409, body: { status: 'model_locked', currentModel: 'glm/5.3' } }),
      calls,
    )

    const sessions = createFreebuffSessions({
      token: 'token-1',
      env: { FREEBUFF_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
      fetch,
    })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sessions.forModel('deepseek/v4').catch(() => undefined)
    }

    expect(calls).toHaveLength(1)
  })

  test('releases only the sessions it admitted', async () => {
    const dir = configDir()
    writeOwner(dir, process.pid)
    const calls: Call[] = []
    const fetch = fakeFetch(
      (call) => ({
        body: {
          status: 'active',
          instanceId: call.method === 'GET' ? 'inst-held' : 'inst-new',
          model: 'glm/5.3',
        },
      }),
      calls,
    )

    const sessions = createFreebuffSessions({
      token: 'token-1',
      env: { FREEBUFF_CONFIG_DIR: dir } as NodeJS.ProcessEnv,
      fetch,
    })

    await sessions.forModel('glm/5.3')
    await sessions.release()

    // No DELETE: the slot belongs to whoever was holding it, and ending it would end
    // their chat.
    expect(calls.map((call) => call.method)).toEqual(['GET'])

    const admittedCalls: Call[] = []
    const admittedFetch = fakeFetch(
      () => ({ body: { status: 'active', instanceId: 'inst-new', model: 'glm/5.3' } }),
      admittedCalls,
    )
    const own = createFreebuffSessions({
      token: 'token-1',
      // A directory with no owner file, so this session is windbreak's own. Reusing
      // `dir` would send the GET above first, which is the correct behaviour and not
      // what this half is asserting.
      env: { FREEBUFF_CONFIG_DIR: configDir() } as NodeJS.ProcessEnv,
      fetch: admittedFetch,
    })
    await own.forModel('glm/5.3')
    await own.release()

    expect(admittedCalls.map((call) => call.method)).toEqual(['POST', 'DELETE'])
    expect(admittedCalls[1]?.headers[INSTANCE_HEADER]).toBe('inst-new')
  })
})

describe('freebuffMetadata', () => {
  test('carries the instance id under the key the server gate reads', () => {
    // Spelled out rather than imported: this string is the one the request body must
    // contain, and a typo in it reproduces the 402 this module removes.
    expect(
      freebuffMetadata({ instanceId: 'inst-1', model: 'glm/5.3', reused: false }),
    ).toEqual({ freebuff_instance_id: 'inst-1' })
  })

  test('is absent, not blank, on the metered path', () => {
    // `codebuff_metadata` carrying an empty instance id would be a request claiming a
    // session it does not have — worse than one claiming nothing.
    expect(
      freebuffMetadata({ instanceId: '', model: 'glm/5.3', reused: false }),
    ).toBeUndefined()
  })
})

describe('createMeteredSessions', () => {
  test('is the default path, and asks for no session and no free cost mode', async () => {
    const sessions = createMeteredSessions()

    const lease = await sessions.forModel('z-ai/glm-5.3-flash')

    expect(sessions.costMode).toBe('normal')
    expect(lease.instanceId).toBe('')
    expect(freebuffMetadata(lease)).toBeUndefined()
    // Nothing to release: no slot was taken.
    await sessions.release()
  })
})

describe('createHostedSessions', () => {
  /**
   * The CLI-hosted case (§20.41.5): the host holds the session, so these tests assert what
   * is *not* done to it as much as what is read from it — no admission, no request, and no
   * release. The host's own chat is on the other side of every one of them.
   */
  const held: HostedFreebuffSession = { instanceId: 'inst-cli', model: 'glm/5.3' }

  test('adopts the host’s session without asking the server for one', async () => {
    let reads = 0
    const sessions = createHostedSessions(() => {
      reads += 1
      return held
    })

    const lease = await sessions.forModel('glm/5.3')

    expect(lease).toEqual({ instanceId: 'inst-cli', model: 'glm/5.3', reused: true })
    expect(sessions.costMode).toBe(FREE_COST_MODE)
    expect(freebuffMetadata(lease)).toEqual({ freebuff_instance_id: 'inst-cli' })
    expect(reads).toBe(1)
  })

  test('a model the host’s session is not bound to is refused, and named', async () => {
    // The account holds one session and a session is bound to one model, so a scan whose
    // second role runs elsewhere has nowhere to go. Refusing here is the whole point: the
    // alternative — dropping the session — is the metered call §20.41 removes, and taking
    // the slot over would end the chat windbreak was launched from.
    const sessions = createHostedSessions(() => held)

    const failure = await sessions.forModel('z-ai/glm-5.3-flash').catch((error) => error)

    expect(failure).toBeInstanceOf(FreebuffSessionError)
    expect((failure as FreebuffSessionError).kind).toBe('model_locked')
    expect((failure as Error).message).toContain('glm/5.3')
    expect((failure as Error).message).toContain('z-ai/glm-5.3-flash')
  })

  test('a session that ends mid-run refuses the next call rather than billing it', async () => {
    // Read per call rather than captured once: a stale instance id is a request the server
    // answers with a billing error, which is the failure this module exists to remove —
    // and the one a memoized lease would produce for the rest of a long scan.
    let live: HostedFreebuffSession | null = held
    const sessions = createHostedSessions(() => live)

    await sessions.forModel('glm/5.3')
    live = null

    const failure = await sessions.forModel('glm/5.3').catch((error) => error)

    expect(failure).toBeInstanceOf(FreebuffSessionError)
    expect((failure as FreebuffSessionError).kind).toBe('slot_held')
    expect((failure as Error).message).toContain('no longer live')
  })

  test('releases nothing, so the host keeps its session', async () => {
    const sessions = createHostedSessions(() => held)

    await sessions.forModel('glm/5.3')
    await sessions.release()

    // Still the host's, and still usable: the ownership rule `client.ts` states by leaving
    // `close` off an injected host, asserted here at the other end.
    await expect(sessions.forModel('glm/5.3')).resolves.toMatchObject({
      instanceId: 'inst-cli',
    })
  })
})

describe('session endpoint paths', () => {
  test('are the shared constants, so a rename upstream is a visible diff here', () => {
    expect(ADMISSION_PATH).toBe('/api/v1/freebuff/session/admission')
    expect(SESSION_PATH).toBe('/api/v1/freebuff/session')
    expect(INSTANCE_HEADER).toBe('x-freebuff-instance-id')
    expect(MODEL_HEADER).toBe('x-freebuff-model')
    expect(WALLET_SPEND_LIMIT_HEADER).toBe('x-freebuff-wallet-spend-limit')
  })
})
