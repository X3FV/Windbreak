import { DEEPSEEK_V4_1_FLASH_MODEL_ID, GLM_53_FLASH_MODEL_ID } from './models'

/**
 * Which Freebuff root agent a model may run under, in free mode (spec §20.41).
 *
 * **Why this is not optional.** A `costMode: 'free'` request is admitted only for
 * specific agent/model combinations. Windbreak sent its own definitions —
 * `windbreak-triage`, `windbreak-proposer` — and the server answered:
 *
 *     {"error":"free_mode_invalid_agent_model",
 *      "message":"Free mode is only available for specific agent and model combinations."}
 *
 * That is the gate `common/src/constants/free-agents.ts` warns about on
 * `FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL`: "a model whose base3 twin is missing resolves
 * to the FALLBACK model's root instead, and that root's allowlist rejects the requested
 * model with `free_mode_invalid_agent_model`." §20.41's decision is to run *as* those
 * roots rather than to buy credits, so a role's definition declares the free root agent
 * for its model and keeps everything else — prompt, output mode, output schema — ours.
 * The id is what the server matches on; the prompt is not sent by the client's choice but
 * by the definition, and only the id is checked.
 *
 * **The cost, stated rather than hidden.** A run's agent id is no longer
 * `windbreak-<role>`, so a live call is indistinguishable in the provider's own logs from
 * an ordinary Freebuff turn on that model. Windbreak's attribution does not depend on it —
 * a candidate records the role, the model, the prompt-template version and the verdict —
 * but anything reading `agent_id` upstream will see the Freebuff root, not this tool.
 *
 * **An unmapped model is refused here, before the provider is reached.** Falling back to
 * `windbreak-<role>` would trade a legible refusal at this layer for a 400 from the gate,
 * which is the shape of failure §20.41 is about: a run that looks configured and cannot
 * work. The map is data, and `freebuff-agents.test.ts` pins it against the shipped default
 * config so picking an unsupported model fails a test rather than an engagement.
 *
 * The constants are reimplemented rather than imported, for the reason `auth.ts` states:
 * `@codebuff/common` is a *transitive* dependency of this package.
 */
const FREE_AGENT_ID_BY_MODEL: Record<string, string> = {
  /** `FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID` -> `base3-free-deepseek-flash`. */
  [DEEPSEEK_V4_1_FLASH_MODEL_ID]: 'base3-free-deepseek-flash',
  /** `FREEBUFF_GLM_V53_FLASH_MODEL_ID` -> `base3-free-glm-5-3-flash`. */
  [GLM_53_FLASH_MODEL_ID]: 'base3-free-glm-5-3-flash',
}

/** The models in this map, for a message that lists what *is* usable. */
export const FREE_MODE_MODEL_IDS: readonly string[] = Object.keys(FREE_AGENT_ID_BY_MODEL)

export class FreeModeModelError extends Error {
  constructor(model: string) {
    super(
      `free mode does not serve \`${model}\`: it admits only specific agent/model ` +
        `combinations, and the ones windbreak knows are ${FREE_MODE_MODEL_IDS.join(', ')}. ` +
        'Pick one of those in `.windbreak/config.json` (`windbreak config models`), or ' +
        'use an account with credits.',
    )
    this.name = 'FreeModeModelError'
  }
}

/**
 * The agent id a role must declare to run this model in free mode.
 *
 * Throws rather than returning a fallback: a call under an id the gate does not know
 * fails at the provider with a message about agent/model combinations, which does not
 * name the configuration that caused it.
 */
export const freeAgentIdFor = (model: string): string => {
  const id = FREE_AGENT_ID_BY_MODEL[model]
  if (!id) throw new FreeModeModelError(model)
  return id
}
