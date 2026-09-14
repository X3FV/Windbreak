/**
 * Stage budget guard for the pipeline (spec §9).
 *
 * The governor exposes per-stage quotas and records an overrun decision, but it
 * does not implement §9.1's "continue (extends quota, borrowing from remaining
 * stages)" — its session keeps reporting the original quota. A stage that works
 * in *units* (an engine, one candidate) would therefore re-prompt for every
 * remaining unit after a single `continue`.
 *
 * This wrapper tracks the borrowed extension locally so `continue` means what
 * §9.1 says it means: keep going until the next decision point. The governor is
 * still the thing that asks and records; nothing here writes state.
 */

import { formatSeconds } from '../budget'

import type { BudgetGovernor, StageName } from '../budget'

export type BudgetGate = 'ok' | 'budget-degrade' | 'budget-abort'

export interface StageBudget {
  readonly stage: StageName
  /** This stage's quota from the governor, in seconds. */
  readonly quotaSeconds: number
  /**
   * Ask whether the next unit may start, prompting on overrun. Returns the
   * governor's decision; `budget-degrade` and `budget-abort` both mean stop.
   */
  gate(minimumMs: number): Promise<BudgetGate>
  /** Milliseconds available for the next unit, including any borrowed quota. */
  remainingMs(): number
}

export const createStageBudget = (
  stage: StageName,
  governor: BudgetGovernor | undefined,
): StageBudget => {
  if (!governor) {
    return {
      stage,
      quotaSeconds: 0,
      async gate() {
        return 'ok'
      },
      remainingMs: () => Number.MAX_SAFE_INTEGER,
    }
  }

  const session = governor.session(stage)
  let borrowedMs = 0

  const remainingMs = (): number => session.remainingMs() + borrowedMs

  return {
    stage,
    quotaSeconds: session.quotaSeconds,
    remainingMs,

    async gate(minimumMs) {
      if (remainingMs() >= minimumMs) return 'ok'

      const action = await governor.resolveOverrun(stage, session.elapsedSeconds())
      if (action === 'abort') return 'budget-abort'
      if (action === 'degrade') return 'budget-degrade'

      // `continue`: borrow another full stage quota so the next unit can run and
      // the human is not asked again immediately.
      borrowedMs += session.quotaSeconds * 1000
      return 'ok'
    },
  }
}

export const describeStopped = (
  budget: StageBudget,
  action: Exclude<BudgetGate, 'ok'>,
  remainingUnits: number,
): string =>
  `${budget.stage} stopped at the budget governor's ${
    action === 'budget-abort' ? 'abort' : 'degrade'
  } decision; ${remainingUnits} item(s) were not processed. ` +
  `Stage quota was ${formatSeconds(budget.quotaSeconds)}.`
