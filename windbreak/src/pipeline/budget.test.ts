import { describe, expect, test } from 'bun:test'

import { createBudgetGovernor } from '../budget'
import { createStageBudget, describeStopped } from './budget'

/** Deterministic clock: the first read starts the stage, later reads advance it. */
const clockOf = (...values: number[]) => {
  let reads = 0
  return () => values[Math.min(reads++, values.length - 1)]!
}

describe('createStageBudget', () => {
  test('without a governor everything is allowed', async () => {
    const budget = createStageBudget('triage', undefined)

    expect(await budget.gate(0)).toBe('ok')
    expect(budget.remainingMs()).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('allows work while quota remains, without asking', async () => {
    let asked = 0
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 0.5 },
      now: clockOf(0, 0),
      decide: async () => {
        asked += 1
        return { action: 'degrade', decidedBy: 'policy:--yes' }
      },
    })

    const budget = createStageBudget('triage', governor)
    expect(budget.quotaSeconds).toBe(50)
    expect(await budget.gate(1_000)).toBe('ok')
    expect(asked).toBe(0)
  })

  test('asks the governor once the quota is spent and honours degrade', async () => {
    // Stage starts at 0; every later read is past the 50s quota.
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 0.5 },
      now: clockOf(0, 200_000),
      decide: async () => ({ action: 'degrade', decidedBy: 'policy:--yes' }),
    })

    const budget = createStageBudget('triage', governor)
    expect(await budget.gate(1_000)).toBe('budget-degrade')
  })

  test('honours abort', async () => {
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 0.5 },
      now: clockOf(0, 200_000),
      decide: async () => ({ action: 'abort', decidedBy: 'human' }),
    })

    expect(await createStageBudget('triage', governor).gate(1_000)).toBe('budget-abort')
  })

  test('continue borrows a fresh quota so the human is not asked again immediately', async () => {
    let decisions = 0
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 0.1 },
      now: clockOf(0, 200_000),
      decide: async () => {
        decisions += 1
        return { action: 'continue', decidedBy: 'human' }
      },
    })

    const budget = createStageBudget('triage', governor)

    expect(await budget.gate(1_000)).toBe('ok')
    expect(decisions).toBe(1)
    // The borrower now has a full quota again, so the next unit is allowed
    // without another prompt.
    expect(await budget.gate(1_000)).toBe('ok')
    expect(decisions).toBe(1)
  })
})

describe('describeStopped', () => {
  test('names the stage, the action, and how much was left', () => {
    const budget = createStageBudget('verification', undefined)
    const message = describeStopped({ ...budget, quotaSeconds: 1440 }, 'budget-degrade', 12)

    expect(message).toContain('verification')
    expect(message).toContain('degrade')
    expect(message).toContain('12 item(s)')
    expect(message).toContain('24m00s')
  })
})

describe('stage budget never asks while quota remains', () => {
  test('a decider that would throw is not called', async () => {
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { triage: 1 },
      now: clockOf(0, 0),
      decide: async () => {
        throw new Error('should not be asked')
      },
    })

    expect(await createStageBudget('triage', governor).gate(1_000)).toBe('ok')
  })
})
