/**
 * Pattern library and variant hunting (spec §10, §4.8, §12.2).
 *
 * A pattern enters the library only from a confirmed finding and only after it
 * reproduces that finding; it leaves the replay set the moment it stops being
 * validated. Everything in this module exists to keep those two facts true.
 */
export { capturePattern, evidenceTierFor, targetCommitSha } from './capture'
export {
  canonicalFingerprintJson,
  describeFingerprint,
  fingerprintOutputSchema,
  fingerprintSchema,
  FINGERPRINT_LANGUAGES,
  InvalidFingerprintError,
  parseFingerprint,
  toFingerprint,
} from './fingerprint'
export { matchFingerprint, MATCHABLE_LANGUAGES } from './match'
export {
  buildSynthesisSystemPrompt,
  buildSynthesisUserPrompt,
  CHECKER_PROMPT_TEMPLATE_VERSION,
  CHECKER_SYNTH_OUTPUT_SPEC,
} from './prompt'
export {
  DEFAULT_MAX_CANDIDATES_PER_PATTERN,
  refreshPatternPrecision,
  runVariantHunt,
} from './replay'
export { revalidateChecker } from './revalidate'
export {
  checkerIdFor,
  countUnreadableCheckers,
  insertChecker,
  libraryPatternId,
  measurePatternPrecision,
  readChecker,
  readLibrary,
  readReplays,
  recordReplay,
  replayId,
  retireChecker,
  updateReplayStatistics,
} from './store'
export { DEFAULT_SYNTHESIS_TIMEOUT_MS, parseNormalized, synthesizePattern } from './synthesize'

export type {
  CapturePatternInput,
  CapturePatternRequest,
  CapturePatternResult,
  CapturePatternServices,
} from './capture'
export type { SynthesizePatternInput, SynthesizePatternResult } from './synthesize'
export type { ReadLibraryOptions, RecordReplayInput, InsertCheckerInput, PatternPrecision } from './store'
export type { VariantHuntOptions, VariantHuntRequest, VariantHuntServices } from './replay'
export type {
  CheckerCondition,
  CheckerReplay,
  Fingerprint,
  FingerprintBody,
  FingerprintHit,
  FingerprintKind,
  FingerprintOrderPair,
  FingerprintScope,
  LibraryEntry,
  OriginSite,
  ReplayOutcome,
  RevalidationResult,
  VariantHuntResult,
} from './types'
export { CHECKER_CONDITIONS, FINGERPRINT_KINDS, FINGERPRINT_SCOPES } from './types'
