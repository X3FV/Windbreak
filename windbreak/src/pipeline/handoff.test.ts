import { afterEach, describe, expect, test } from 'bun:test'

import { createProgramContext } from './program-context'
import { readCandidatesForTriage } from './persist'
import { createFakeInvoker, seedState } from './test-support'
import { HANDOFFS, HANDOFF_STAGES } from './handoffs'
import {
  decodeRequest,
  encodeRequest,
  MalformedRequestError,
  splitStageOptions,
} from './handoff'
import { runTriage } from './triage'
import { runVerification } from './verify'

import type { SeededState } from './test-support'
import type { Handoff } from './handoff'
import type { TriageRequest, TriageServices } from './triage'
import type { VerificationRequest, VerificationServices } from './verify'

let seeded: SeededState | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
})

describe('the request codec', () => {
  test('round-trips a request with nested arrays and objects', () => {
    interface NestedRequest {
      runId: string
      candidates: readonly {
        id: string
        ranges: readonly { startLine: number; endLine: number }[]
        injectionSignals: readonly string[]
      }[]
      cacheDisabled: boolean
      enrich?: boolean
    }

    const request: NestedRequest = {
      runId: 'run-1',
      candidates: [
        { id: 'c1', ranges: [{ startLine: 3, endLine: 9 }], injectionSignals: ['a'] },
        { id: 'c2', ranges: [], injectionSignals: [] },
      ],
      cacheDisabled: true,
    }

    expect(decodeRequest<NestedRequest>(encodeRequest(request))).toEqual(request)
  })

  test('drops undefined rather than carrying it, which is what a pipe would do', () => {
    // Not a detail: an optional field written as an explicit `undefined` and the
    // same field absent must arrive identically, or a codec becomes the reason
    // two otherwise-identical requests hash differently.
    const encoded = encodeRequest({ runId: 'r', enrich: undefined } as { runId: string; enrich?: boolean })

    expect(encoded).toBe('{"runId":"r"}')
    expect('enrich' in (decodeRequest(encoded) as object)).toBe(false)
  })

  test('rejects a payload that is not JSON with a typed error', () => {
    expect(() => decodeRequest('{not json')).toThrow(MalformedRequestError)
  })

  test('rejects JSON that is not an object', () => {
    // A request is an object by construction; a bare `null` or `[1,2]` would
    // otherwise be cast to one and fail somewhere far away from the cause.
    for (const payload of ['null', '[1,2]', '3', '"text"', 'true']) {
      expect(() => decodeRequest(payload)).toThrow(MalformedRequestError)
    }
  })

  test('names what it received when the payload is the wrong shape', () => {
    expect(() => decodeRequest('[1,2]')).toThrow(/must be a JSON object, received an array/)
    expect(() => decodeRequest('7')).toThrow(/must be a JSON object, received number/)
  })
})

describe('the handoff registry', () => {
  test('covers every stage this seam claims', () => {
    expect([...HANDOFF_STAGES].sort()).toEqual([
      'engines',
      'osv',
      'patch-mine',
      'pattern-capture',
      'pipeline',
      'recon',
      'rediscovery',
      'report',
      'toctou',
      'triage',
      'variant-hunting',
      'verification',
    ])
  })

  test('every stage declares both halves, and no key is in both', () => {
    for (const [id, handoff] of Object.entries(HANDOFFS) as [string, Handoff][]) {
      expect(handoff.stage).toBe(id)
      expect(handoff.requestKeys.length).toBeGreaterThan(0)
      expect(handoff.serviceKeys.length).toBeGreaterThan(0)

      // A key in both halves would make the split ambiguous, and the intersection
      // would hide it: the field would be serialized *and* re-injected.
      const overlap = handoff.requestKeys.filter((key) => handoff.serviceKeys.includes(key))
      expect(overlap).toEqual([])
    }
  })

  test('no key is declared twice within a half', () => {
    for (const handoff of Object.values(HANDOFFS) as Handoff[]) {
      expect(new Set(handoff.requestKeys).size).toBe(handoff.requestKeys.length)
      expect(new Set(handoff.serviceKeys).size).toBe(handoff.serviceKeys.length)
    }
  })
})

describe('splitting a real stage', () => {
  test('triage splits along its declared keys, and the request survives a pipe', () => {
    seeded = seedState({})
    const invoker = createFakeInvoker({
      respond: () => ({ label: 'likely-real', rationale: 'fixture' }),
    })

    const options = {
      db: seeded.db,
      runId: seeded.runId,
      candidates: readCandidatesForTriage(seeded.db, seeded.runId),
      invoker,
      programContext: createProgramContext(seeded.db, seeded.targetId),
      log: () => {},
      now: () => 1_700_000_000_000,
    }

    const { request, services } = splitStageOptions<TriageRequest, TriageServices>(
      HANDOFFS.triage,
      options,
    )

    // The request half is exactly the declared keys and nothing else.
    expect(Object.keys(request).sort()).toEqual(
      [...HANDOFFS.triage.requestKeys].filter((key) => key in options).sort(),
    )

    // The services half is what must be re-injected on the far side.
    expect(Object.keys(services).sort()).toEqual(
      [...HANDOFFS.triage.serviceKeys].filter((key) => key in options).sort(),
    )

    // The claim §20.17.3 makes: the request half crosses a pipe intact.
    const decoded = decodeRequest<TriageRequest>(encodeRequest(request))
    expect(decoded.runId).toBe(seeded.runId)
    expect(decoded.candidates).toEqual(options.candidates)
  })

  test('no host handle reaches the serialized payload', () => {
    seeded = seedState({})
    const invoker = createFakeInvoker({
      respond: () => ({ label: 'likely-real', rationale: 'fixture' }),
    })

    const { request } = splitStageOptions<TriageRequest, TriageServices>(HANDOFFS.triage, {
      db: seeded.db,
      runId: seeded.runId,
      candidates: readCandidatesForTriage(seeded.db, seeded.runId),
      invoker,
      log: () => {},
    })

    // The failing mode this guards: a `Database` stringifies to `{}`, so an
    // accidental inclusion would not throw — it would silently send an empty
    // object and the far side would fail on a missing table much later.
    const payload = encodeRequest(request)
    expect(payload).not.toContain('"db"')
    expect(payload).not.toContain('"invoker"')
    expect(payload).not.toContain('"log"')
    expect(payload).not.toContain('undefined')
  })

  test('the split is not specific to triage — verification splits the same way', () => {
    seeded = seedState({})
    const invoker = createFakeInvoker({
      respond: (call) => ({
        verdict: 'real',
        reasoning: `${call.role} says real`,
        preconditions: ['attacker controls src'],
      }),
    })

    const { request, services } = splitStageOptions<VerificationRequest, VerificationServices>(
      HANDOFFS.verification,
      {
        db: seeded.db,
        runId: seeded.runId,
        candidates: readCandidatesForTriage(seeded.db, seeded.runId),
        invoker,
        programContext: createProgramContext(seeded.db, seeded.targetId),
        log: () => {},
      },
    )

    expect(Object.keys(request).sort()).toEqual(['candidates', 'runId'])
    expect(Object.keys(services).sort()).toEqual([
      'db',
      'invoker',
      'log',
      'programContext',
    ])
  })
})

describe('the split stage is still the stage it was', () => {
  test('options assembled as an intersection run triage unchanged', async () => {
    // The seam's own claim is that it changed nothing about how a stage is
    // called. An options object written exactly the way it was written before
    // the split must still drive the real stage to a real verdict.
    seeded = seedState({})
    const invoker = createFakeInvoker({
      respond: () => ({ label: 'likely-real', rationale: 'fixture' }),
    })

    const result = await runTriage({
      db: seeded.db,
      runId: seeded.runId,
      candidates: readCandidatesForTriage(seeded.db, seeded.runId),
      invoker,
      programContext: createProgramContext(seeded.db, seeded.targetId),
      log: () => {},
    })

    expect(result.byLabel['likely-real']).toBeGreaterThan(0)
  })

  test('the request half alone is not enough to run a stage', () => {
    // Guards the boundary from the other side: the split must be *load-bearing*,
    // not cosmetic. If `RunTriageOptions` were still assignable from the request
    // half, the services would be documented rather than required and a worker
    // call could omit them and still typecheck.
    type RequestOnly = Parameters<typeof runTriage>[0] extends { db: unknown }
      ? 'services-required'
      : 'services-optional'

    const requirement: RequestOnly = 'services-required'
    expect(requirement).toBe('services-required')
  })

  test('verification keeps its services required too', () => {
    type Requires = Parameters<typeof runVerification>[0] extends { invoker: unknown }
      ? 'yes'
      : 'no'

    const requirement: Requires = 'yes'
    expect(requirement).toBe('yes')
  })
})
