/**
 * Patch-mined candidate discovery (spec §4.4.1 — Phase A).
 *
 * §4.3's engines are the wide net; this is the recall investment the spec adds on
 * top of them. It reads the target's own fix history, extracts the shape of each
 * fix (added guard, lock, bounds check, null check, or lifetime change), and
 * sweeps the current tree for sibling sites that still carry the pre-fix shape.
 *
 * The module split follows what each part depends on, which is also the order to
 * read it in:
 *
 * - `diff` and `shapes` and `validate` are **pure** — diff parsing, the five
 *   detectors, and §4.4.1's pre-image/post-image admission test. This is where the
 *   behaviour worth testing hardest lives, so it has no dependencies at all.
 * - `history` runs git, sandboxed, through a caller-supplied runner.
 * - `siblings` reads the program model and the checkout.
 * - `mine` composes them into candidates.
 *
 * The one property to keep in mind when reading any of it: a pattern is admitted
 * only if its shape detector fires on its own patch's pre-image and not on the
 * post-image. That makes a mined pattern *explain its own patch* and nothing more —
 * precision on siblings is what triage (§4.6) and cross-model verification (§5)
 * exist to decide, and §4.4.1 asks for exactly this much on purpose.
 */

export {
  addedLines,
  LOG_FORMAT,
  parseCommitPatches,
  parseHunks,
  postImage,
  preImage,
  removedLines,
} from './diff'
export {
  DEFAULT_MAX_COMMITS,
  PROGRAM_MODEL_PATHSPECS,
  readCommitHistory,
} from './history'
export {
  acquiresLock,
  callArguments,
  classifyCommit,
  classifyHunk,
  detectAll,
  detectShape,
  isCodeLine,
  nullTestedIdentifiers,
  pointerParameters,
  releases,
  releasesLock,
  signatureText,
  splitTopLevel,
} from './shapes'
export { FIX_SUBJECT, MIN_SWEEP_MS, patternId, runPatchMining } from './mine'
export { DEFAULT_MAX_SITES_PER_PATTERN, findSiblingSites } from './siblings'
export { validateShape } from './validate'
export { FIX_SHAPES } from './types'

export type { ClassifiedHunk } from './shapes'
export type { GitRunner, ReadHistoryOptions, ReadHistoryResult } from './history'
export type { PatchMineOutcome, PatchMineRequest, PatchMineServices } from './mine'
export type { SiblingOptions, SiblingResult } from './siblings'
export type {
  CommitCoverage,
  CommitPatch,
  DiffLine,
  FixShape,
  Hunk,
  MinedPattern,
  PatchMineResult,
  PatternValidation,
  RejectedPattern,
  ShapeFinding,
  ShapeHint,
  SiblingSite,
} from './types'
