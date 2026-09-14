/**
 * Check-to-use / race detection (spec §4.4.3).
 *
 * §4.4.3 is the capability the spec treats as distinctive: mine atomicity rules from
 * the target's own history, encode four dangerous check-to-use patterns as finite
 * state machines, validate candidate paths against them with alias analysis, and
 * prefer *logic flaw* framing over memory corruption.
 *
 * The split follows what each part depends on, which is also the order to read it in:
 *
 * - `alias` is the precision instrument — `normalizeExpression`/`baseOf`/`aliases`
 *   for "same object", `guardedBy` for "covered by this lock" (containment, not
 *   equality).
 * - `events` reduces a function body to an ordered `AtomicEvent` stream. The
 *   classification tables at its top are the module's actual judgement about C code.
 * - `fsm` is the four machines over that stream (`types.ts` records why these four).
 * - `handlers` identifies signal handlers and holds the async-signal-safety table.
 *   Its first job is the one input the other machines never need: a handler is a
 *   handler because *another* function registered it.
 * - `signal` is the four CWE-364 shapes over a handler, which are not check-to-use
 *   pairs and so are a separate finding type rather than a fifth machine.
 * - `rules` mines atomicity pairings from lock-adding hunks. Pure.
 * - `scan` sweeps the program model with every producer and caps each one, plus the
 *   cross-function pre-pass the signal producer needs.
 * - `run` composes them into §4.5 candidates, reading the target's history through a
 *   sandboxed runner.
 *
 * The one property to keep in mind: every ambiguity resolves toward reporting less.
 * An FSM match is a claim about a race, a race needs a human to confirm it, and a
 * detector that cries wolf is one nobody reads — so unresolvable aliases do not
 * alias, a lock that is held at use time vetoes the finding, and a shape with no
 * portable operation is never swept.
 */

export {
  aliases,
  anyGuards,
  baseOf,
  buildBindings,
  guardedBy,
  hasFieldPath,
  normalizeExpression,
  stripAddress,
} from './alias'
export {
  accessedExpressions,
  bodyStartIndex,
  callSites,
  extractEvents,
  isPathCheckEvent,
  isPathUseEvent,
  isUseEvent,
  FETCH_CALLS,
  LIFETIME_RELEASE_CALLS,
  LOCK_ACQUIRE_CALLS,
  LOCK_RELEASE_CALLS,
  PATH_CHECK_CALLS,
  PATH_USE_CALLS,
} from './events'
export { runAllFsms, runFsm } from './fsm'
export {
  ASYNC_UNSAFE_CALLS,
  NON_LOCAL_JUMP_CALLS,
  findSignalHandlers,
  isAsyncUnsafe,
  isNonLocalJump,
  registrationsIn,
} from './handlers'
export {
  SIGNAL_MASK_CALLS,
  fileScopeDeclarations,
  globalTouches,
  identifierTokens,
  invalidatedKeys,
  masksSignals,
  nonLocalJumps,
  reentrancyWindows,
  runSignalShapes,
  sharedStateRaces,
  signalFindingCheckLine,
  signalFindingLine,
  unsafeCalls,
} from './signal'
export { addsLock, atomicityRuleId, guardedResources, mergeRules, mineRulesFromHunks } from './rules'
export {
  DEFAULT_MAX_SITES_PER_PRODUCER,
  buildSignalPrePass,
  ruleViolations,
  sweepFunctions,
} from './scan'
export { MIN_SWEEP_MS, producerId, runToctou } from './run'
export {
  describeFsmFinding,
  describeSignalFinding,
  describeSite,
  describeViolation,
} from './describe'
export {
  ATOMIC_EVENT_KINDS,
  FSM_DESCRIPTIONS,
  SIGNAL_SHAPES,
  SIGNAL_SHAPE_DESCRIPTIONS,
  TOCTOU_FSMS,
  handlerKey,
  signalProducer,
} from './types'

export type { Bindings } from './alias'
export type { AccessSite, CallSite } from './events'
export type { HandlerCandidate, Registration, SignalHandlerIndex } from './handlers'
export type { GlobalTouch, SignalShapeResult, SignalShapesInput } from './signal'
export type { RuleMiningResult } from './rules'
export type { LineTranslator } from './describe'
export type { SignalPrePass, SweepOptions, SweepResult } from './scan'
export type {
  ToctouOptions,
  ToctouOutcome,
  ToctouRequest,
  ToctouResult,
  ToctouServices,
} from './run'
export type {
  AtomicEvent,
  AtomicEventKind,
  AtomicityRule,
  FileScopeDeclarations,
  RuleViolation,
  SignalFinding,
  SignalHandler,
  SignalOtherLocation,
  SignalShape,
  ToctouCoverage,
  ToctouFinding,
  ToctouFsm,
  ToctouSite,
  ToctouSweepOutcome,
} from './types'
