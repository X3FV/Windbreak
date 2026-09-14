/**
 * The investigator's per-conversation ceiling (spec §20.29.6, §20.29.5 slice 6).
 *
 * Three things in this codebase bound spending and none of them bounds a chat:
 *
 * 1. §9's budget governor divides the *target's* time into per-stage shares. A chat is
 *    not a stage, so it draws nothing from that manifest.
 * 2. The investigator's step ceiling (`DEFAULT_INVESTIGATOR_STEPS`) bounds one *turn*.
 *    Asking fifty times gives fifty fresh ceilings.
 * 3. `investigator_turns` records what was spent but counts nothing and refuses nothing.
 *
 * So something has to count across turns, and the honest unit is the one a provider
 * charges for: a **model call**. A turn is not a unit — an `explain` may be two calls and
 * a hunt fourteen — so counting questions would price them the same.
 *
 * Two properties this module holds deliberately:
 *
 * - **It counts reported calls and floors at one per turn.** A turn that ran made at least
 *   one call even when the provider reported no usage, so a ceiling that charged zero for
 *   an un-metered turn would be wrong in the one direction a ceiling must never be wrong
 *   in. With a reporting provider the count is exact; without one it degrades to "one per
 *   turn", which still bounds the conversation.
 * - **One budget covers both modes.** §20.29.6 asks whether a hunt and an explain share a
 *   ceiling; they do, because two counters would meet the same spend through different
 *   doors and a researcher could alternate modes to get twice the ceiling. The conversation
 *   is what is being bounded, and a hunt and an explain are both what a conversation is
 *   made of.
 *
 * Nothing here is persisted. A conversation is the sitting, not the run — reopening the
 * screen starts a new one — and storing the count would imply a continuity the transcript
 * does not have.
 */

import { DEFAULT_MAX_CONVERSATION_CALLS } from './limits'

/** The budget as a caller reads it, for display and for refusal. */
export interface ConversationBudgetState {
  /** Model calls charged so far. */
  calls: number
  /** The ceiling, in model calls. */
  limit: number
  /** Turns charged. Always at least as many as `calls` would suggest are complete. */
  turns: number
  /** Total tokens across those calls, when the provider reported them. */
  tokens: number
  /** True once the ceiling is spent. */
  exhausted: boolean
  /** Calls left before the ceiling. */
  remaining: number
}

export interface ConversationBudget {
  readonly limit: number
  /**
   * Charge one finished turn.
   *
   * `calls` is what the provider reported (zero when it reported nothing) and is floored
   * at one, because a turn that ran called the model at least once. Returns the state
   * after the charge so a caller does not have to re-read it.
   */
  charge(input: { calls: number; tokens: number }): ConversationBudgetState
  state(): ConversationBudgetState
  exhausted(): boolean
  remaining(): number
}

export interface CreateConversationBudgetOptions {
  /** Defaults to §20.29.6's `DEFAULT_MAX_CONVERSATION_CALLS`. */
  maxCalls?: number
}

/** A positive integer, or the default. A zero ceiling is not a ceiling, it is a broken pane. */
const normalizeLimit = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONVERSATION_CALLS
  const floored = Math.floor(value)
  return floored >= 1 ? floored : DEFAULT_MAX_CONVERSATION_CALLS
}

export const createConversationBudget = (
  options: CreateConversationBudgetOptions = {},
): ConversationBudget => {
  const limit = normalizeLimit(options.maxCalls)

  let calls = 0
  let turns = 0
  let tokens = 0

  const state = (): ConversationBudgetState => ({
    calls,
    limit,
    turns,
    tokens,
    exhausted: calls >= limit,
    remaining: Math.max(0, limit - calls),
  })

  return {
    limit,
    state,
    exhausted: () => calls >= limit,
    remaining: () => Math.max(0, limit - calls),
    charge: ({ calls: turnCalls, tokens: turnTokens }) => {
      // `Math.max(1, ...)` and not `turnCalls`: the floor is the whole point of the
      // first property in the module header. A negative or NaN report is treated as
      // "unreported" rather than subtracted from the budget.
      const reported = Number.isFinite(turnCalls) ? Math.floor(turnCalls) : 0
      calls += reported >= 1 ? reported : 1
      turns += 1
      tokens += Number.isFinite(turnTokens) && turnTokens > 0 ? Math.floor(turnTokens) : 0
      return state()
    },
  }
}
