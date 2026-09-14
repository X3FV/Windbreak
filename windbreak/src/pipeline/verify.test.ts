import { afterEach, describe, expect, test } from 'bun:test'

import { createBudgetGovernor } from '../budget'
import { DEFAULT_MODEL_CONFIG } from '../models'
import { recordInvestigatorTurn } from '../investigate/persist'
import { createProgramContext } from './program-context'
import { readAdjudicationQueue, readCandidatesForVerification } from './persist'

import { createFakeInvoker, seedState, candidateState, verdictCount } from './test-support'
import { runVerification } from './verify'

import type { SeededState } from './test-support'

let seeded: SeededState | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
})

/** Seed one candidate that has passed triage, so verification has input. */
const triagedState = (triage = 'likely-real'): SeededState => {
  const state = seedState({
    candidates: [{ id: 'cand-1', filePath: 'src/a.c', startLine: 4 }],
    symbols: [{ filePath: 'src/a.c', name: 'copy', startLine: 2, endLine: 5 }],
  })
  state.db
    .prepare(`UPDATE candidates SET triage = ?, state = 'triaged' WHERE id = 'cand-1'`)
    .run(triage)
  return state
}

const verifyAll = async (
  state: SeededState,
  invoker: Parameters<typeof runVerification>[0]['invoker'],
  overrides: Partial<Parameters<typeof runVerification>[0]> = {},
) =>
  runVerification({
    db: state.db,
    runId: state.runId,
    candidates: readCandidatesForVerification(state.db, state.runId),
    invoker,
    programContext: createProgramContext(state.db, state.targetId),
    log: () => {},
    ...overrides,
  })

const verdicts = (proposer: 'real' | 'benign', refuter: 'real' | 'benign') =>
  createFakeInvoker({
    respond: (call) => ({
      verdict: call.role === 'proposer' ? proposer : refuter,
      reasoning: `${call.role} says ${call.role === 'proposer' ? proposer : refuter}`,
      preconditions: ['attacker controls src'],
    }),
  })

describe('runVerification disagreement matrix (§5.3)', () => {
  test('real + real -> likely-real, no human queue', async () => {
    seeded = triagedState()
    const result = await verifyAll(seeded, verdicts('real', 'real'))

    expect(result.byDisposition['likely-real']).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('confirmed')
    expect(readAdjudicationQueue(seeded.db, seeded.runId)).toHaveLength(0)
  })

  test('benign + benign -> dropped', async () => {
    seeded = triagedState()
    const result = await verifyAll(seeded, verdicts('benign', 'benign'))

    expect(result.byDisposition.dropped).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('dropped')
    expect(readAdjudicationQueue(seeded.db, seeded.runId)).toHaveLength(0)
  })

  test('real + benign -> escalated with both verdicts recorded', async () => {
    seeded = triagedState()
    const result = await verifyAll(seeded, verdicts('real', 'benign'))

    expect(result.byDisposition.escalated).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('escalated')

    const queue = readAdjudicationQueue(seeded.db, seeded.runId)
    expect(queue).toHaveLength(1)
    expect(queue[0]!.decision).toBeNull()
    expect(queue[0]!.proposerVerdictId).toBeTruthy()
    expect(queue[0]!.refuterVerdictId).toBeTruthy()
    // §5.3 escalation carries both arguments, so the human can adjudicate.
    expect(queue[0]!.proposerReasoning).toContain('real')
    expect(queue[0]!.refuterReasoning).toContain('benign')
  })

  test('benign + real -> also escalated (disagreement is symmetric)', async () => {
    seeded = triagedState()
    const result = await verifyAll(seeded, verdicts('benign', 'real'))

    expect(result.byDisposition.escalated).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('escalated')
    expect(readAdjudicationQueue(seeded.db, seeded.runId)).toHaveLength(1)
  })
})

describe('runVerification trust boundary (§5.1 rule 4)', () => {
  test('both roles receive the identical evidence block', async () => {
    seeded = triagedState()
    const invoker = verdicts('real', 'benign')
    await verifyAll(seeded, invoker)

    const proposer = invoker.calls.find((call) => call.role === 'proposer')!
    const refuter = invoker.calls.find((call) => call.role === 'refuter')!

    const evidenceOf = (prompt: string) => {
      const start = prompt.indexOf('<<<TARGET_CONTENT_UNTRUSTED>>>')
      return prompt.slice(start)
    }

    expect(evidenceOf(proposer.userPrompt)).toBe(evidenceOf(refuter.userPrompt))
    expect(evidenceOf(proposer.userPrompt)).toContain('strcpy(buf, src);')
  })

  test('verification runs both roles for every candidate', async () => {
    seeded = triagedState()
    const invoker = verdicts('real', 'real')
    await verifyAll(seeded, invoker)

    expect(invoker.calls.map((call) => call.role)).toEqual(['proposer', 'refuter'])
  })
})

describe('runVerification failure handling', () => {
  test('a failed proposer call leaves the candidate triaged, not benign', async () => {
    seeded = triagedState()
    const invoker = createFakeInvoker({
      respond: (call) =>
        call.role === 'proposer'
          ? new Error('provider down')
          : { verdict: 'benign', reasoning: 'benign', preconditions: [] },
    })

    const result = await verifyAll(seeded, invoker)

    expect(result.failed).toBe(1)
    expect(result.verified).toBe(0)
    expect(candidateState(seeded.db, 'cand-1')).toBe('triaged')
    expect(readAdjudicationQueue(seeded.db, seeded.runId)).toHaveLength(0)
    expect(result.warnings.join(' ')).toMatch(/not treated as benign/)
  })

  test('an out-of-contract answer is a failure, not a verdict', async () => {
    seeded = triagedState()
    const invoker = createFakeInvoker({
      respond: () => ({ verdict: 'maybe', reasoning: 'unsure', preconditions: [] }),
    })

    const result = await verifyAll(seeded, invoker)

    expect(result.failed).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('triaged')
  })
})

describe('runVerification caching and budget', () => {
  test('a second pass replays both verdicts from cache', async () => {
    seeded = triagedState()
    const first = await verifyAll(seeded, verdicts('real', 'real'))
    expect(first.cached).toBe(0)

    seeded.db
      .prepare(`UPDATE candidates SET state = 'triaged' WHERE id = 'cand-1'`)
      .run()

    const secondInvoker = createFakeInvoker({ respond: () => new Error('unused') })
    const second = await verifyAll(seeded, secondInvoker)

    expect(second.cached).toBe(2)
    expect(secondInvoker.calls).toHaveLength(0)
    expect(candidateState(seeded.db, 'cand-1')).toBe('confirmed')
  })

  test('records one verdict per role per candidate', async () => {
    seeded = triagedState()
    await verifyAll(seeded, verdicts('real', 'benign'))

    expect(verdictCount(seeded.db, 'cand-1')).toBe(2)
  })

  test('stops at the governor before starting a candidate', async () => {
    seeded = triagedState()
    let reads = 0
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { verification: 0.4 },
      now: () => (reads++ === 0 ? 0 : 500_000),
      decide: async () => ({ action: 'abort', decidedBy: 'human' }),
    })

    const invoker = verdicts('real', 'real')
    const result = await verifyAll(seeded, invoker, { governor })

    expect(result.stoppedBy).toBe('budget-abort')
    expect(result.verified).toBe(0)
    expect(invoker.calls).toHaveLength(0)
  })
})

/**
 * §20.29.3's first invariant, asserted where it would break.
 *
 * The investigator is better informed than either verdict role *by construction* — it
 * can read the target and they cannot — so if its answer reached this stage's
 * disposition then `escalated` would stop meaning "the two independent models
 * disagreed" and start meaning "…or a third, better-informed one did". These tests put
 * a recorded investigator answer directly beside a candidate and require the
 * disposition to be the one the two verdicts produce.
 */
describe('an investigator row cannot move a disposition (§20.29.3)', () => {
  const investigatorAnswer = (state: SeededState, answer: string) => {
    recordInvestigatorTurn({
      db: state.db,
      runId: state.runId,
      candidateId: 'cand-1',
      mode: 'explain',
      prompt: 'Is this candidate real?',
      answer,
      model: DEFAULT_MODEL_CONFIG.investigator,
      provider: 'deepseek',
      // A turn that read the target, which is the whole reason it is a threat to the
      // gate: this answer rests on evidence neither verdict role can see.
      toolCalls: [
        { tool: 'read_target_file', signals: [], sourceBytes: 40, truncated: false, error: null },
      ],
    })
  }

  const dispositions = async (
    proposer: 'real' | 'benign',
    refuter: 'real' | 'benign',
    investigator: string | null,
  ) => {
    const state = triagedState()
    try {
      if (investigator !== null) investigatorAnswer(state, investigator)
      const result = await verifyAll(state, verdicts(proposer, refuter))
      return { result, candidate: candidateState(state.db, 'cand-1') }
    } finally {
      state.db.close()
    }
  }

  test('an investigator arguing "real" does not confirm a pair that dropped it', async () => {
    // The tempting direction: the model that read the code says it is real, and the two
    // that could not read it say benign. The two verdicts win.
    seeded = triagedState()
    investigatorAnswer(seeded, 'This is definitely a real vulnerability.')
    const withInvestigator = await verifyAll(seeded, verdicts('benign', 'benign'))

    expect(withInvestigator.byDisposition.dropped).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('dropped')
    expect(readAdjudicationQueue(seeded.db, seeded.runId)).toHaveLength(0)
  })

  test('and an investigator arguing "benign" does not drop a pair that confirmed it', async () => {
    seeded = triagedState()
    investigatorAnswer(seeded, 'Nothing here is exploitable.')
    const withInvestigator = await verifyAll(seeded, verdicts('real', 'real'))

    expect(withInvestigator.byDisposition['likely-real']).toBe(1)
    expect(candidateState(seeded.db, 'cand-1')).toBe('confirmed')
  })

  test('a recorded answer changes nothing, across all three outcomes', async () => {
    // A differential rather than a hardcoded expectation: whatever the two verdicts
    // produce, adding a tool-derived investigator answer must produce the same thing.
    for (const [proposer, refuter] of [
      ['real', 'real'],
      ['benign', 'benign'],
      ['real', 'benign'],
    ] as const) {
      const without = await dispositions(proposer, refuter, null)
      const with_ = await dispositions(proposer, refuter, 'I read the file; I disagree.')

      expect(with_.result.byDisposition).toEqual(without.result.byDisposition)
      expect(with_.result.verified).toBe(without.result.verified)
      expect(with_.candidate).toBe(without.candidate)
    }
  })

  test('the queue is unchanged too, so escalation still means two models split', async () => {
    const without = await dispositions('real', 'benign', null)
    const with_ = await dispositions('real', 'benign', 'Skip the human, it is obvious.')

    expect(with_.result.byDisposition.escalated).toBe(
      without.result.byDisposition.escalated,
    )
    expect(with_.candidate).toBe('escalated')
  })
})
