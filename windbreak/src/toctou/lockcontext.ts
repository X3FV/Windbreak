/**
 * Lock context, and what a function's *callers* do with an atomicity rule's lock
 * (spec §4.4.3).
 *
 * The four FSMs and the rule sweep are handed one function body, and `scan.ts` says
 * what that costs: "the held-lock set is per-function — a lock held in a caller is
 * invisible, which is a real recall cost and the right precision call." This module is
 * the first half of relaxing it. It answers one question about a rule violation:
 *
 * > this function touches the resource without the lock — but do the functions that
 * > call it hold the lock?
 *
 * The counterexample is a helper that is only ever reached with the lock held.
 * Reported from inside the helper it looks like a violation; read from its callers it
 * is the fix. `handlerKey`-style intuition does not help here — the fact lives on the
 * call edge, not in the body.
 *
 * ## Why this *annotates* rather than suppresses
 *
 * The tempting move is to drop the finding when every caller holds the lock, and the
 * program model cannot support it. Every reference recon indexes is a call
 * expression (`recon/queries.ts` captures `@reference.call` and nothing else), so a
 * function whose **address is taken** — a callback, a signal handler, a thread entry
 * point — has no incoming edge and no way to say so. Suppressing on "every recorded
 * caller holds the lock" would therefore delete a real finding for exactly the code
 * most likely to race.
 *
 * That is a different kind of loss from the module's other trades. `alias.ts` loses
 * recall by *not pairing* two events; this would remove a finding that was already
 * produced. So the verdict is carried on the site and into the evidence sentence, the
 * reviewer and triage see it, and nothing is dropped. Closing the hole properly means
 * recording address-of references in recon, which is its own piece of work.
 */

import { aliases } from './alias'

import type { Bindings } from './alias'
import type { CallEdge } from '../interproc/callgraph'
import type { AtomicEvent, CallerLockContext } from './types'

/** A half-open span of lines during which a lock is held. `from` and `to` inclusive. */
export interface LockInterval {
  from: number
  to: number
}

/**
 * The lock-held intervals a rule's lock establishes in one function.
 *
 * Intervals rather than a boolean, because the question a rule asks is *where* the
 * lock was held: an access between the acquire and its release is protected, and an
 * access after the release — or before the acquire — is not. A boolean would report
 * a use before the lock as protected.
 *
 * An unmatched acquire (no release in the function) ends the interval at the end of
 * the function. That is the conservative reading: the lock is treated as held for
 * the rest of the body, so a use inside it is *not* reported. Under-reporting here
 * is deliberate — a `return` that skips the release is a resource leak, which is a
 * different defect than the one this module is about.
 */
export const lockIntervals = (
  events: readonly AtomicEvent[],
  lock: string,
  bindings: Bindings,
  lastLine: number,
): LockInterval[] => {
  const intervals: LockInterval[] = []
  let openedAt: number | null = null

  for (const event of events) {
    if (event.kind === 'lock' && aliases(event.key, lock, bindings)) {
      if (openedAt === null) openedAt = event.line
      continue
    }
    if (event.kind === 'unlock' && aliases(event.key, lock, bindings)) {
      if (openedAt !== null) {
        intervals.push({ from: openedAt, to: event.line })
        openedAt = null
      }
    }
  }

  if (openedAt !== null) intervals.push({ from: openedAt, to: lastLine })
  return intervals
}

/** Whether a line falls inside any of the intervals. */
export const covered = (line: number, intervals: readonly LockInterval[]): boolean =>
  intervals.some((interval) => line >= interval.from && line <= interval.to)

/**
 * Judge one function's callers against an atomicity rule's lock.
 *
 * `intervalsOf` returns the caller function's held-lock intervals *for this rule's
 * lock*, or null when the caller's body was not available. Null counts as "does not
 * hold it" — the precision-holding direction, and the same one `alias.ts` takes for
 * an unresolvable expression: an unknown that is treated as protection is a
 * suppression nobody can see.
 *
 * `complete` is supplied by the caller from `CallGraph.droppedCallersOf`, because
 * completeness is a fact about the graph rather than about this function.
 */
export const callerLockVerdict = (input: {
  callers: readonly CallEdge[]
  complete: boolean
  intervalsOf: (filePath: string, name: string) => readonly LockInterval[] | null
}): CallerLockContext => {
  let lockedCallers = 0

  for (const caller of input.callers) {
    const intervals = input.intervalsOf(caller.fromFile, caller.fromFunction)
    if (intervals !== null && covered(caller.line, intervals)) lockedCallers += 1
  }

  return {
    callers: input.callers.length,
    lockedCallers,
    complete: input.complete,
    // A caller set of zero is not "all callers hold the lock" — it is a function
    // nothing recorded calls, which is the opposite conclusion.
    allCallersLocked:
      input.complete && input.callers.length > 0 && lockedCallers === input.callers.length,
  }
}
