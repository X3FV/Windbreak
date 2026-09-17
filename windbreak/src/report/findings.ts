/**
 * Turn recorded candidate state into §14.2 findings (spec §13, §5.3).
 *
 * The evidence tier is derived, never guessed, and the mapping is explicit
 * because §2.1.5 makes an unstated tier a contract violation. A candidate for
 * which no tier can be derived is *excluded with a reason*, not emitted with a
 * vague one — and never dropped silently, since a silent drop is how a real
 * finding disappears.
 *
 * Mapping (recorded in spec §20.11):
 *
 *   confirmed  (Proposer and Refuter both said real)  -> statically-verified
 *   escalated + human said real                       -> statically-verified
 *   escalated + human said benign                     -> excluded (dropped)
 *   escalated, decision still pending                 -> contested
 *   rediscovery                                       -> recorded, not a finding
 *   new / triaged / verifying / dropped               -> not a finding
 *
 * `escalated` unresolved is reported as `contested` rather than withheld: the
 * tier exists for exactly this state, and withholding it would hide a
 * disagreement the researcher asked to see. The writeup says so plainly.
 */

import { createHash } from 'crypto'

import { isModelProposed } from '../engines/types'
import { describeReachability } from '../reach'

import { suggestedFixFor } from './fixes'

import type { CandidateRecord } from '../pipeline'
import type { CandidateReachability } from '../reach'
import type { EvidenceTier, Finding, ModelUsage, RediscoveryInfo, VerdictSummary } from './types'

export interface ReportableInput {
  candidate: CandidateRecord
  verdicts: VerdictSummary[]
  /** The human's adjudication decision, when one was recorded. */
  queueDecision: 'real' | 'benign' | null
  rediscovery: RediscoveryInfo | null
  /** Rendered call path from the symbol index, when one exists. */
  callPath: string | null
  /**
   * Name of the function the candidate sits in, from the symbol index. Kept
   * separate from `callPath` because the title wants the bare name: a call path
   * carries annotations ("no recorded call sites") that belong in the evidence,
   * not in a heading.
   */
  enclosingFunction: string | null
  snippet: string | null
  language: string | null
  /**
   * §4.4.4's conclusion for this candidate's location, or null when the pass never ran.
   *
   * Null is not a class: a candidate from a scan that predates the pass, or one with no
   * file and line, has no conclusion — and only a recorded `unreachable` may exclude.
   */
  reachability: CandidateReachability | null
}

export interface DeriveFindingsInput {
  candidates: readonly ReportableInput[]
  /** Candidate ids the researcher has asserted a reproduction for. */
  reproduced?: readonly string[]
  /**
   * Candidate ids the `confirm` stage reproduced on its own (§20.35).
   *
   * Kept separate from `reproduced` rather than merged into it because the two are
   * different claims with different strengths, and §10's gate on library capture
   * depends on telling them apart.
   */
  dynamicallyConfirmed?: readonly string[]
}

export interface ExcludedCandidate {
  candidateId: string
  reason: string
}

export interface DeriveFindingsResult {
  findings: Finding[]
  /** §4.2 lookup 3 hits: recorded and shown, never presented as discoveries. */
  rediscoveries: ReportableInput[]
  excluded: ExcludedCandidate[]
}

export const findingId = (candidateId: string): string =>
  `find_${createHash('sha256').update(candidateId).digest('hex').slice(0, 24)}`

/**
 * Human-readable class names, keyed by the CWE a finding carries.
 *
 * Started as the classes the C rule set can emit and has grown with the producers that
 * name a class: §4.4.3's signal shapes carry 364 and 828, which no engine rule emits.
 *
 * Exported because "the classes this tool can name" is a claim worth checking, not just a
 * lookup table: `harness.test.ts` holds it against the committed rule set and against the
 * harness's expected-failure table, both of which have to know every class here. The
 * entry for CWE-377 and CWE-338 was missing when that check was written — the engine
 * emitted them and neither the title nor the reproduction guidance could name them.
 */
export const CLASS_NAMES: Record<string, string> = {
  'CWE-120': 'Unbounded copy',
  'CWE-121': 'Stack buffer overflow',
  'CWE-122': 'Heap buffer overflow',
  'CWE-125': 'Out-of-bounds read',
  'CWE-787': 'Out-of-bounds write',
  'CWE-190': 'Integer overflow',
  'CWE-191': 'Integer underflow',
  'CWE-476': 'NULL pointer dereference',
  'CWE-416': 'Use after free',
  'CWE-415': 'Double free',
  'CWE-401': 'Memory leak',
  'CWE-78': 'OS command injection',
  'CWE-89': 'SQL injection',
  'CWE-134': 'Uncontrolled format string',
  'CWE-338': 'Weak pseudo-randomness',
  'CWE-362': 'Race condition',
  'CWE-364': 'Signal handler race',
  'CWE-367': 'TOCTOU race',
  'CWE-377': 'Insecure temporary file',
  'CWE-828': 'Not async-signal-safe in a signal handler',
}

export const humanClassFor = (cwe: string | null, patternId: string | null): string => {
  if (cwe) {
    const known = CLASS_NAMES[cwe.toUpperCase()]
    if (known) return known
  }
  return patternId ?? 'Unclassified defect'
}

const buildTitle = (input: {
  cwe: string | null
  patternId: string | null
  enclosingFunction: string | null
  filePath: string | null
  startLine: number | null
}): string => {
  const klass = humanClassFor(input.cwe, input.patternId)
  // Prefer the enclosing function from the symbol index — it names the thing
  // that is wrong — and fall back to the location, never to a bare title.
  const where =
    input.enclosingFunction ??
    (input.filePath ? `${input.filePath}:${input.startLine ?? '?'}` : null)

  return where ? `${klass} in ${where}` : `${klass} (location unknown)`
}

const tierFor = (
  candidate: CandidateRecord,
  queueDecision: 'real' | 'benign' | null,
): { tier: EvidenceTier } | { excluded: string } => {
  switch (candidate.state) {
    case 'confirmed':
      return { tier: 'statically-verified' }
    case 'escalated':
      if (queueDecision === 'benign') {
        return { excluded: 'the adjudicator resolved the disagreement as benign' }
      }
      if (queueDecision === 'real') {
        return { tier: 'statically-verified' }
      }
      return { tier: 'contested' }
    case 'rediscovery':
      return { excluded: 'rediscovery: a known vulnerability, not a discovery' }
    default:
      return {
        excluded: `state "${candidate.state}" has not survived verification`,
      }
  }
}

const modelsFrom = (verdicts: readonly VerdictSummary[]): ModelUsage[] => {
  const seen = new Map<string, ModelUsage>()
  for (const verdict of verdicts) {
    const key = `${verdict.role}:${verdict.modelId}`
    if (!seen.has(key)) {
      seen.set(key, {
        role: verdict.role,
        modelId: verdict.modelId,
        provider: verdict.provider,
      })
    }
  }
  return [...seen.values()]
}

const firstReasoning = (
  verdicts: readonly VerdictSummary[],
  role: string,
): string | null => verdicts.find((verdict) => verdict.role === role)?.reasoning ?? null

const buildEvidence = (input: {
  candidate: CandidateRecord
  callPath: string | null
  snippet: string | null
  language: string | null
  reachability: CandidateReachability | null
  verdicts: readonly VerdictSummary[]
}): string => {
  const { candidate } = input
  const lines: string[] = []

  // §20.29.4. "Produced by: investigator (pattern investigator-proposal)" would read as
  // a detector with a rule, which is the substitution the funnel and the writeup exist
  // to prevent — a chat-proposed finding and an engine-matched one fail in completely
  // different ways, and a reader deciding what to trust needs to know which this is.
  lines.push(
    isModelProposed(candidate.source)
      ? `Provenance: proposed by ${candidate.source} — a model read the target and ` +
        'named this location; no detector produced it.'
      : `Produced by: ${candidate.source}` +
        (candidate.patternId ? ` (pattern ${candidate.patternId})` : ''),
  )
  lines.push(
    `Location: ${candidate.filePath ?? '(unknown)'}:${candidate.startLine ?? '?'}` +
      (candidate.endLine !== null && candidate.endLine !== candidate.startLine
        ? `-${candidate.endLine}`
        : ''),
  )
  if (input.language) lines.push(`Language: ${input.language}`)

  if (input.callPath) lines.push(`Call path: ${input.callPath}`)

  // §4.4.4. After the call path because it is the same kind of statement — where the
  // code sits in the program — and it is the one a triager reads first: a call path says
  // who calls a function, this says whether anything an attacker controls can get there.
  if (input.reachability) lines.push(describeReachability(input.reachability))

  const proposer = firstReasoning(input.verdicts, 'proposer')
  const refuter = firstReasoning(input.verdicts, 'refuter')
  if (proposer) lines.push('', `Proposer argument: ${proposer}`)
  if (refuter) lines.push(`Refuter argument: ${refuter}`)

  if (input.snippet) {
    lines.push('', 'Code:', '```', input.snippet.trimEnd(), '```')
  }

  if (candidate.injectionSignals.length > 0) {
    lines.push(
      '',
      `Note: ${candidate.injectionSignals.length} instruction-like line(s) were recorded in this ` +
        'code and neutralized before any model read it (spec §5.1). They are evidence about the ' +
        'target, not about the defect:',
      ...candidate.injectionSignals.map((signal) => `  - ${signal}`),
    )
  }

  return lines.join('\n')
}

export const deriveFindings = (input: DeriveFindingsInput): DeriveFindingsResult => {
  const reproduced = new Set(input.reproduced ?? [])
  const dynamicallyConfirmed = new Set(input.dynamicallyConfirmed ?? [])
  const findings: Finding[] = []
  const rediscoveries: ReportableInput[] = []
  const excluded: ExcludedCandidate[] = []

  for (const entry of input.candidates) {
    if (entry.candidate.state === 'rediscovery') {
      rediscoveries.push(entry)
      continue
    }

    // §4.4.4. The gate is on a *recorded* conclusion and on nothing else: a candidate
    // whose reachability was never computed passes, because a run that did not look is
    // not a run that found no path (§18, and the same rule §20.35 states for dynamic
    // confirmation). A site no entry point reaches, with every caller set on the way in
    // accounted for, is a defect in code this program cannot be attacked through — which
    // is the most common reason a technically-real report is closed as N/A.
    if (entry.reachability?.klass === 'unreachable') {
      excluded.push({
        candidateId: entry.candidate.id,
        reason:
          'no entry point reaches it and every caller set on the way in is complete ' +
          '(spec §4.4.4): the code is real, but not reachable in this build',
      })
      continue
    }

    const tier = tierFor(entry.candidate, entry.queueDecision)
    if ('excluded' in tier) {
      excluded.push({ candidateId: entry.candidate.id, reason: tier.excluded })
      continue
    }

    // Each recorded observation outranks the tier derived from the candidate's
    // state, and they only ever move it **up**: a human who ran it and watched is
    // strongest, an automated reproduction next, then whatever the state implies.
    // A run that reproduced nothing leaves the derived tier untouched — a bounded
    // run is silence, not disproof (§20.35).
    const evidenceTier: EvidenceTier = reproduced.has(entry.candidate.id)
      ? 'human-reproduced'
      : dynamicallyConfirmed.has(entry.candidate.id)
        ? 'dynamically-confirmed'
        : tier.tier

    const hypothesis =
      firstReasoning(entry.verdicts, 'proposer') ??
      firstReasoning(entry.verdicts, 'triage') ??
      entry.candidate.normalizedJson

    const location = {
      cwe: entry.candidate.cwe,
      patternId: entry.candidate.patternId,
      enclosingFunction: entry.enclosingFunction,
      filePath: entry.candidate.filePath,
      startLine: entry.candidate.startLine,
    }

    findings.push({
      id: findingId(entry.candidate.id),
      candidateId: entry.candidate.id,
      runId: entry.candidate.runId,
      targetId: entry.candidate.targetId,
      evidenceTier,
      title: buildTitle(location),
      cwe: entry.candidate.cwe,
      source: entry.candidate.source,
      patternId: entry.candidate.patternId,
      filePath: entry.candidate.filePath,
      startLine: entry.candidate.startLine,
      endLine: entry.candidate.endLine,
      hypothesis,
      evidence: buildEvidence({
        candidate: entry.candidate,
        callPath: entry.callPath,
        snippet: entry.snippet,
        language: entry.language,
        reachability: entry.reachability,
        verdicts: entry.verdicts,
      }),
      suggestedFix: suggestedFixFor({
        cwe: entry.candidate.cwe,
        patternId: entry.candidate.patternId,
        snippet: entry.snippet,
      }),
      modelsUsed: modelsFrom(entry.verdicts),
      verdicts: [...entry.verdicts],
      injectionSignals: entry.candidate.injectionSignals,
      rediscovery: entry.rediscovery,
      // Derived from the source rather than stored on the finding's input: the source is
      // the authority on where a candidate came from, and a second field to keep in step
      // with it is a second field that can disagree.
      modelProposed: isModelProposed(entry.candidate.source),
    })
  }

  return { findings, rediscoveries, excluded }
}
