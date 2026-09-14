/**
 * Reporting types (spec §13, §14.2).
 *
 * Reporting is a *rendering* stage: it reads recorded state and writes
 * artifacts. It makes no model calls, which is why §8.1's role table has no
 * "advisory-drafting" model — the narrative is composed from the verdicts the
 * pipeline already recorded (§8.1's fourth row is deliberately "orchestration,
 * no model").
 */

/** §14.2. The tier is stated on every artifact; §2.1.5 forbids omitting it. */
export const EVIDENCE_TIERS = [
  'statically-verified',
  'human-reproduced',
  'contested',
] as const

export type EvidenceTier = (typeof EVIDENCE_TIERS)[number]

/** One model that contributed a verdict, recorded for §13.1's `properties`. */
export interface ModelUsage {
  role: string
  modelId: string
  provider: string
}

export interface VerdictSummary {
  role: string
  /** `real`/`benign` for verification, a triage label for triage. */
  answer: string | null
  reasoning: string
  modelId: string
  provider: string
}

export interface RediscoveryInfo {
  vulnId: string
  signals: string[]
  basis: string
}

/**
 * §14.2's `Finding`, resolved against recorded state.
 *
 * `id` is derived from the candidate so a re-run of reporting produces the same
 * finding identity rather than a new one.
 */
export interface Finding {
  id: string
  candidateId: string
  runId: string
  targetId: string
  evidenceTier: EvidenceTier
  /** One-line title for the writeup heading. */
  title: string
  cwe: string | null
  source: string
  patternId: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  /** What is wrong and why — the Proposer's argument, or the triage rationale. */
  hypothesis: string
  /** Code, call path, and which stage/pattern produced it (§13.2). */
  evidence: string
  suggestedFix: string
  modelsUsed: ModelUsage[]
  verdicts: VerdictSummary[]
  injectionSignals: string[]
  /** §4.2 lookup 3: a rediscovery is recorded, never presented as new. */
  rediscovery: RediscoveryInfo | null
  /**
   * §20.29.4: a model proposed this site; no detector produced it.
   *
   * Carried onto the finding so the SARIF result can be filtered and the writeup can
   * say so. A report that presented a chat-proposed candidate as an engine match would
   * misstate what the detectors achieved, which is the measurement §11 exists to make.
   */
  modelProposed: boolean
}

/** §12.4's `HarnessResult`. Written to disk; **never** executed (D21). */
export interface HarnessResult {
  findingId: string
  /** Absolute paths of the harness files written. */
  files: string[]
  buildInstructions: string[]
  expectedFailure: string
  researcherInstructions: string
}

/** A harness file before it is written, so generation stays pure and testable. */
export interface HarnessFile {
  name: string
  contents: string
  /** True for files that are executable by nature (shell scripts). */
  executable: boolean
}

export interface GeneratedHarness {
  files: HarnessFile[]
  buildInstructions: string[]
  expectedFailure: string
  researcherInstructions: string
}

export interface FindingArtifacts {
  findingId: string
  writeupPath: string
  harness: HarnessResult
}
