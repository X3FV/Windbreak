import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createProgramContext, readCandidate } from '../pipeline'
import { createFakeInvoker } from '../pipeline/test-support'
import { capturePattern, evidenceTierFor } from './capture'
import { parseFingerprint } from './fingerprint'
import { readLibrary } from './store'
import { defaultNormalized, seedLibraryState, unboundedCopyFingerprint } from './test-support'

import type { Database } from 'bun:sqlite'
import type { CandidateRecord } from '../pipeline'

let db: Database

const FINGERPRINT = unboundedCopyFingerprint

/** What the synthesis schema expects: the body, with no `kind` discriminator. */
const FINGERPRINT_BODY = {
  scope: FINGERPRINT.scope,
  cwe: FINGERPRINT.cwe,
  summary: FINGERPRINT.summary,
  languages: FINGERPRINT.languages,
  requireCalls: FINGERPRINT.requireCalls,
  requireAnyCalls: FINGERPRINT.requireAnyCalls,
  forbidCalls: FINGERPRINT.forbidCalls,
  order: FINGERPRINT.order,
}

const confirmedNormalized = () =>
  defaultNormalized({ filePath: 'src/handler.c', startLine: 5, endLine: 5 })

const seed = (input: {
  state?: string
  evidenceTier?: string | null
  normalizedJson?: string
}) =>
  seedLibraryState({
    targets: [
      {
        id: 'target-a',
        commitSha: 'aaaaaaaa',
        functions: [{ filePath: 'src/handler.c', name: 'parse_header', startLine: 3, endLine: 7 }],
        refs: [
          { filePath: 'src/handler.c', name: 'strcpy', line: 5 },
          { filePath: 'src/handler.c', name: 'strlen', line: 6 },
        ],
      },
    ],
    candidates: [
      {
        id: 'cand-a1',
        targetId: 'target-a',
        state: input.state ?? 'confirmed',
        filePath: 'src/handler.c',
        startLine: 5,
        normalizedJson: input.normalizedJson ?? confirmedNormalized(),
      },
    ],
    findings:
      input.evidenceTier === null
        ? []
        : [{ candidateId: 'cand-a1', evidenceTier: input.evidenceTier ?? 'human-reproduced' }],
  })

const invoker = () => createFakeInvoker({ respond: () => FINGERPRINT_BODY })

const capture = async (overrides: {
  candidate?: CandidateRecord
  db?: Database
  fingerprint?: unknown
  useInvoker?: boolean
  postImageTargetId?: string
}) => {
  const database = overrides.db ?? db
  const candidate = overrides.candidate ?? readCandidate(database, 'cand-a1')!

  return capturePattern({
    db: database,
    candidate,
    programContext: createProgramContext(database, candidate.targetId),
    ...(overrides.useInvoker === false
      ? { fingerprint: parseFingerprint(overrides.fingerprint ?? FINGERPRINT) }
      : { invoker: invoker() }),
    ...(overrides.postImageTargetId ? { postImageTargetId: overrides.postImageTargetId } : {}),
  })
}

afterEach(() => db.close())

describe('capturePattern — the confirmation gate', () => {
  test('refuses a candidate that did not survive verification', async () => {
    db = seed({ state: 'triaged' }).db

    const result = await capture({ useInvoker: false })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('triaged')
    expect(result.error).toContain('confirmed')
    expect(readLibrary(db)).toEqual([])
  })

  test('refuses a dropped candidate by name', async () => {
    db = seed({ state: 'dropped' }).db

    expect((await capture({ useInvoker: false })).error).toContain('"dropped"')
  })
})

describe('capturePattern — the D15 gate', () => {
  test('a human-reproduced finding stores a confirmed pattern', async () => {
    db = seed({ evidenceTier: 'human-reproduced' }).db

    const result = await capture({ useInvoker: false })

    expect(result.ok).toBe(true)
    expect(result.condition).toBe('confirmed')
    expect(result.evidenceTier).toBe('human-reproduced')
    expect(result.warnings).toEqual([])
  })

  test('a statically-verified finding stores an unconfirmed pattern and warns', async () => {
    db = seed({ evidenceTier: 'statically-verified' }).db

    const result = await capture({ useInvoker: false })

    expect(result.ok).toBe(true)
    expect(result.condition).toBe('unconfirmed')
    expect(result.warnings.join(' ')).toContain('--allow-statically-verified')
  })

  test('no recorded tier stores unconfirmed and says reporting has not run', async () => {
    db = seed({ evidenceTier: null }).db

    const result = await capture({ useInvoker: false })

    expect(result.condition).toBe('unconfirmed')
    expect(result.warnings.join(' ')).toContain('report --reproduced')
    // The finding id is still recorded, derived the same way reporting derives it.
    expect(result.entry?.findingId).toMatch(/^find_/)
  })

  test('the tier is read from findings, never asserted at capture time', async () => {
    const state = seed({ evidenceTier: 'human-reproduced' })
    db = state.db

    expect(evidenceTierFor(db, 'cand-a1')).toEqual({
      findingId: 'find_cand-a1',
      evidenceTier: 'human-reproduced',
    })
    expect(evidenceTierFor(db, 'cand-missing')).toBeNull()
  })
})

describe('capturePattern — origin validation', () => {
  test('refuses a fingerprint that cannot reproduce its own finding', async () => {
    db = seed({}).db

    const result = await capture({
      useInvoker: false,
      fingerprint: { ...FINGERPRINT, requireCalls: ['gets'] },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not match')
    expect(result.error).toContain('dropped, not tuned')
    expect(readLibrary(db)).toEqual([])
  })

  test('records a file-scoped site with no function name, and can find it again', async () => {
    db = seed({}).db

    const result = await capture({
      useInvoker: false,
      fingerprint: { ...FINGERPRINT, scope: 'file' },
    })

    expect(result.ok).toBe(true)
    expect(result.originSite).toEqual({
      filePath: 'src/handler.c',
      functionName: null,
      line: 5,
    })
  })

  test('records the origin site and the pre-image hit count', async () => {
    db = seed({}).db

    const result = await capture({ useInvoker: false })

    expect(result.originSite).toEqual({
      filePath: 'src/handler.c',
      functionName: 'parse_header',
      line: 5,
    })
    expect(result.preImageHits).toBe(1)
    expect(result.postImageClean).toBeNull()
  })

  test('refuses a fingerprint that also matches the post-image', async () => {
    const state = seedLibraryState({
      targets: [
        {
          id: 'target-a',
          commitSha: 'aaaaaaaa',
          functions: [{ filePath: 'src/handler.c', name: 'parse_header', startLine: 3, endLine: 7 }],
          refs: [
            { filePath: 'src/handler.c', name: 'strcpy', line: 5 },
            { filePath: 'src/handler.c', name: 'strlen', line: 6 },
          ],
        },
        {
          id: 'target-fixed',
          files: [{ path: 'src/handler.c', language: 'c' }],
          functions: [{ filePath: 'src/handler.c', name: 'parse_header', startLine: 3, endLine: 7 }],
          refs: [{ filePath: 'src/handler.c', name: 'strcpy', line: 5 }],
        },
      ],
      candidates: [{ id: 'cand-a1', targetId: 'target-a', state: 'confirmed' }],
      findings: [{ candidateId: 'cand-a1', evidenceTier: 'human-reproduced' }],
    })
    db = state.db

    const result = await capture({ useInvoker: false, postImageTargetId: 'target-fixed' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('post-image')
  })
})

describe('capturePattern — synthesis path', () => {
  test('stores the fingerprint the model returned', async () => {
    db = seed({}).db

    const result = await capture({})

    expect(result.ok).toBe(true)
    expect(result.source).toBe('synthesis')
    expect(result.cached).toBe(false)
    expect(result.entry?.modelId).toBe('checker-synth-model')
    expect(result.entry?.promptTemplateVersion).toBe('windbreak-checker-synth-v1')
    expect(result.fingerprint?.requireCalls).toEqual(['strcpy'])
  })

  test('refuses when synthesis fails, storing nothing', async () => {
    db = seed({}).db
    const candidate = readCandidate(db, 'cand-a1')!

    const result = await capturePattern({
      db,
      candidate,
      programContext: createProgramContext(db, candidate.targetId),
      invoker: createFakeInvoker({ respond: () => new Error('provider down') }),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('provider down')
    expect(readLibrary(db)).toEqual([])
  })

  test('refuses a synthesized fingerprint the schema rejects', async () => {
    db = seed({}).db
    const candidate = readCandidate(db, 'cand-a1')!

    const result = await capturePattern({
      db,
      candidate,
      programContext: createProgramContext(db, candidate.targetId),
      // Vacuous: no positive predicate.
      invoker: createFakeInvoker({
        respond: () => ({ ...FINGERPRINT, requireCalls: [], requireAnyCalls: [] }),
      }),
    })

    expect(result.ok).toBe(false)
    // The invoke layer validates against the same schema, so a vacuous
    // fingerprint never reaches capture as a usable value.
    expect(result.error).toContain('synthesis failed')
    expect(readLibrary(db)).toEqual([])
  })
})

describe('capturePattern — idempotence', () => {
  test('a second capture of the same pattern reports it as already present', async () => {
    db = seed({}).db

    const first = await capture({ useInvoker: false })
    const second = await capture({ useInvoker: false })

    expect(first.alreadyPresent).toBe(false)
    expect(second.alreadyPresent).toBe(true)
    expect(second.checkerId).toBe(first.checkerId)
    expect(readLibrary(db)).toHaveLength(1)
  })

  test('re-adding after a recorded reproduction promotes the gate', async () => {
    const state = seed({ evidenceTier: 'statically-verified' })
    db = state.db

    const first = await capture({ useInvoker: false })
    expect(first.condition).toBe('unconfirmed')

    // The researcher reproduces it outside WindBreak and reporting records the
    // stronger tier. Re-adding must promote the pattern, not shrug.
    db.prepare('UPDATE findings SET evidence_tier = ? WHERE candidate_id = ?').run(
      'human-reproduced',
      'cand-a1',
    )

    const second = await capture({ useInvoker: false })

    expect(second.alreadyPresent).toBe(true)
    expect(second.condition).toBe('confirmed')
    expect(second.warnings.join(' ')).toContain('promoted')
    expect(readLibrary(db)[0]!.condition).toBe('confirmed')
  })

  test('an edited fingerprint becomes a second library entry', async () => {
    db = seed({}).db

    await capture({ useInvoker: false })
    await capture({
      useInvoker: false,
      fingerprint: { ...FINGERPRINT, summary: 'unbounded copy, terser summary' },
    })

    expect(readLibrary(db)).toHaveLength(2)
  })
})
