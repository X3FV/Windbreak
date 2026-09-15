/**
 * The sentence a finding carries (spec §4.4.3).
 *
 * This is the *only* place a finding becomes words, and it is one place on purpose.
 * Two properties are load-bearing and both were wrong when the prose was built
 * inside the detectors:
 *
 * 1. **The line numbers are file lines, not region lines.** An FSM is handed a
 *    function body, so the numbers it knows are relative to that body — and a
 *    candidate whose message said "checked at line 2" while pointing at line 22 was
 *    sending a reviewer to the wrong place. The translation is a parameter here
 *    (`toFileLine`), which is what makes it impossible to print an untranslated
 *    number: this module cannot see the region-relative value without being told how
 *    to convert it.
 * 2. **The framing is "check-to-use", not "memory corruption".** §4.4.3's stated
 *    priority is that this module is for logic flaws a human confirms, and §15
 *    records framing as moving detection by tens of percent. A message that opened
 *    with "buffer overflow" would put the candidate in a category no part of this
 *    module established.
 *
 * Both ends of a path are named, with line numbers: a reviewer reading "checked at
 * line 22, used at line 31" can look at two lines, whereas "possible TOCTOU" makes
 * them reconstruct the function first.
 */

import { FSM_DESCRIPTIONS, SIGNAL_SHAPE_DESCRIPTIONS } from './types'

import type { InterprocFinding } from './interproc'
import type {
  AtomicityRule,
  CallerLockContext,
  RuleViolation,
  SignalFinding,
  ToctouFinding,
  ToctouSite,
} from './types'

/** Translate a region-relative line number into the line a reviewer would open. */
export type LineTranslator = (regionLine: number) => number

/** Backtick an expression, or a fallback word when there is nothing to name. */
const tick = (value: string | null, fallback: string): string =>
  value === null || value.length === 0 ? fallback : `\`${value}\``

/**
 * The sentence for an FSM finding.
 *
 * One sentence per FSM rather than a template, because what a reviewer needs to know
 * differs: `double-fetch` has to convey that there were *two* reads, and
 * `lock-scope` has to convey that the lock was held and then dropped. A generic
 * "check at X, use at Y" would be true of all four and useful for none.
 */
export const describeFsmFinding = (
  finding: ToctouFinding,
  toFileLine: LineTranslator,
): string => {
  const check = toFileLine(finding.checkLine)
  const use = toFileLine(finding.useLine)
  const middle = finding.middleLine === null ? null : toFileLine(finding.middleLine)
  const resource = tick(finding.resource, 'the resource')

  switch (finding.fsm) {
    case 'path-check-then-use':
      return (
        `${resource} is checked at line ${check} and re-resolved at line ${use}; ` +
        'the name can be bound to a different object than the one the check saw'
      )

    case 'double-fetch':
      return middle === null
        ? `${resource} is checked at line ${check} and read again at line ${use}; ` +
            'the check saw only the first copy'
        : `${resource} is read at line ${middle}, checked at line ${check}, and read ` +
            `again at line ${use}; the check saw only the first copy`

    case 'lock-scope': {
      const lock = tick(finding.lock, 'the lock')
      return middle === null
        ? `${resource} is checked at line ${check} with ${lock} held and used at ` +
            `line ${use}, after the lock was released`
        : `${resource} is checked at line ${check} with ${lock} held, the lock is ` +
            `released at line ${middle}, and the value is used at line ${use}`
    }

    case 'lifetime-race':
      return middle === null
        ? `${resource} passes a check at line ${check}, is released, and is used at ` +
            `line ${use}`
        : `${resource} passes a check at line ${check}, is released at line ${middle}, ` +
            `and is used at line ${use}`
  }
}

/**
 * The sentence for an atomicity violation, with its rule's provenance.
 *
 * The mined rule and the patch it came from are part of the sentence rather than
 * left to the report, because the rule is the *premise* of the claim: "this project
 * decided `g.mu` guards `g.hits`, in commit d2fa956e0a9f" is what makes the finding
 * arguable, and a reviewer who disagrees with the finding needs that SHA to argue
 * with.
 */
/**
 * The caller-lock clause, or nothing when there is nothing to say.
 *
 * This is the interprocedural half of the sentence, and it is deliberately phrased as
 * evidence rather than as a verdict. "Every recorded caller holds `g.mu` across the
 * call" tells a reviewer where to look; it does not say the finding is benign, because
 * the call graph cannot see a function whose address is taken and so cannot prove it.
 * The word *recorded* is doing real work in both the complete and the partial case.
 */
const callerClause = (context: CallerLockContext | null, lock: string): string => {
  if (context === null) return ''

  if (context.callers === 0) {
    return '; the call graph records no call to this function, so it may be an entry point'
  }

  const base = context.allCallersLocked
    ? `; every recorded caller holds ${lock} across the call, so this may be a helper reached only locked`
    : context.lockedCallers === 0
      ? `; no recorded caller holds ${lock} across the call`
      : `; ${context.lockedCallers} of ${context.callers} recorded callers hold ${lock} across the call`

  return context.complete
    ? base
    : `${base}, and the caller set is partial, so a caller not in the graph may differ`
}

/**
 * The sentence for an atomicity violation, with its rule's provenance.
 *
 * The mined rule and the patch it came from are part of the sentence rather than
 * left to the report, because the rule is the *premise* of the claim: "this project
 * decided `g.mu` guards `g.hits`, in commit d2fa956e0a9f" is what makes the finding
 * arguable, and a reviewer who disagrees with the finding needs that SHA to argue
 * with.
 *
 * `callerLock` adds what the callers do with the rule's lock, when the interprocedural
 * pass ran. It comes before the provenance parenthesis so the parenthesis still closes
 * the sentence.
 */
export const describeViolation = (
  violation: RuleViolation,
  rule: AtomicityRule,
  toFileLine: LineTranslator,
  callerLock: CallerLockContext | null = null,
): string => {
  const line = toFileLine(violation.line)
  const resource = tick(violation.resource, 'the resource')
  const lock = tick(rule.lock, 'the lock')

  // A clause, not a clause fragment: it is concatenated after "accessed at line N",
  // so it has to supply its own connecting word or the sentence reads as
  // "accessed at line 19 with `g.mu` is never held".
  const where = violation.heldElsewhere
    ? `but ${lock} is held elsewhere in the function, not at that line`
    : `with ${lock} never held in this function`

  return (
    `${resource} is accessed at line ${line} ${where}${callerClause(callerLock, lock)} ` +
    `(atomicity rule ${rule.id}, mined from ${rule.originPatchSha.slice(0, 12)} in ` +
    `${rule.originFile})`
  )
}

/**
 * `SIGINT`, `` `SIGINT` and `SIGTERM` ``, or nothing when the registration could not
 * be paired with a signal.
 *
 * Spelled out rather than shortened to a count because the signals are the shape's
 * premise: `reentrancy-window` reads as an overclaim until the reader sees that two
 * different signals are involved.
 */
const signalNames = (signals: readonly string[]): string => {
  const named = signals.filter((signal) => signal.length > 0).map((signal) => `\`${signal}\``)
  if (named.length === 0) return ''
  if (named.length === 1) return named[0]!
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`
}

/**
 * The sentence for a signal finding.
 *
 * One sentence per shape, because the four failures are different failures and the
 * reviewer's next question is different for each: for `unsafe-call` it is "what was it
 * interrupting", for `shared-state` it is "who else touches this", for
 * `reentrancy-window` it is "how can it run twice". A shared template would be true of
 * all four and answer none.
 *
 * The async context is stated rather than assumed. Nothing in the sentence says
 * "possible race" without also saying that the code runs in a handler, because that is
 * the fact that makes it a race and it is not recoverable from the line.
 */
export const describeSignalFinding = (
  finding: SignalFinding,
  toFileLine: LineTranslator,
): string => {
  const registered = signalNames(finding.signals)
  // Two forms, because the shapes need the phrase in different positions: "in a signal
  // handler registered for X" reads, whereas "the handler is registered for X" does not
  // want the noun. Using the second for both positions produced "in registered for
  // `SIGHUP`" in the first CLI run over a real target.
  const asLocation =
    registered.length > 0 ? `a signal handler registered for ${registered}` : 'a signal handler'
  const asProperty = registered.length > 0 ? `registered for ${registered}` : 'a signal handler'

  switch (finding.shape) {
    case 'unsafe-call':
      return (
        `\`${finding.callee}\` is called at line ${toFileLine(finding.line)} in ` +
        `${asLocation}, and it is not async-signal-safe: the signal can arrive while that ` +
        'function is mid-update, so the handler runs against state it was never written to share'
      )

    case 'reentrancy-window': {
      const resource = tick(finding.resource, 'the resource')
      return (
        `${resource} is released at line ${toFileLine(finding.releaseLine)} and only cleared ` +
        `at line ${toFileLine(finding.invalidateLine)}; the handler is ${asProperty}, so a ` +
        'second delivery re-enters inside that window and releases it again'
      )
    }

    case 'shared-state': {
      const resource = tick(finding.resource, 'the object')
      const other = finding.other
      const where =
        `${other.filePath}:${other.fileLine} in \`${other.functionName}\`` +
        (other.isHandler ? ' (another handler)' : '')
      return (
        `${resource} is ${finding.wrote ? 'written' : 'read'} at line ` +
        `${toFileLine(finding.line)} in ${asLocation} and ${other.written ? 'written' : 'read'} ` +
        `at ${where}; it is not \`sig_atomic_t\`, so whichever runs is interrupted ` +
        'mid-update and sees the other\'s half-finished value'
      )
    }

    case 'non-local-jump':
      return (
        `\`${finding.callee}\` is called at line ${toFileLine(finding.line)} in ${asLocation}, ` +
        'so the handler never returns to the code it interrupted and that code is left ' +
        'mid-update — any lock, allocation or partially-written structure it held is not ' +
        'unwound'
      )
  }
}

/**
 * The sentence for a check-to-use pair that spans a call.
 *
 * Both functions are named, and the far end carries its own file, because that is the
 * whole content of the claim: the check and the re-resolution are in *different*
 * places, and a sentence that named only one of them would be describing the
 * same-function FSM instead. It ends with the same clause `fsm.ts`'s path form uses,
 * because the defect is the same one — only the distance differs.
 *
 * The two ends are translated differently and that is the point: the check and the call
 * belong to the region being swept, so they go through `toFileLine`; the far end was
 * translated by the summary that found it and is already a file line.
 */
export const describeInterprocFinding = (
  finding: InterprocFinding,
  toFileLine: LineTranslator,
): string => {
  const resource = tick(finding.resource, 'the path')
  const other = finding.other

  return (
    `${resource} is checked at line ${toFileLine(finding.checkLine)} and passed to ` +
    `\`${other.functionName}\` at line ${toFileLine(finding.callLine)}, which re-resolves ` +
    `the name with \`${other.callee}\` at ${other.filePath}:${other.fileLine}; the name can ` +
    'be bound to a different object than the one the check saw'
  )
}

/**
 * The candidate message for a site.
 *
 * A site already carries file line numbers and its own sentence, so this only adds
 * the framing prefix. The `fsm` and `shape` prefixes name the machine, because "which
 * pattern is this" is the first question a reviewer asks and it is not recoverable
 * from the prose alone — and for a signal site the prefix carries the CWE-364 framing
 * that §4.4.3's priority rule asks for.
 */
export const describeSite = (site: ToctouSite): string => {
  switch (site.kind) {
    case 'fsm':
      return `Check-to-use ordering (${site.fsm}) — ${FSM_DESCRIPTIONS[site.fsm]}. ${site.evidence}`
    case 'signal':
      return (
        `Signal handler race (${site.shape}) — ${SIGNAL_SHAPE_DESCRIPTIONS[site.shape]}. ` +
        site.evidence
      )
    case 'atomicity':
      return `Atomicity violation — ${site.evidence}`
    case 'interproc':
      // Named as an ordering claim over a *call*, because that is the difference from
      // the same-function form and the reviewer's next question is "which callee".
      return `Check-to-use ordering across a call — ${site.evidence}`
  }
}
