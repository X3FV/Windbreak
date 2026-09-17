/**
 * Reachability from attacker-controlled entry points (spec §4.4.4).
 *
 * The module answers the question a triager asks first and a detector cannot: *can an
 * attacker get here?* It is deliberately split so each part can be read — and tested —
 * on its own:
 *
 * - `entries` is the inventory: which callables the index can be entered at, and *why*
 *   each one counts. Nothing here reads source; it is a claim per definition.
 * - `graph` is the closure over the shared call graph, plus the counters that keep "no
 *   path" apart from "path unknown".
 * - `run` composes them into the pass the scan stage calls.
 * - `persist` is the I/O: the inventory table and the per-candidate conclusion.
 * - `format` renders both, so the summary line and the evidence bundle cannot disagree.
 *
 * The property to keep in mind while changing any of it: **exclusion is the only
 * consequence**, and it is the one direction where being wrong loses a real finding. A
 * site is recorded as `unreachable` only when every caller set feeding it is complete;
 * anything less is `unknown`, with the reason, and `unknown` reports.
 */

export {
  ATTACKER_INPUT_KINDS,
  ENTRY_KINDS,
  FUZZ_ENTRY_NAMES,
  INPUT_SOURCE_CALLS,
  findEntryPoints,
} from './entries'
export {
  REACHABILITY_CLASSES,
  REACHABLE_CLASSES,
  analyzeReachability,
  droppedCallersReason,
} from './graph'
export { describeReachability, formatReachabilityCoverage } from './format'
export {
  parseCandidateReachability,
  persistCandidateReachability,
  persistEntryPoints,
  reachabilityToJson,
  readCandidateReachability,
  readEntryPoints,
} from './persist'
export { runReachability } from './run'

export type { EntryKind, EntryPoint } from './entries'
export type {
  ReachCounts,
  ReachCoverage,
  ReachEntryRef,
  ReachStep,
  ReachabilityAnalysis,
  ReachabilityClass,
  ReachabilityRecord,
  SiteReachability,
} from './graph'
export type { CandidateReachability } from './persist'
export type { ReachabilityOutcome, ReachabilityRunOptions } from './run'
