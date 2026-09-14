import { describe, expect, test } from 'bun:test'

import { createConversationBudget } from './conversation'
import { DEFAULT_MAX_CONVERSATION_CALLS } from './limits'

describe('the per-conversation budget', () => {
  test('charges what the provider reported', () => {
    const budget = createConversationBudget({ maxCalls: 10 })

    expect(budget.state()).toEqual({
      calls: 0,
      limit: 10,
      turns: 0,
      tokens: 0,
      exhausted: false,
      remaining: 10,
    })

    const after = budget.charge({ calls: 3, tokens: 1500 })
    expect(after.calls).toBe(3)
    expect(after.turns).toBe(1)
    expect(after.tokens).toBe(1500)
    expect(after.remaining).toBe(7)
    expect(after.exhausted).toBe(false)
  })

  test('an unreported turn costs one call, never zero', () => {
    // The whole point of the floor. A fake client reports nothing, and a ceiling that
    // charged zero for such a turn would be wrong in the one direction a ceiling must
    // never be wrong in: it would let an un-metered conversation run forever.
    const budget = createConversationBudget({ maxCalls: 3 })

    budget.charge({ calls: 0, tokens: 0 })
    expect(budget.state().calls).toBe(1)
    expect(budget.state().turns).toBe(1)
  })

  test('a negative or non-finite report is unreported, not a credit', () => {
    const budget = createConversationBudget({ maxCalls: 10 })
    budget.charge({ calls: 5, tokens: 100 })

    budget.charge({ calls: -4, tokens: -10 })
    budget.charge({ calls: Number.NaN, tokens: Number.NaN })

    // Two turns, floored to one call each; the negative reports must not subtract.
    expect(budget.state().calls).toBe(7)
    expect(budget.state().turns).toBe(3)
    expect(budget.state().tokens).toBe(100)
  })

  test('the ceiling is reached at the limit, not after it', () => {
    const budget = createConversationBudget({ maxCalls: 4 })

    budget.charge({ calls: 4, tokens: 0 })
    expect(budget.exhausted()).toBe(true)
    expect(budget.remaining()).toBe(0)
    expect(budget.state().exhausted).toBe(true)
  })

  test('a turn that overshoots leaves remaining at zero rather than negative', () => {
    const budget = createConversationBudget({ maxCalls: 5 })
    budget.charge({ calls: 9, tokens: 0 })

    expect(budget.state().calls).toBe(9)
    expect(budget.state().remaining).toBe(0)
  })

  test('the default is §20.29.6s ceiling, and a broken one falls back to it', () => {
    // A zero or NaN ceiling is not a ceiling, it is a pane that refuses every question —
    // so it is treated as "not set" rather than honoured.
    expect(createConversationBudget().limit).toBe(DEFAULT_MAX_CONVERSATION_CALLS)
    expect(createConversationBudget({ maxCalls: 0 }).limit).toBe(DEFAULT_MAX_CONVERSATION_CALLS)
    expect(createConversationBudget({ maxCalls: Number.NaN }).limit).toBe(
      DEFAULT_MAX_CONVERSATION_CALLS,
    )
    expect(createConversationBudget({ maxCalls: 2.7 }).limit).toBe(2)
  })

  test('one budget spans both modes', () => {
    // §20.29.6 asks whether a hunt and an explain share a ceiling. They do: two counters
    // would meet the same spend through different doors, and alternating modes would buy
    // twice the ceiling. Nothing in the budget knows which mode charged it.
    const budget = createConversationBudget({ maxCalls: 6 })

    budget.charge({ calls: 4, tokens: 0 })
    expect(budget.exhausted()).toBe(false)

    budget.charge({ calls: 2, tokens: 0 })
    expect(budget.exhausted()).toBe(true)
  })
})
