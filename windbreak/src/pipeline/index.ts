/**
 * Candidate pipeline (spec §4.6 triage, §5.2/§5.3 cross-model verification).
 */
export { createStageBudget, describeStopped } from './budget'
export { readVerdictCache, verdictCacheKey, writeVerdictCache } from './cache'
export {
  buildEvidenceBundle,
  describeCandidateProvenance,
  PROMPT_TEMPLATE_VERSION,
  renderEvidence,
} from './context'
export { buildRoleAgentDefinition, createSdkModelInvoker } from './invoke'
export {
  buildRoleSystemPrompt,
  buildUserPrompt,
  TRIAGE_OUTPUT_SPEC,
  VERIFICATION_OUTPUT_SPEC,
} from './prompt'
export {
  enqueueAdjudication,
  insertVerdict,
  latestRunForTarget,
  markRediscovery,
  parseNormalized,
  readAdjudicationQueue,
  readCandidate,
  readCandidatesForTriage,
  readCandidatesForVerification,
  readKnownVulns,
  readPipelineSummary,
  recordAdjudicationDecision,
  setCandidateState,
  setCandidateTriage,
  verdictId,
} from './persist'
export { createProgramContext } from './program-context'
export { findRediscovery, knownVulnFromRow, symbolsFromSnippet } from './rediscovery'
export { runPipeline, runRediscoveryCheck } from './run'
export { invokeCached } from './step'
export { runTriage } from './triage'
export { runVerification } from './verify'
// The §20.17.3 handoff seam. Exported because its whole purpose is to be
// reachable by the transport that does not exist yet — a boundary nothing can
// import is a boundary nothing can cross.
export {
  decodeRequest,
  encodeRequest,
  MalformedRequestError,
  splitStageOptions,
} from './handoff'
export { HANDOFFS, HANDOFF_STAGES } from './handoffs'

export type { PipelineProgramContext } from './program-context'
export type {
  AdjudicationDecision,
  PipelineSummary,
  QueueEntry,
  RunRef,
} from './persist'
export type { KnownVulnRecord, RediscoveryMatch } from './rediscovery'
export type {
  PipelineRequest,
  PipelineServices,
  RediscoveryCheckRequest,
  RediscoveryCheckResult,
  RediscoveryCheckServices,
  RunPipelineOptions,
  RunPipelineResult,
  RunRediscoveryCheckOptions,
} from './run'
export type { StageBudget, BudgetGate } from './budget'
export type {
  RunTriageOptions,
  RunTriageResult,
  TriageLabelCounts,
  TriageRequest,
  TriageServices,
} from './triage'
export type {
  RunVerificationOptions,
  RunVerificationResult,
  VerificationRequest,
  VerificationServices,
} from './verify'
export type {
  Handoff,
  JsonCompatible,
  JsonValue,
  KeysMatch,
  NonSerializableKeys,
  SerializabilityCheck,
} from './handoff'
export type { HandoffId } from './handoffs'
export type {
  CallSite,
  CandidateRecord,
  Disposition,
  EvidenceBundle,
  InvokeOutcome,
  ModelIdentity,
  ModelInvocation,
  ModelInvoker,
  PipelineStage,
  StructuredOutputSpec,
  TriageLabel,
  TriageVerdictValue,
  VerificationVerdict,
  VerificationVerdictValue,
} from './types'
