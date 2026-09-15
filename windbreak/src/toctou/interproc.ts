/**
 * Check-to-use across a call boundary (spec §4.4.3).
 *
 * `fsm.ts`'s `path-check-then-use` is the same-function form of the filesystem race:
 * a name is checked and then re-resolved *in the body that checked it*. This module is
 * the form §4.4.3's comparison point says a same-path matcher misses — the check and
 * the use are in different functions:
 *
 * ```c
 * if (access(cfg_path, R_OK) == 0) {   // the check, in the caller
 *   load_config(cfg_path);             // the call that reaches the re-resolution
 * }
 * ```
 *
 * and inside `load_config`:
 *
 * ```c
 * FILE *f = fopen(path, "r");          // the use, on the callee's parameter
 * ```
 *
 * The binding between the name and the object is established in the callee, and the
 * check that was supposed to hold for it happened in the caller. That is one call
 * deeper than `fsm.ts` can see, and it is the shape the module's own note calls out as
 * invisible: "the held-lock set is per-function", and here it is the *check* that is.
 *
 * ## Which direction, and why only one
 *
 * There are two ways to straddle a call — check-in-caller/use-in-callee, and
 * check-in-callee/use-in-caller — and only the first is implemented. The reason is
 * what each needs to be sure it is not a false positive:
 *
 * - **This direction needs no return-value reasoning.** The caller checked the name and
 *   then handed the name to a function that re-binds it. Whether the caller used the
 *   check's result is irrelevant to the claim, because the claim is about the *name*
 *   being re-resolved after the check.
 * - **The other direction needs it.** "The callee checked the parameter and the caller
 *   used the value afterwards" is only a defect if the callee's result was discarded,
 *   and the program model stores no return types. A callee returning `void` (one that
 *   aborts on failure) and one returning a status the caller ignores look identical
 *   from the call site. Calling both a race would be the overclaim this module must
 *   not make, so the direction is left out rather than guessed at.
 *
 * ## The gates, since a check-to-use pair across a call is easy to invent
 *
 * 1. The callee must re-resolve the name with a call from `PATH_USE_CALLS`. A callee
 *    that merely reads the string is not re-binding it.
 * 2. The position must line up: the argument the caller passed at the parameter the
 *    callee uses. Arguments are matched by position, which is why `parameterNames`
 *    exists and returns ordered, sparse slots.
 * 3. The caller's check must be a *path check* (`access`, `stat`, …) and must come
 *    strictly before the call. A check on the same line is left to `fsm.ts`, which
 *    orders events within a line and would not have to guess.
 * 4. The callee must not re-check the same parameter before it uses it. If it does,
 *    the callee's own check governs and nothing the caller did is the operative check.
 *
 * Every gate resolves toward reporting less, which is the same direction `alias.ts`
 * takes. The cost is that a genuinely racy pair the gates drop is not reported, and
 * that is the trade §4.4.3 asks for: a race needs a human to confirm.
 */

import { parameterNames } from '../patchmine/shapes'
import { aliases, buildBindings } from './alias'
import { callSites, extractEvents, isPathCheckEvent, isPathUseEvent } from './events'

import type { Bindings } from './alias'
import type { AtomicEvent, InterprocOtherLocation } from './types'

/**
 * What a function does with its own parameters, for a caller to reason about.
 *
 * Lines are file-relative. A summary is read by *another* function's sweep, which has
 * no region to translate against — the same reason `SignalOtherLocation` names its
 * `fileLine` explicitly. Ordering comparisons inside a summary are valid on file lines
 * because one summary describes one function.
 */
export interface CalleePathSummary {
  /** Parameter names in order; null where a parameter names nothing. */
  params: readonly (string | null)[]
  /** Parameter positions this function path-checks. */
  checks: readonly { index: number; fileLine: number }[]
  /** Parameter positions this function re-resolves with a path-use call. */
  uses: readonly { index: number; fileLine: number; callee: string }[]
}

/**
 * Summarize one callee's treatment of its parameters.
 *
 * Copy propagation is applied (`const char *p = path; open(p);` resolves `p` to
 * `path`), because a local alias is the ordinary way a path reaches a call. An
 * expression that resolves to no parameter — `open(path + ".tmp")` — is left out
 * rather than guessed at.
 */
export const summarizeCallee = (input: {
  lines: readonly string[]
  startLine: number
  /**
   * Already-extracted events and bindings, when the caller has them.
   *
   * The sweep extracts both for every function anyway (the lock annotation needs
   * them), so re-deriving them here would be the same work twice. Supplying them is
   * optional so this stays usable on its own, which is what the tests do.
   */
  events?: readonly AtomicEvent[]
  bindings?: Bindings
}): CalleePathSummary => {
  const params = parameterNames(input.lines)
  if (params.length === 0) return { params, checks: [], uses: [] }

  const events = input.events ?? extractEvents(input.lines)
  const bindings = input.bindings ?? buildBindings(input.lines)

  const indexOfParameter = (expression: string): number => {
    const key = bindings.resolve(expression)
    return params.indexOf(key)
  }

  const checks: Array<{ index: number; fileLine: number }> = []
  const uses: Array<{ index: number; fileLine: number; callee: string }> = []

  for (const event of events) {
    if (event.kind === 'check' && isPathCheckEvent(event)) {
      const index = indexOfParameter(event.key)
      if (index < 0) continue
      checks.push({ index, fileLine: input.startLine + event.line - 1 })
      continue
    }
    if (event.kind === 'use' && isPathUseEvent(event) && event.callee !== null) {
      const index = indexOfParameter(event.key)
      if (index < 0) continue
      uses.push({ index, fileLine: input.startLine + event.line - 1, callee: event.callee })
    }
  }

  return { params, checks, uses }
}

/** One cross-function check-to-use pair. Lines are region-relative to the caller. */
export interface InterprocFinding {
  /** The caller's path check. */
  checkLine: number
  /** The call that reaches the re-resolution. */
  callLine: number
  /** The caller's argument, after copy propagation. */
  resource: string
  other: InterprocOtherLocation
}

/**
 * Find the pairs where this function checks a name and then hands it to a callee that
 * re-resolves it.
 *
 * `calls` are the caller's outgoing edges, file-relative; `summaryOf` answers what a
 * callee does with its parameters, and null when the callee is outside the program
 * model — a missing input, never an assumption that it does nothing.
 */
export const interprocFindings = (input: {
  caller: {
    filePath: string
    functionName: string
    startLine: number
    lines: readonly string[]
    events: readonly AtomicEvent[]
    bindings: Bindings
  }
  calls: readonly { toFile: string; toFunction: string; line: number }[]
  summaryOf: (filePath: string, name: string) => CalleePathSummary | null
}): InterprocFinding[] => {
  const checks = input.caller.events.filter(
    (event) => event.kind === 'check' && isPathCheckEvent(event),
  )
  if (checks.length === 0) return []

  const findings: InterprocFinding[] = []
  const reported = new Set<string>()

  for (const call of input.calls) {
    const summary = input.summaryOf(call.toFile, call.toFunction)
    if (summary === null || summary.uses.length === 0) continue

    const regionLine = call.line - input.caller.startLine + 1
    const raw = input.caller.lines[regionLine - 1]
    if (raw === undefined) continue

    // Disambiguated by callee, so two calls on one line do not trade argument lists.
    const site = callSites(raw).find((candidate) => candidate.callee === call.toFunction)
    if (site === undefined) continue

    for (const use of summary.uses) {
      const argument = site.args[use.index]
      if (argument === undefined || argument.length === 0) continue

      // Gate 4: the callee re-checks this parameter before using it, so the callee's
      // own check is the operative one and there is no pair to report.
      if (summary.checks.some((check) => check.index === use.index && check.fileLine < use.fileLine)) {
        continue
      }

      // Gate 3: the check must be strictly earlier in the caller. Latest first, because
      // if a name is checked twice the second check is the one the call relies on.
      const check = [...checks]
        .reverse()
        .find(
          (candidate) =>
            candidate.line < regionLine &&
            aliases(candidate.key, argument, input.caller.bindings),
        )
      if (check === undefined) continue

      const resource = input.caller.bindings.resolve(argument)
      const key = `${check.line}|${use.fileLine}|${resource}`
      if (reported.has(key)) continue
      reported.add(key)

      findings.push({
        checkLine: check.line,
        callLine: regionLine,
        resource,
        other: {
          filePath: call.toFile,
          functionName: call.toFunction,
          fileLine: use.fileLine,
          callee: use.callee,
        },
      })
    }
  }

  return findings
}
