/**
 * Model-proposed candidates (spec §4.5, §20.29.4).
 *
 * A hunt produces candidates, and this is the channel they travel: the investigator
 * calls `propose_candidate` with a *location* and a claim, and the tool reads the text
 * there itself. Three properties follow, and all three are the point rather than
 * side-effects:
 *
 * 1. **The model's text is never trusted.** The tool takes a path and a line range and
 *    stores the slice read from the file — the same rule `engines/normalize.ts` already
 *    applies to engine snippets ("SARIF snippets are truncated and their line offsets are
 *    not trustworthy, so a slice read from the file is the authoritative text"). A model
 *    that describes code that is not there produces a candidate whose snippet contradicts
 *    its own claim, and triage and verification see the real code. Nothing a model pastes
 *    into a proposal reaches a prompt as evidence.
 * 2. **The provenance is ours.** The tool's input schema has no `source` field; the
 *    candidate is stamped `investigator` by this module. §20.29.4's requirement is that
 *    *"a model that read the code and formed an opinion is not an engine match"*, so the
 *    one thing the model must not be able to do is claim an engine found it.
 * 3. **A proposal is not a verdict.** Candidates enter at `state: 'new'` and go through
 *    §4.6 and §5 exactly like an engine's. Proposing is not confirming, and if a hunt's
 *    candidate could skip triage then the investigator would be two roles at once — which
 *    is the pairing §20.29.3 exists to prevent.
 *
 * The name is `propose_candidate` rather than `record_candidate` or `report_finding` for
 * the same reason: the model is proposing, and the pipeline decides.
 */

import { createHash } from 'crypto'
import { z } from 'zod'

import { detectInjectionSignals, injectionSignalSummary } from '../trust/injection'

import { SourceCache, extractSlice, hashSlice } from '../engines/normalize'

import type { Candidate } from '../engines/types'
import type { InvestigatorWorkspace } from './workspace'

/** The tool's name, exported so the agent's tool list and this file cannot drift. */
export const PROPOSE_TOOL_NAME = 'propose_candidate'

/**
 * A site a model asked to have recorded, after validation.
 *
 * `endLine` is resolved rather than nullable so the recorded range is always a range:
 * a model that gives only a start line gets a one-line candidate, and nothing downstream
 * has to handle "proposed at a line, end unknown".
 */
export interface ProposedSite {
  /** Path relative to the target root, exactly as it will be persisted. */
  filePath: string
  startLine: number
  endLine: number
  cwe: string | null
  /** What the model claims is wrong here. Shown to triage as the proposer's claim. */
  claim: string
}

/** A proposal the tool refused, kept so a hunt can say what it rejected and why. */
export interface ProposalRejection {
  /** The path the model asked for, verbatim, so the refusal names what was asked. */
  requestedPath: string
  reason: string
}

export interface ProposalCollector {
  sites: ProposedSite[]
  rejections: ProposalRejection[]
}

/**
 * How many sites one turn may propose.
 *
 * A cap rather than a policy: without one a model can flood the store in a single turn,
 * and every proposal costs a triage call. Exceeding it is reported to the model as a
 * refusal naming the limit, so the behaviour is visible instead of silently clipped —
 * which is the same rule the result ceiling follows in `./tools`.
 */
export const MAX_PROPOSALS_PER_TURN = 20

const CWE_PATTERN = /^CWE-\d{1,5}$/i

export const proposeInputSchema = z.object({
  path: z
    .string()
    .describe('File path relative to the target root, or an absolute path inside it.'),
  startLine: z.number().int().positive().describe('1-based, inclusive.'),
  endLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based, inclusive. Omit for a single-line site.'),
  cwe: z
    .string()
    .optional()
    .describe('Weakness class as CWE-<number>, when you are confident of it.'),
  claim: z
    .string()
    .min(1)
    .describe(
      'One or two sentences: what is wrong here and what an attacker gets. This is ' +
        'shown to the reviewers as your claim, so it must not be a restatement of the ' +
        'code.',
    ),
})

export type ProposeInput = z.infer<typeof proposeInputSchema>

/**
 * Validate a proposal against the target and return the site it names.
 *
 * Returns a reason rather than throwing for every rejection, because each one is a
 * normal thing for a model to do — guess a path, miscount a line, name a CWE that is not
 * a CWE. The distinction a caller needs is `{ site }` versus `{ reason }`, and an
 * exception would collapse it into the same channel as a genuine fault.
 *
 * The line count is taken from the text the tool is about to store, so "the range is
 * inside the file" and "the snippet is this text" cannot disagree.
 */
export const validateProposal = (
  workspace: InvestigatorWorkspace,
  proposal: ProposeInput,
  limits: { maxProposals: number; existing: number },
): { site: ProposedSite; text: string } | { reason: string } => {
  if (limits.existing >= limits.maxProposals) {
    return {
      reason:
        `this turn has already proposed ${limits.maxProposals} candidate(s), which is ` +
        'the limit. Report what you already found rather than proposing more; a new ' +
        'turn can propose again.',
    }
  }

  // Confinement, re-checked here rather than assumed from the tool's own resolve: the
  // budget above is the only thing that short-circuits, and this is the security
  // boundary.
  let resolvedPath: string
  try {
    resolvedPath = workspace.resolve(proposal.path)
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  if (resolvedPath === workspace.root) {
    return { reason: `"${proposal.path}" is the target root, not a file` }
  }

  const contents = workspace.readFile(proposal.path)
  if (contents === null) {
    return { reason: `no readable file at "${proposal.path}" inside the target` }
  }

  const lines = contents.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()

  if (proposal.startLine > lines.length) {
    return {
      reason:
        `line ${proposal.startLine} is past the end of "${proposal.path}" ` +
        `(${lines.length} lines)`,
    }
  }

  const endLine = proposal.endLine ?? proposal.startLine
  if (endLine < proposal.startLine) {
    return {
      reason: `endLine ${endLine} is before startLine ${proposal.startLine}`,
    }
  }
  if (endLine > lines.length) {
    return {
      reason:
        `line ${endLine} is past the end of "${proposal.path}" (${lines.length} lines)`,
    }
  }

  if (proposal.cwe !== undefined && !CWE_PATTERN.test(proposal.cwe.trim())) {
    return {
      reason: `"${proposal.cwe}" is not a CWE identifier; expected the form CWE-120`,
    }
  }

  return {
    site: {
      filePath: proposal.path,
      startLine: proposal.startLine,
      endLine,
      cwe: proposal.cwe ? proposal.cwe.trim().toUpperCase() : null,
      claim: proposal.claim.trim(),
    },
    // The text the candidate will carry, read from the file rather than taken from the
    // model. `extractSlice` is the engines' own slice reader so a proposal and an engine
    // finding are cut identically.
    text: lines.slice(proposal.startLine - 1, endLine).join('\n'),
  }
}

/**
 * A proposal's identity.
 *
 * Scoped to the run and the location, not to the claim: two turns proposing the same site
 * are one candidate, and a model that re-words its claim should not produce a second.
 * This mirrors `engines/normalize.ts`'s `candidateId`, which is also run-scoped and also
 * ignores the message.
 */
export const proposedCandidateId = (input: {
  runId: string
  filePath: string
  startLine: number
  endLine: number
}): string =>
  `cand_${createHash('sha256')
    .update(
      `${input.runId}:investigator:${input.filePath}:${input.startLine}:${input.endLine}`,
    )
    .digest('hex')
    .slice(0, 24)}`

/**
 * The rule id a proposal is recorded under.
 *
 * A single stable value rather than something derived from the claim, so `patternId` and
 * the SARIF rule name say *where the candidate came from* rather than pretending there is
 * a rule. §20.29.4's complaint is that a model opinion must not read as an engine match;
 * a unique-per-candidate rule id would look exactly like an engine rule in a SARIF reader.
 */
export const PROPOSED_RULE_ID = 'investigator-proposal'

export interface ProposalsToCandidatesInput {
  runId: string
  /** The agent's claim, as it stood when this site was proposed. */
  sites: readonly ProposedSite[]
  workspace: InvestigatorWorkspace
  /** Optional per-site claim lookup; falls back to the site's own `claim`. */
  claims?: ReadonlyMap<string, string>
}

/**
 * Turn validated sites into §4.5 candidates.
 *
 * The path is re-resolved here rather than trusted from `validateProposal`'s result: a
 * proposal is converted after the model has finished, so the check that matters is the
 * one made at conversion time against the same workspace the evidence will come from.
 * A site that no longer resolves is dropped rather than persisted.
 *
 * `state: 'new'` is the load-bearing field. §4.6 reads untriaged candidates and §5 reads
 * triaged ones, so a proposal starts where an engine's candidate starts and has to earn
 * its way through both. `injectionSignals` are computed from the stored slice, which is
 * the text a model will actually read, so a proposal pointing at a hostile file is
 * flagged before any prompt carries it.
 */
export const proposalsToCandidates = (
  input: ProposalsToCandidatesInput,
): Candidate[] => {
  // One cache for the whole batch, exactly as the engines stage uses one per run. A hunt
  // that proposes several sites in one file should read it once.
  const sourceCache = new SourceCache(input.workspace.root)
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  for (const site of input.sites) {
    const resolved = (() => {
      try {
        return input.workspace.resolve(site.filePath)
      } catch {
        return null
      }
    })()
    if (resolved === null) continue

    const id = proposedCandidateId({
      runId: input.runId,
      filePath: site.filePath,
      startLine: site.startLine,
      endLine: site.endLine,
    })
    if (seen.has(id)) continue
    seen.add(id)

    const claim = input.claims?.get(site.filePath) ?? site.claim
    const lines = sourceCache.lines(site.filePath)
    const slice = lines
      ? extractSlice(lines, site.startLine, site.endLine, 0, site.endLine - site.startLine + 1)
      : null
    const snippet = slice?.text ?? null
    const signals = snippet ? detectInjectionSignals(snippet) : []

    candidates.push({
      id,
      // Stamped here, never taken from the model (§20.29.4).
      source: 'investigator',
      patternId: PROPOSED_RULE_ID,
      originPatchSha: null,
      filePath: site.filePath,
      startLine: slice?.start ?? site.startLine,
      endLine: slice?.end ?? site.endLine,
      cwe: site.cwe,
      state: 'new',
      injectionSignals: injectionSignalSummary(signals),
      normalized: {
        engine: 'investigator',
        ruleId: PROPOSED_RULE_ID,
        // What the prompt shows as the candidate's claim, so it must not assert a
        // detector's finding — the same rule `eval/tier1.ts` follows for its corpus
        // candidates.
        message: claim,
        // Not a severity. No detector assessed this, and `warning` would be an
        // assessment by a machine that did not run.
        level: 'unknown',
        filePath: site.filePath,
        startLine: slice?.start ?? site.startLine,
        endLine: slice?.end ?? site.endLine,
        snippet,
        sliceHash: snippet !== null ? hashSlice(snippet) : null,
        precision: null,
      },
    })
  }

  return candidates
}
