/**
 * Evaluation (spec §11, D10, D11, D22).
 *
 * §11 has two tiers and both are implemented here, because they answer different
 * questions and a single figure cannot answer both:
 *
 * - **Tier 2** (`manifest` → `match` → `funnel` → `run`) scores repo-level
 *   snapshots end to end, from raw engine hits through adjudication. This is the
 *   tier that gates the MVP, since D11 makes recall the bar. D22 splits its corpus
 *   in two — the list is checked in, the snapshots are fetched on demand — so
 *   `projects` and `snapshot` are here too: the first resolves a fixture's project
 *   name to a clone URL, the second materializes it at the pinned commit.
 * - **Tier 1** (`pairs` → `confusion` → `tier1`) scores PrimeVul function-level
 *   pairs against triage and verification *in isolation*. Its ground truth is
 *   two-sided — every vulnerable function ships with its fixed twin — so it
 *   reports a 2×2 and discrimination rather than a funnel.
 *
 * `load` is the discriminator between them: the two fixture formats declare
 * different `kind`s, so one `eval` command serves both without guessing from the
 * shape of the JSON it was handed.
 */
export { composeObservations, isCleared, isFlagged, scoreStage } from './confusion'
export { buildFunnel, stageSurvivors } from './funnel'
export { EvalInputReadError, loadEvalInput, readJsonFile } from './load'
export {
  halfPath,
  InvalidPairSetError,
  PAIR_HALVES,
  PAIR_SET_KIND,
  PAIR_SET_VERSION,
  parsePairSet,
} from './pairs'
export { corpusCandidates, ensureCorpusTarget, runTier1, writeTier1Metrics } from './tier1'
export { renderTier1Report } from './tier1-text'
export {
  bugsOf,
  FIXTURE_SET_VERSION,
  InvalidFixtureSetError,
  parseFixtureSet,
} from './manifest'
export { matchCandidate, normalizeRepoPath, pathsCorrespond, rangesOverlap } from './match'
export { readEvalCandidates, readEvalRuns } from './read'
export { commitMatches, DEFAULT_MIN_RECALL, loadFixtureSet, runEval, UnknownRunError } from './run'
export {
  loadProjectRegistry,
  parseProjectRegistry,
  PROJECT_REGISTRY_VERSION,
  ProjectRegistryError,
  resolveProject,
  SHIPPED_PROJECTS,
  UnknownProjectError,
} from './projects'
export {
  DEFAULT_CLONE_TIMEOUT_SECONDS,
  DEFAULT_GIT_TIMEOUT_SECONDS,
  DEFAULT_SNAPSHOTS_DIR,
  ensureSnapshot,
  readSnapshotMarker,
  SnapshotError,
  snapshotDirName,
  snapshotPath,
} from './snapshot'

export type { CandidateLocation } from './match'
export type { EvalInput } from './load'
export type { HalfOutcome, Observation, StageMetrics, Tier1Stage } from './confusion'
export type { PairHalf } from './pairs'
export type { RunEvalOptions } from './run'
export type { FixtureProject, ProjectResolution } from './projects'
export type { SnapshotMarker, SnapshotOptions, SnapshotResult } from './snapshot'
export type { RunTier1Options, Tier1Report } from './tier1'
export type {
  EvalCandidate,
  EvalFixtureReport,
  EvalReport,
  EvalRun,
  Fixture,
  FixtureBug,
  FixtureSet,
  FixtureSite,
  FunctionPair,
  PairSet,
  FunnelRow,
  FunnelStage,
  FunnelStageDefinition,
  GroundTruth,
  MatchBasis,
} from './types'
export { FUNNEL_STAGES, FUNNEL_STAGE_DEFINITIONS } from './types'
