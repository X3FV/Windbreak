import { afterEach, describe, expect, test } from 'bun:test'

import { createBudgetGovernor } from '../budget'
import { createProgramContext } from './program-context'
import { readCandidatesForTriage } from './persist'
import { runPipeline } from './run'
import { createFakeInvoker, seedState, candidateState, candidateTriage } from './test-support'

import type { SeededState } from './test-support'

let seeded: SeededState | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
})

const run = async (
  state: SeededState,
  invoker: Parameters<typeof runPipeline>[0]['invoker'],
  overrides: Partial<Parameters<typeof runPipeline>[0]> = {},
) =>
  runPipeline({
    db: state.db,
    runId: state.runId,
    targetId: state.targetId,
    candidates: readCandidatesForTriage(state.db, state.runId),
    invoker,
    programContext: createProgramContext(state.db, state.targetId),
    log: () => {},
    ...overrides,
  })

const alwaysReal = () =>
  createFakeInvoker({
    respond: (call) =>
      call.role === 'triage'
        ? { label: 'likely-real', rationale: 'looks real' }
        : { verdict: 'real', reasoning: 'real', preconditions: [] },
  })

describe('runPipeline rediscovery (§4.2 lookup 3)', () => {
  test('routes a candidate away from models when an advisory names its file', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/http.c' }],
      knownVulns: [
        { vulnId: 'GHSA-known-1111', summary: 'out-of-bounds write in src/http.c' },
      ],
    })

    const invoker = alwaysReal()
    const result = await run(seeded, invoker)

    expect(result.rediscovery).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('rediscovery')
    expect(candidateTriage(seeded.db, 'cand-1')).toBeNull()
    // The point of the check: no model budget was spent on it.
    expect(invoker.calls).toHaveLength(0)
    expect(result.triage.processed).toBe(0)
    expect(result.verification.verified).toBe(0)
  })

  test('records the reason on the candidate', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/http.c' }],
      knownVulns: [
        { vulnId: 'GHSA-known-1111', summary: 'oob write in src/http.c' },
      ],
    })

    await run(seeded, alwaysReal())

    const match = seeded.db
      .query<{ osv_match_json: string | null }, []>(
        `SELECT osv_match_json FROM candidates WHERE id = 'cand-1'`,
      )
      .get()
    expect(match?.osv_match_json).toContain('GHSA-known-1111')
    expect(match?.osv_match_json).toContain('file-path:src/http.c')
  })

  test('does not mark a rediscovery on a shared CWE alone', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/unrelated.c', cwe: 'CWE-120' }],
      knownVulns: [
        { vulnId: 'GHSA-other-2222', summary: 'buffer overflow', details: 'a CWE-120 issue' },
      ],
    })

    const invoker = alwaysReal()
    const result = await run(seeded, invoker)

    expect(result.rediscovery).toBe(0)
    expect(candidateTriage(seeded.db, 'cand-1')).toBe('likely-real')
    expect(invoker.calls.length).toBeGreaterThan(0)
  })

  test('a refresh failure warns and still matches the recorded set', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/http.c' }],
      knownVulns: [{ vulnId: 'GHSA-1', summary: 'issue in src/http.c' }],
    })

    const result = await run(seeded, alwaysReal(), {
      refreshKnownVulns: async () => {
        throw new Error('OSV unreachable')
      },
    })

    expect(result.rediscovery).toBe(1)
    expect(result.warnings.join(' ')).toMatch(/OSV refresh for rediscovery failed/)
  })

  test('a refresh contributes new records to the match set', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/newfile.c' }],
      knownVulns: [],
    })

    const result = await run(seeded, alwaysReal(), {
      refreshKnownVulns: async () => [
        { vulnId: 'GHSA-fresh', aliases: [], summary: 'flaw in src/newfile.c', details: null },
      ],
    })

    expect(result.rediscovery).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('rediscovery')
  })
})

describe('runPipeline end to end', () => {
  test('triages then verifies a likely-real candidate to confirmed', async () => {
    seeded = seedState({ candidates: [{ id: 'cand-1', filePath: 'src/a.c' }] })

    const result = await run(seeded, alwaysReal())

    expect(result.triage.byLabel['likely-real']).toBe(1)
    expect(result.verification.byDisposition['likely-real']).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('confirmed')
    expect(result.summary.candidates).toBe(1)
    expect(result.summary.verdicts).toBe(3) // triage + proposer + refuter
  })

  test('a likely-noise candidate never reaches verification', async () => {
    seeded = seedState({ candidates: [{ id: 'cand-1' }] })

    const invoker = createFakeInvoker({
      respond: () => ({ label: 'likely-noise', rationale: 'false positive' }),
    })
    const result = await run(seeded, invoker)

    expect(result.verification.verified).toBe(0)
    expect(candidateState(seeded.db, 'cand-1')).toBe('triaged')
    // Only the triage call happened.
    expect(invoker.calls.map((call) => call.role)).toEqual(['triage'])
  })

  test('a needs-context candidate is still forwarded to verification', async () => {
    seeded = seedState({
      candidates: [{ id: 'cand-1', filePath: 'src/a.c', startLine: 4 }],
      symbols: [{ filePath: 'src/a.c', name: 'copy', startLine: 2, endLine: 5 }],
    })

    const invoker = createFakeInvoker({
      respond: (call) => {
        if (call.role === 'triage') {
          return { label: 'needs-context', rationale: 'not enough context' }
        }
        return { verdict: 'real', reasoning: 'real', preconditions: [] }
      },
    })

    const result = await run(seeded, invoker)

    expect(result.verification.verified).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('confirmed')
  })

  test('an abort during triage stops the pipeline before verification', async () => {
    seeded = seedState({ candidates: [{ id: 'cand-1' }] })

    let reads = 0
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 0.1, verification: 0.4 },
      now: () => (reads++ === 0 ? 0 : 500_000),
      decide: async () => ({ action: 'abort', decidedBy: 'human' }),
    })

    const invoker = alwaysReal()
    const result = await run(seeded, invoker, { governor })

    expect(result.stoppedBy).toBe('budget-abort')
    expect(result.triage.stoppedBy).toBe('budget-abort')
    expect(result.verification.verified).toBe(0)
    expect(invoker.calls).toHaveLength(0)
    expect(result.warnings.join(' ')).toMatch(/verification did not run/)
  })

  test('a degrade during triage still lets verification run on what was labelled', async () => {
    seeded = seedState({ candidates: [{ id: 'cand-1' }] })

    // First stage clock read starts triage, later reads blow the triage quota;
    // verification gets its own stage clock so it is not already spent.
    const times = [0, 500_000, 500_000, 500_000]
    let reads = 0
    const governor = createBudgetGovernor({
      totalSeconds: 10_000,
      shares: { triage: 0.001, verification: 0.4 },
      now: () => times[Math.min(reads++, times.length - 1)]!,
      decide: async () => ({ action: 'degrade', decidedBy: 'policy:--yes' }),
    })

    const invoker = alwaysReal()
    const result = await run(seeded, invoker, { governor })

    expect(result.triage.stoppedBy).toBe('budget-degrade')
    expect(result.verification.verified).toBe(0)
    expect(result.summary.candidates).toBe(1)
  })

  test('surfaces unreadable evidence without pretending it was checked', async () => {
    seeded = seedState({ candidates: [{ id: 'cand-1' }] })
    seeded.db
      .prepare(`UPDATE candidates SET normalized_json = 'not json' WHERE id = 'cand-1'`)
      .run()

    const invoker = alwaysReal()
    const result = await run(seeded, invoker)

    expect(result.triage.failed).toBe(1)
    expect(invoker.calls).toHaveLength(0)
    expect(result.warnings.join(' ')).toMatch(/unreadable/)
  })
})
