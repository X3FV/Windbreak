/**
 * The four check-to-use finite state machines (spec §4.4.3).
 *
 * §4.4.3 asks for the four dangerous patterns to be *encoded as FSMs* and candidate
 * code paths *validated against them*. Both halves matter: the encoding is what
 * makes each pattern an ordered statement rather than a same-line match, and
 * "validated against" is why each FSM returns findings with the check line, the use
 * line, and the resource they share — a finding is a claim about a *path through*
 * the function, and a reviewer needs the two ends of it.
 *
 * `types.ts` records why this list of four and not another. What is worth repeating
 * here is how the alias relation is used, because it is the difference between a
 * useful instrument and a noisy one:
 *
 * - **Same resource** — `aliases`, must-alias after normalization and copy
 *   propagation. Two parameters that point at the same struct at runtime are two
 *   resources here; a race between them is missed, which is the precision-holding
 *   direction.
 * - **Lock covers access** — `guardedBy`, which is containment, so holding `m`
 *   covers `m.field`. Without that, no correctly-locked region would ever be
 *   recognised as correctly locked.
 *
 * Two of the four use the held-lock set as a veto, and that veto is the module's
 * main precision mechanism. A check and a use that are both inside the same held
 * lock are not a race — they are the fix.
 */

import { aliases, guardedBy } from './alias'
import { isPathCheckEvent, isPathUseEvent, isUseEvent } from './events'

import type { Bindings } from './alias'
import type { AtomicEvent, ToctouFinding, ToctouFsm } from './types'

/**
 * Run one FSM over an event stream.
 *
 * Returns findings in the order the *use* appears, so the output reads down the
 * function. Duplicates within a resource are collapsed: one defect reported at
 * three lines is still one defect, and the first pair is the one a reviewer wants.
 */
export const runFsm = (
  fsm: ToctouFsm,
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] => {
  switch (fsm) {
    case 'path-check-then-use':
      return pathCheckThenUse(events, bindings)
    case 'double-fetch':
      return doubleFetch(events, bindings)
    case 'lock-scope':
      return lockScope(events, bindings)
    case 'lifetime-race':
      return lifetimeRace(events, bindings)
    default:
      return []
  }
}

/** Run every FSM, tagged with which one fired. */
export const runAllFsms = (
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] =>
  (['path-check-then-use', 'double-fetch', 'lock-scope', 'lifetime-race'] as const).flatMap(
    (fsm) => runFsm(fsm, events, bindings),
  )

/**
 * FSM 1 — a path is checked, then re-resolved by a later call.
 *
 * The check is a path-checking *call* (`access`, `stat`, …), not a comparison: the
 * claim is specifically that a question was asked about a *name* and the name was
 * later bound to an object. Fires on the latest such check preceding the use, which
 * is the one a reviewer would consider the operative check.
 */
const pathCheckThenUse = (
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] => {
  const findings: ToctouFinding[] = []
  const reported = new Set<string>()
  const checks: AtomicEvent[] = []

  for (const event of events) {
    if (event.kind === 'check' && isPathCheckEvent(event)) {
      checks.push(event)
      continue
    }
    if (event.kind !== 'use' || !isPathUseEvent(event)) continue
    if (event.key.length === 0) continue

    // Latest first: if a path was checked twice, the second check is the one the
    // use is entitled to rely on.
    const check = [...checks]
      .reverse()
      .find((candidate) => aliases(candidate.key, event.key, bindings))
    if (!check) continue

    const key = bindings.resolve(event.key)
    if (reported.has(key)) continue
    reported.add(key)

    findings.push({
      fsm: 'path-check-then-use',
      checkLine: check.line,
      // Nothing between the two ends: the check and the call are adjacent events in
      // the property this FSM is about.
      middleLine: null,
      useLine: event.line,
      resource: key,
      lock: null,
    })
  }

  return findings
}

/**
 * FSM 2 — a value is read, checked, then read again from the same source.
 *
 * The second read is the defect. The check ran against the first copy, and the
 * attacker controls what the second one returns, so the checked value is not the
 * used value. Requires the two fetches to share a *source* expression: two reads
 * from different sources are two different values, not a double fetch.
 */
const doubleFetch = (
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] => {
  const findings: ToctouFinding[] = []
  const reported = new Set<string>()
  const fetches = events.filter((event) => event.kind === 'fetch')

  for (let index = 0; index < fetches.length; index += 1) {
    const first = fetches[index]!
    if (first.source === null || first.source.length === 0) continue

    // Which locals the first read landed in, and what it read from.
    const second = fetches
      .slice(index + 1)
      .find((candidate) => candidate.source !== null && aliases(candidate.source, first.source!, bindings))
    if (!second) continue

    // The check must sit between the two reads and be about the first copy —
    // otherwise nothing was checked about the value the second read returns.
    const check = events.find(
      (event) =>
        event.kind === 'check' &&
        event.line > first.line &&
        event.line <= second.line &&
        (first.target === null || aliases(event.key, first.target, bindings)),
    )
    if (!check) continue

    const key = bindings.resolve(first.source)
    if (reported.has(key)) continue
    reported.add(key)

    findings.push({
      fsm: 'double-fetch',
      checkLine: check.line,
      // The first read, so the sentence can say which read the check was about.
      middleLine: first.line,
      useLine: second.line,
      resource: key,
      lock: null,
    })
  }

  return findings
}

/**
 * FSM 3 — a resource is checked under a lock that is released before the use.
 *
 * The invariant was established under the lock and the use does not hold it, so
 * the invariant is not known to hold at use time. The held-lock set at the check is
 * the state; the finding is the transition out of it.
 */
const lockScope = (
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] => {
  const findings: ToctouFinding[] = []
  const reported = new Set<string>()
  const held: string[] = []
  const checks: Array<{ key: string; line: number; heldAt: string[] }> = []
  /** Where each lock was last released, so a finding can name that line. */
  const releasedAt = new Map<string, number>()

  const release = (key: string): void => {
    const at = held.findIndex((lock) => aliases(lock, key, bindings))
    if (at >= 0) held.splice(at, 1)
  }

  for (const event of events) {
    if (event.kind === 'lock') {
      held.push(event.key)
      continue
    }
    if (event.kind === 'unlock') {
      releasedAt.set(bindings.resolve(event.key), event.line)
      release(event.key)
      continue
    }

    if (event.kind === 'check') {
      // Only a check that was actually under a lock can be released too early.
      if (event.key.length > 0 && held.length > 0) {
        checks.push({ key: event.key, line: event.line, heldAt: [...held] })
      }
      continue
    }

    if (!isUseEvent(event) || event.key.length === 0) continue

    const candidate = [...checks].reverse().find((entry) => aliases(entry.key, event.key, bindings))
    if (!candidate) continue

    // The veto: if the lock that protected the check is still held, the use is
    // inside the critical section and there is nothing to report.
    const stillHeld = candidate.heldAt.some((lock) => held.some((current) => aliases(lock, current, bindings)))
    if (stillHeld) continue

    const lock = candidate.heldAt[0]!
    const key = `${bindings.resolve(event.key)}|${bindings.resolve(lock)}`
    if (reported.has(key)) continue
    reported.add(key)

    findings.push({
      fsm: 'lock-scope',
      checkLine: candidate.line,
      // Where the lock was let go. Null when the region ends without a release the
      // function shows, which is why the field is nullable rather than required.
      middleLine: releasedAt.get(bindings.resolve(lock)) ?? null,
      useLine: event.line,
      resource: bindings.resolve(event.key),
      lock,
    })
  }

  return findings
}

/**
 * FSM 4 — a resource passes a validity check, is released, and is still used.
 *
 * Another thread can free the object between the check and the use, so the check's
 * answer is stale by construction. The held-lock veto applies here too: a check and
 * a use both inside one held lock cannot be raced by a caller that would have to
 * take the same lock to free the object.
 */
/**
 * The entry whose key *covers* this one, by equality or by containment.
 *
 * Containment is the correction that makes this FSM work at all: freeing `p`
 * invalidates `p->field` and `p[i]` as well, so a version that matched keys by
 * equality would never pair `free(p)` with the very next `p->field = 1` — the exact
 * shape the FSM exists for. The same relation is what lets a null test on `p` count
 * as a check of what `p` points at.
 */
const covering = <T>(
  table: ReadonlyMap<string, T>,
  key: string,
  bindings: Bindings,
): T | null => {
  for (const [candidate, value] of table) {
    if (aliases(candidate, key, bindings) || guardedBy(candidate, key)) return value
  }
  return null
}

const lifetimeRace = (
  events: readonly AtomicEvent[],
  bindings: Bindings,
): ToctouFinding[] => {
  const findings: ToctouFinding[] = []
  const held: string[] = []
  const checks = new Map<string, { line: number; heldAt: string[] }>()
  const released = new Map<string, { line: number; checkLine: number; heldAt: string[] }>()

  const release = (key: string): void => {
    const at = held.findIndex((lock) => aliases(lock, key, bindings))
    if (at >= 0) held.splice(at, 1)
  }

  for (const event of events) {
    if (event.kind === 'lock') {
      held.push(event.key)
      continue
    }
    if (event.kind === 'unlock') {
      release(event.key)
      continue
    }

    if (event.kind === 'check' && event.key.length > 0) {
      checks.set(bindings.resolve(event.key), { line: event.line, heldAt: [...held] })
      continue
    }

    if (event.kind === 'release' && event.key.length > 0) {
      const key = bindings.resolve(event.key)
      const check = covering(checks, key, bindings)
      if (check) {
        released.set(key, { line: event.line, checkLine: check.line, heldAt: check.heldAt })
      }
      continue
    }

    if (!isUseEvent(event) || event.key.length === 0) continue

    const used = bindings.resolve(event.key)
    let key: string | null = null
    for (const candidate of released.keys()) {
      if (aliases(candidate, used, bindings) || guardedBy(candidate, used)) {
        key = candidate
        break
      }
    }
    if (key === null) continue

    const entry = released.get(key)!
    released.delete(key)

    const protectedNow = entry.heldAt.some((lock) =>
      held.some((current) => aliases(lock, current, bindings)) ||
      guardedBy(lock, event.key),
    )
    if (protectedNow) continue

    findings.push({
      fsm: 'lifetime-race',
      checkLine: entry.checkLine,
      // The release, which is the event the whole FSM is about.
      middleLine: entry.line,
      useLine: event.line,
      resource: key,
      lock: entry.heldAt[0] ?? null,
    })
  }

  return findings
}
