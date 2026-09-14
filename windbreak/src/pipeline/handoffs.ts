/**
 * Every stage's request/services partition, in one place (§20.17.3).
 *
 * The key lists here are not documentation — they are checked against the
 * interfaces at the type level, and the assertions are in this file rather than
 * in a test so that a mistake fails the *build* rather than a test run, next to
 * the line that made it. `KeysMatch` catches both failure directions: a field
 * left unplaced, and a key that names no field.
 *
 * ## Why a registry at all
 *
 * `Options = Request & Services` already means no field can be unclassified, so
 * this list is not what makes the split true. What it adds is the thing a
 * *running* transport needs and a type cannot supply: at the moment a worker is
 * spawned, something has to iterate `requestKeys` to build a payload, and
 * something has to read `serviceKeys` to know what to inject on the far side.
 *
 * It also gives the discipline a place to be enforced. A new stage added to the
 * orchestrator with no entry here is a stage that cannot cross a boundary, and
 * because the entry requires naming both halves of an intersection, adding one
 * is the same edit as deciding the question.
 *
 * ## The two halves are named by what they are, not by what they look like
 *
 * Three fields in here would be misclassified by a heuristic, and each is why
 * the classification is `JsonCompatible` rather than a name list or a guess:
 *
 * - `detect` (recon, engines) reads like configuration and is a service —
 *   `DetectOptions.isExecutable` is a callback.
 * - `runStatus` (report) reads like state to look up and is a request field — it
 *   is a string.
 * - `db` (engines, osv) is optional on both halves' interfaces, so neither its
 *   presence nor its absence signals which half it belongs to.
 */

import type { Handoff, KeysMatch, SerializabilityCheck } from './handoff'
import type { PatchMineRequest, PatchMineServices } from '../patchmine'
import type { ToctouRequest, ToctouServices } from '../toctou'
import type { DiscoverRequest, DiscoverServices } from '../engines/discover'
import type { CapturePatternRequest, CapturePatternServices } from '../library/capture'
import type { VariantHuntRequest, VariantHuntServices } from '../library/replay'
import type { CorrelateRequest, CorrelateServices } from '../osv/correlate'
import type { ReconRequest, ReconServices } from '../recon/run'
import type { ReportRequest, ReportServices } from '../report/run'
import type {
  PipelineRequest,
  PipelineServices,
  RediscoveryCheckRequest,
  RediscoveryCheckServices,
} from './run'
import type { TriageRequest, TriageServices } from './triage'
import type { VerificationRequest, VerificationServices } from './verify'

export const HANDOFFS = {
  recon: {
    stage: 'recon',
    requestKeys: [
      'target',
      'commit',
      'scratchDir',
      'build',
      'jobs',
      'timeLimitSeconds',
      'preferredBackend',
      'scopeClass',
      'checkWorkingTree',
    ],
    serviceKeys: ['detect', 'spawn', 'listDirectory', 'db', 'log'],
  },
  engines: {
    stage: 'engines',
    requestKeys: [
      'targetRoot',
      'targetId',
      'commitSha',
      'engines',
      'rulePaths',
      'extraRulePaths',
      'unavailable',
      'runId',
      'scratchDir',
      'engineCapSeconds',
      'excludedDirectories',
      'jobs',
      'timeoutSeconds',
      'preferredBackend',
    ],
    serviceKeys: ['db', 'governor', 'detect', 'spawn', 'log'],
  },
  osv: {
    stage: 'osv',
    requestKeys: [
      'targetRoot',
      'manifests',
      'targetId',
      'commitSha',
      'enrich',
      'maxDetailFetches',
    ],
    serviceKeys: ['client', 'db', 'readFile', 'log'],
  },
  rediscovery: {
    stage: 'rediscovery',
    requestKeys: ['targetId', 'candidates'],
    serviceKeys: ['db', 'programContext', 'refreshKnownVulns', 'log'],
  },
  pipeline: {
    stage: 'pipeline',
    requestKeys: ['runId', 'targetId', 'candidates', 'cacheDisabled', 'enrich'],
    serviceKeys: [
      'db',
      'invoker',
      'programContext',
      'governor',
      'refreshKnownVulns',
      'log',
      'now',
    ],
  },
  triage: {
    stage: 'triage',
    requestKeys: ['runId', 'candidates', 'cacheDisabled', 'enrich'],
    serviceKeys: ['db', 'invoker', 'programContext', 'governor', 'log', 'now'],
  },
  verification: {
    stage: 'verification',
    requestKeys: ['runId', 'candidates', 'cacheDisabled'],
    serviceKeys: ['db', 'invoker', 'programContext', 'governor', 'log', 'now'],
  },
  report: {
    stage: 'report',
    requestKeys: [
      'runId',
      'targetId',
      'targetLocation',
      'commitSha',
      'version',
      'outDir',
      'reproduced',
      'runStatus',
    ],
    serviceKeys: ['db', 'programContext', 'log', 'now'],
  },
  'variant-hunting': {
    stage: 'variant-hunting',
    requestKeys: [
      'targetId',
      'targetRoot',
      'runId',
      'targetCommitSha',
      'postImageTargetId',
      'allowStaticallyVerified',
      'patternId',
      'maxCandidatesPerPattern',
    ],
    serviceKeys: ['db', 'now', 'log'],
  },
  'patch-mine': {
    stage: 'patch-mine',
    requestKeys: [
      'targetRoot',
      'targetId',
      'runId',
      'maxCommits',
      'maxSitesPerPattern',
      'fixSubjectsOnly',
      'historyTimeLimitSeconds',
      'preferredBackend',
    ],
    serviceKeys: ['db', 'governor', 'runGit', 'sourceCache', 'detect', 'spawn', 'log', 'now'],
  },
  toctou: {
    stage: 'toctou',
    requestKeys: [
      'targetRoot',
      'targetId',
      'runId',
      'maxCommits',
      'maxSitesPerProducer',
      'fsms',
      'signalHandlers',
      'fixSubjectsOnly',
      'historyTimeLimitSeconds',
      'preferredBackend',
    ],
    serviceKeys: ['db', 'governor', 'runGit', 'sourceCache', 'detect', 'spawn', 'log', 'now'],
  },
  'pattern-capture': {
    stage: 'pattern-capture',
    requestKeys: [
      'candidate',
      'fingerprint',
      'originPatchSha',
      'postImageTargetId',
      'cacheDisabled',
      'timeoutMs',
    ],
    serviceKeys: ['db', 'programContext', 'invoker', 'now'],
  },
} as const satisfies Record<string, Handoff>

/**
 * The partition assertions.
 *
 * `KeysMatch<T, Keys>` is `true` only when `Keys` names every field of `T` and
 * nothing else, so each line below is the compile-time statement "this stage's
 * request half is exactly this list". Adding a field to any of these interfaces
 * without placing it in a half fails the typecheck with a type that names the
 * field.
 *
 * The runtime cost is zero — these are types assigned to a set of local
 * constants, and nothing reads them.
 */
const _reconRequest: KeysMatch<ReconRequest, (typeof HANDOFFS)['recon']['requestKeys']> = true
const _reconServices: KeysMatch<ReconServices, (typeof HANDOFFS)['recon']['serviceKeys']> = true

const _enginesRequest: KeysMatch<
  DiscoverRequest,
  (typeof HANDOFFS)['engines']['requestKeys']
> = true
const _enginesServices: KeysMatch<
  DiscoverServices,
  (typeof HANDOFFS)['engines']['serviceKeys']
> = true

const _osvRequest: KeysMatch<CorrelateRequest, (typeof HANDOFFS)['osv']['requestKeys']> = true
const _osvServices: KeysMatch<CorrelateServices, (typeof HANDOFFS)['osv']['serviceKeys']> = true

const _rediscoveryRequest: KeysMatch<
  RediscoveryCheckRequest,
  (typeof HANDOFFS)['rediscovery']['requestKeys']
> = true
const _rediscoveryServices: KeysMatch<
  RediscoveryCheckServices,
  (typeof HANDOFFS)['rediscovery']['serviceKeys']
> = true

const _pipelineRequest: KeysMatch<
  PipelineRequest,
  (typeof HANDOFFS)['pipeline']['requestKeys']
> = true
const _pipelineServices: KeysMatch<
  PipelineServices,
  (typeof HANDOFFS)['pipeline']['serviceKeys']
> = true

const _triageRequest: KeysMatch<TriageRequest, (typeof HANDOFFS)['triage']['requestKeys']> = true
const _triageServices: KeysMatch<TriageServices, (typeof HANDOFFS)['triage']['serviceKeys']> = true

const _verificationRequest: KeysMatch<
  VerificationRequest,
  (typeof HANDOFFS)['verification']['requestKeys']
> = true
const _verificationServices: KeysMatch<
  VerificationServices,
  (typeof HANDOFFS)['verification']['serviceKeys']
> = true

const _reportRequest: KeysMatch<ReportRequest, (typeof HANDOFFS)['report']['requestKeys']> = true
const _reportServices: KeysMatch<ReportServices, (typeof HANDOFFS)['report']['serviceKeys']> = true

const _variantHuntRequest: KeysMatch<
  VariantHuntRequest,
  (typeof HANDOFFS)['variant-hunting']['requestKeys']
> = true
const _variantHuntServices: KeysMatch<
  VariantHuntServices,
  (typeof HANDOFFS)['variant-hunting']['serviceKeys']
> = true

const _captureRequest: KeysMatch<
  CapturePatternRequest,
  (typeof HANDOFFS)['pattern-capture']['requestKeys']
> = true
const _captureServices: KeysMatch<
  CapturePatternServices,
  (typeof HANDOFFS)['pattern-capture']['serviceKeys']
> = true

const _patchMineRequest: KeysMatch<
  PatchMineRequest,
  (typeof HANDOFFS)['patch-mine']['requestKeys']
> = true
const _patchMineServices: KeysMatch<
  PatchMineServices,
  (typeof HANDOFFS)['patch-mine']['serviceKeys']
> = true

/**
 * The serializability assertions.
 *
 * Each line states "this request half is composed only of things JSON can carry".
 * This is the check that matters most, because it catches the failure the seam
 * exists to prevent: a request half quietly acquiring a host handle. `KeysMatch`
 * above would still pass if `db` were moved from `TriageServices` to
 * `TriageRequest` — both lists would be perfectly consistent, and the split would
 * be a lie. `JsonCompatible` is the one that notices the `Database` is not a
 * value a pipe can carry, and it fails at the move rather than at the first
 * worker spawn.
 *
 * The failure names the field rather than merely flagging the stage, so the fix
 * is visible in the error: `{ notSerializable: 'db' }` says which field has to
 * move to the services half.
 */
const _jsonRecon: SerializabilityCheck<ReconRequest> = true
const _jsonEngines: SerializabilityCheck<DiscoverRequest> = true
const _jsonOsv: SerializabilityCheck<CorrelateRequest> = true
const _jsonRediscovery: SerializabilityCheck<RediscoveryCheckRequest> = true
const _jsonPipeline: SerializabilityCheck<PipelineRequest> = true
const _jsonTriage: SerializabilityCheck<TriageRequest> = true
const _jsonVerification: SerializabilityCheck<VerificationRequest> = true
const _jsonReport: SerializabilityCheck<ReportRequest> = true
const _jsonVariantHunt: SerializabilityCheck<VariantHuntRequest> = true
const _jsonCapture: SerializabilityCheck<CapturePatternRequest> = true
const _jsonPatchMine: SerializabilityCheck<PatchMineRequest> = true

const _toctouRequest: KeysMatch<ToctouRequest, (typeof HANDOFFS)['toctou']['requestKeys']> = true
const _toctouServices: KeysMatch<ToctouServices, (typeof HANDOFFS)['toctou']['serviceKeys']> = true

const _jsonToctou: SerializabilityCheck<ToctouRequest> = true

/** Every stage this seam covers, in orchestrator order. */
export const HANDOFF_STAGES = Object.keys(HANDOFFS) as (keyof typeof HANDOFFS)[]

export type HandoffId = keyof typeof HANDOFFS
export type { Handoff }
