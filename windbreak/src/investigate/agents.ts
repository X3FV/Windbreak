/**
 * The two agents of §20.30, and nothing else.
 *
 * A module this small earns its place for the reason `limits.ts` does: it has **no
 * imports**, so `persist.ts` can read the runtime union without pulling the tool set,
 * the workspace and the SDK into a module that is mostly SQL. The alternative was to
 * define the union in `tools.ts` and let a reader of the transcript drag in a model
 * client to learn what an agent is called.
 *
 * The union is *which root the researcher is talking to*, which is why the names are
 * roles rather than capabilities:
 *
 * - `investigator` answers about the **target** — the read-only evidence a finding
 *   cites. Its tool list has no write tool in it, so that is a fact about the code.
 * - `engineer` works on the **working copy** — a writable copy of the target. Every
 *   write it makes lands in the copy, and the target is a different root that is bound
 *   read-only.
 */

export const INVESTIGATOR_AGENTS = ['investigator', 'engineer'] as const

export type InvestigatorAgentName = (typeof INVESTIGATOR_AGENTS)[number]

/**
 * The agent a fresh conversation starts with.
 *
 * The investigator, because answering is what the pane is for and editing is the
 * deliberate step. A screen that opened on the writing agent would make the
 * destructive surface the default one.
 */
export const DEFAULT_INVESTIGATOR_AGENT: InvestigatorAgentName = 'investigator'

/** How an agent is named in the transcript and the hint row. */
export const AGENT_LABELS: Record<InvestigatorAgentName, string> = {
  investigator: 'investigator',
  engineer: 'engineer',
}
