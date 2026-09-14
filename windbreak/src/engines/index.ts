/**
 * Baseline engines (spec §4.3).
 *
 * The wide net: Semgrep, and later CodeQL / smatch / sparse / coccinelle, all
 * driven as subprocesses inside the sandbox. Nothing here judges a candidate —
 * that is §4.4 and §4.6 — it only produces normalized §4.5 candidates.
 */
export {
  buildInvocation,
  DEFAULT_ENGINE_CAP_SECONDS,
  MIN_ENGINE_SECONDS,
  runBaselineEngines,
} from './discover'
export {
  candidateId,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_MAX_SNIPPET_LINES,
  DEFAULT_MAX_SOURCE_BYTES,
  extractSlice,
  hashSlice,
  normalizeFinding,
  normalizeFindings,
  SourceCache,
} from './normalize'
export {
  createRun,
  finishRun,
  persistCandidates,
  readCandidateSummary,
} from './persist'
export { requireEngines, resolveEngines, resolveSemgrep } from './resolve'
export {
  buildSemgrepArgv,
  DEFAULT_SEMGREP_JOBS,
  DEFAULT_SEMGREP_MAX_TARGET_BYTES,
  DEFAULT_SEMGREP_TIMEOUT_SECONDS,
  parseSemgrepOutput,
  SEMGREP_ENGINE_ID,
} from './semgrep'
export { normalizeArtifactUri, parseSarif } from './sarif'
export { buildEnginePolicy, engineScratchDirs, runEngine } from './run'
export { CANDIDATE_SOURCES, IMPLEMENTED_ENGINES, UNIMPLEMENTED_ENGINES } from './types'

export type { ResolveEnginesOptions, ResolveEnginesResult } from './resolve'
export type { RunEngineOptions } from './run'
export type { SarifParseResult } from './sarif'
export type { SemgrepInvocation } from './semgrep'
export type { NormalizeOptions, NormalizeResult } from './normalize'
export type { DiscoverOptions, DiscoverRequest, DiscoverServices } from './discover'
export type {
  Candidate,
  CandidateSource,
  CandidateState,
  EngineExecution,
  EngineId,
  EngineInvocation,
  EngineUnavailable,
  NormalizedCandidate,
  RawFinding,
  ResolvedEngine,
  RunEnginesResult,
} from './types'
