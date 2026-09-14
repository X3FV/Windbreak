/**
 * Reporting stage (spec §13): SARIF 2.1.0, tiered writeups, and manual harness
 * generation. Renders recorded state; makes no model calls and executes nothing.
 */
export {
  deriveFindings,
  findingId,
  humanClassFor,
} from './findings'
export { suggestedFixFor } from './fixes'
export { generateHarness } from './harness'
export {
  collectReportableInputs,
  DISCLOSURE_STATUSES,
  ensureLedgerEntry,
  ledgerEntryId,
  persistFinding,
  readAdjudicationDecisions,
  readLedger,
  readReportableCandidates,
  readVerdictsForCandidate,
  REPORTABLE_STATES,
  snippetOf,
  updateLedgerStatus,
} from './persist'
export { buildSarifDocument, isSarifDocument, SARIF_SCHEMA_URI, serializeSarif } from './sarif'
export { runReport } from './run'
export { MissingEvidenceTierError, renderWriteup } from './writeup'

export type {
  DeriveFindingsInput,
  DeriveFindingsResult,
  ExcludedCandidate,
  ReportableInput,
} from './findings'
export type { ClassifyFixInput } from './fixes'
export type { BuildHarnessInput, HarnessBuildStep } from './harness'
export type {
  DisclosureStatus,
  LedgerRow,
  PersistFindingInput,
} from './persist'
export type { BuildSarifInput } from './sarif'
export type {
  ReportOptions,
  ReportRequest,
  ReportResult,
  ReportServices,
  ReportedFinding,
} from './run'
export type { RenderWriteupInput } from './writeup'
export type {
  EvidenceTier,
  Finding,
  FindingArtifacts,
  GeneratedHarness,
  HarnessFile,
  HarnessResult,
  ModelUsage,
  RediscoveryInfo,
  VerdictSummary,
} from './types'
export { EVIDENCE_TIERS } from './types'
