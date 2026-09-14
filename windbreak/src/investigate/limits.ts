/**
 * The investigator's numeric defaults (spec §20.29.6).
 *
 * This module has no imports on purpose. Both the config loader and the agent need
 * the same numbers, and `config.ts` is pulled in by every command in the CLI — so the
 * defaults live somewhere that costs nothing to import, rather than dragging the tool
 * set, the workspace and the SDK into a `loadConfig` call. The alternative was to
 * duplicate the constants and let them drift, which is the failure mode `models.ts`
 * already documents once (`DEFAULT_INVESTIGATOR_MODEL`).
 */

/**
 * Enough steps for a turn to explore, propose, and summarise.
 *
 * The verdict roles get two steps because two is the runtime's retry budget. This is a
 * different number for a different reason: an investigator has to be able to act *and*
 * answer.
 *
 * **Six was measured and was too low.** The first live hunt with six spent every step
 * exploring — two directory listings, a search, four file reads and five commands — and
 * then ended with no prose and no candidates at all. A hunt has three phases and the
 * ceiling has to clear all three, which the original number did not. Sixteen is a ceiling
 * and not a policy; the conversation ceiling below is what stops a loop.
 */
export const DEFAULT_INVESTIGATOR_STEPS = 16

/**
 * The ceiling on one conversation, in model calls (spec §20.29.6).
 *
 * §8's governor cannot bound this: its unit is the *stage*, and a chat is not a stage.
 * The step ceiling above is per-*turn*, so a researcher who keeps asking gets a fresh
 * sixteen steps each time. This is the number that spans turns.
 *
 * **Model calls, not turns,** because a turn's cost is not one thing: an `explain` of a
 * candidate may be two calls and a hunt of an unfamiliar tree fourteen, so counting
 * questions would charge them the same. The provider reports calls through
 * `onUsage`, and `conversation.ts` charges what was reported with a floor of one per
 * turn — the direction a ceiling must never be wrong in.
 *
 * 120 is a working session rather than a policy: a hunt costs roughly a dozen calls, an
 * explain a handful, so this is on the order of eight to ten turns of mixed work. It is
 * deliberately **per conversation and not per run**: leaving the screen and returning
 * starts a new conversation with a fresh ceiling, which is the honest bound — the
 * target's §9 budget remains the thing that bounds spend across runs.
 */
export const DEFAULT_MAX_CONVERSATION_CALLS = 120
