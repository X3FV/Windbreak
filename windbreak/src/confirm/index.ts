/**
 * Automated dynamic confirmation (spec §20.35).
 *
 * The stage D21 deferred: instead of handing the researcher a harness to run by
 * hand, this builds a fuzz target for a finding and runs it inside the sandbox,
 * then records whether the defect actually manifested. See `decidable.ts` for
 * which classes a single run can settle, `attribute.ts` for how a crash is
 * attributed to a finding (and why silence is never disproof), and `run.ts` for
 * the sandboxed attempt itself.
 */

export {
  decidabilityOf,
  FUZZ_DECIDABLE,
  FUZZ_UNDECIDABLE,
  cweKey,
} from './decidable'
export type { DecidabilityVerdict, FuzzDecidability } from './decidable'

export { attributeReport, locationMatch, parseSanitizerReport, sameFile } from './attribute'
export type { AttributionInput, AttributionVerdict, SanitizerFrame, SanitizerReport } from './attribute'

export { enrichReport, parseAddr2lineOutput, symbolizeOffsets } from './symbolize'
export type { ResolvedFrame, SymbolizeOptions } from './symbolize'

export { FUZZ_TARGET_FILE_NAME, planFuzzTarget } from './target'
export type { FuzzTargetInput, FuzzTargetPlan } from './target'

export {
  confirmFinding,
  DEFAULT_FUZZ_SECONDS,
  DEFAULT_FUZZ_SEED,
  resolveConfirmBackend,
} from './run'
export type { ConfirmFindingInput, ConfirmFindingOptions } from './run'

export {
  confirmationId,
  persistConfirmation,
  readConfirmedCandidateIds,
  readConfirmations,
} from './persist'
export type { PersistConfirmationInput, StoredConfirmation } from './persist'

export { CONFIRMATION_OUTCOMES, CONFIRMING_OUTCOMES } from './types'
export type {
  ConfirmationLocation,
  ConfirmationOutcome,
  ConfirmationResult,
  ConfirmationRow,
} from './types'
