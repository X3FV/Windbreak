/**
 * Baseline engine framework (spec §4.3).
 *
 * Engines are the "wide net, not the catch": four tools combined catch roughly
 * 39% of real vulnerabilities in isolation and generic rules exceed 90% FP on
 * OWASP. This stage exists to produce candidates for §4.4–§4.6, and every
 * candidate is normalized into the §4.5 schema regardless of which engine
 * produced it.
 */

/** §4.5. Kept as a union so an unknown engine string fails to typecheck. */
export const CANDIDATE_SOURCES = [
  'semgrep',
  'codeql',
  'smatch',
  'sparse',
  'coccinelle',
  'taint-pipeline',
  'patch-mined',
  'checker-synth',
  'toctou-fsm',
  // §4.4.3's CWE-364 producer. A source of its own rather than a reuse of
  // `toctou-fsm` for the same reason `primevul` has its own: the two produce
  // different weaknesses from different evidence, and "detected by: toctou-fsm" on a
  // signal finding would name a machine that did not run.
  'toctou-signal',
  'variant-hunt',
  // §11.1's function-level corpus. Not an engine: no detector flagged these
  // functions. It is a source of its own rather than a re-used one because
  // provenance reaches the prompt (`describeCandidateProvenance`) and the
  // candidate row, and "detected by: patch-mined" would be a claim about a
  // detector that did not run — the kind of framing difference §15 records as
  // moving detection by up to 93%.
  'primevul',
  // §20.29's investigator — a model that read the target and proposed a site. Not an
  // engine, and the one source where the distinction is load-bearing rather than
  // tidy: §20.29.4 requires that "a model that read the code and formed an opinion is
  // not an engine match", because §20.19's funnel and §11's scoring compare a
  // chat-then-confirm loop against an engine-then-verify loop, and folding the two
  // together makes a run that used the investigator look like a run whose detectors
  // were better. Provenance reaches the prompt (`describeCandidateProvenance`), the
  // writeup (`Produced by:`), the SARIF rule, and the funnel row, and "detected by:
  // investigator" would be a claim about a detector that did not run.
  'investigator',
] as const

export type CandidateSource = (typeof CANDIDATE_SOURCES)[number]

/**
 * The sources that are a *model's* proposal rather than a detector's finding (§20.29.4).
 *
 * Declared here, beside the union, so the places that must treat a model proposal
 * differently — the prompt's provenance line, the writeup, the funnel row — share one
 * list instead of each spelling `'investigator'` and drifting. `context.ts` folds this
 * into the wider "not a detector" set, which also holds `primevul`: different reasons,
 * same conclusion, and one direction of dependency rather than two lists that overlap by
 * coincidence.
 */
export const MODEL_PROPOSED_SOURCES = ['investigator'] as const

export const isModelProposed = (source: string): boolean =>
  (MODEL_PROPOSED_SOURCES as readonly string[]).includes(source)

/** Engines this stage can actually drive. Others are recognized, not driven. */
export const IMPLEMENTED_ENGINES = ['semgrep'] as const
export type EngineId = (typeof IMPLEMENTED_ENGINES)[number]

/**
 * Engines named by §4.3 that WindBreak knows about but does not drive yet.
 * Recorded so a missing engine is a named gap rather than an absence.
 */
export const UNIMPLEMENTED_ENGINES = [
  'codeql',
  'smatch',
  'sparse',
  'coccinelle',
  'cppcheck',
  'taint-pipeline',
] as const

export type UnimplementedEngineId = (typeof UNIMPLEMENTED_ENGINES)[number]

/** One finding as an engine reported it, before normalization. */
export interface RawFinding {
  engine: CandidateSource
  ruleId: string
  /** Rule severity as the engine expressed it, lowercased. */
  level: 'error' | 'warning' | 'info' | 'note' | 'unknown'
  message: string
  /** Path relative to the target root. */
  filePath: string
  startLine: number
  endLine: number | null
  /** Source text of the matched region, when the engine provides it. */
  snippet: string | null
  cwe: string | null
  /** The engine's own confidence/precision field, when it has one. */
  precision: string | null
}

/** A normalized §4.5 candidate, ready to persist. */
export interface Candidate {
  id: string
  source: CandidateSource
  patternId: string
  /**
   * The revision this candidate's pattern was mined from (§10). Set for
   * `variant-hunt` candidates so a replayed hit traces back to the confirmed
   * finding it generalizes, and null for engine candidates, which have no
   * originating patch.
   */
  originPatchSha?: string | null
  filePath: string | null
  startLine: number | null
  endLine: number | null
  cwe: string | null
  state: CandidateState
  normalized: NormalizedCandidate
  injectionSignals: string[]
}

export type CandidateState =
  | 'new'
  | 'triaged'
  | 'verifying'
  | 'escalated'
  | 'confirmed'
  | 'dropped'
  | 'rediscovery'

export const CANDIDATE_STATES: readonly CandidateState[] = [
  'new',
  'triaged',
  'verifying',
  'escalated',
  'confirmed',
  'dropped',
  'rediscovery',
]

/**
 * What downstream stages read. `sliceHash` binds the candidate to the exact
 * source text it was derived from: if the file changes under us, the hash stops
 * matching and the candidate can be invalidated rather than silently reasoned
 * about against different code.
 */
export interface NormalizedCandidate {
  engine: CandidateSource
  ruleId: string
  message: string
  level: string
  filePath: string
  startLine: number
  endLine: number | null
  snippet: string | null
  sliceHash: string | null
  precision: string | null
}

/** Why an engine could not run. Named, so it cannot be mistaken for "clean". */
export interface EngineUnavailable {
  engine: string
  reason: string
  /** True when the engine is recognized but WindBreak does not drive it. */
  unimplemented?: boolean
}

/** The result of `prepare`'s host-side engine resolution. */
export interface ResolvedEngine {
  engine: string
  version: string
  /** Absolute path to the executable on the host. */
  binary: string
  /**
   * Directories the engine needs read-only inside the sandbox — its binary's
   * directory plus any interpreter/package roots it imports from. §6.3 puts
   * engine setup on the host (`prepare`); this is the data that step produces.
   */
  readOnlyRoots: string[]
  /** Directories to prepend to `PATH` inside the sandbox. */
  pathEntries: string[]
  /** Environment the engine needs to resolve itself inside the sandbox. */
  environment: Record<string, string>
}

export interface EngineInvocation {
  engine: EngineId
  argv: string[]
  /** Working directory inside the sandbox. */
  workingDirectory: string
  /** Wall-clock ceiling for this engine, in seconds. */
  timeLimitSeconds: number
}

export interface EngineExecution {
  engine: EngineId
  argv: string[]
  exitCode: number
  durationMs: number
  timedOut: boolean
  findings: RawFinding[]
  warnings: string[]
  /** Engine-level failure: non-zero exit, unparseable output, or a kill. */
  failed: boolean
}

export interface RunEnginesResult {
  executions: EngineExecution[]
  candidates: Candidate[]
  unavailable: EngineUnavailable[]
  /** Engines that were configured and available, i.e. actually attempted. */
  enginesAttempted: number
  warnings: string[]
  /** Set when the governor stopped the stage early. */
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
}
