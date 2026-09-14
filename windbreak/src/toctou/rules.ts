/**
 * Mining atomicity rules from historical patches (spec §4.4.3, part 1).
 *
 * §4.4.3 asks for atomicity rules to be mined from patches: "which shared
 * variables or locks must not be touched between a check and its corresponding
 * use". This is the same insight as §4.4.1's shape mining applied to *locks*
 * instead of to guards, and it is worth being precise about why it is a stronger
 * premise than the usual one.
 *
 * ## Why mined, and not assumed
 *
 * The generic rule is "shared data needs a lock", which is a claim about the
 * *language*. A mined rule is a claim about *this project*: some commit added
 * `mutex_lock(&s->mu)` around `s->count`, so this codebase has already decided
 * that pairing is necessary. That is much harder to argue with, and it is why the
 * sweep can be aggressive — every rule carries the SHA that established it, so a
 * bad rule is traceable to a patch and a wrong-looking finding can be argued about
 * at its source.
 *
 * ## What counts as a lock-adding patch
 *
 * A hunk qualifies when it **added** a lock acquire or release line. That is the
 * §4.4.1 `lock` shape, and reusing the criterion is deliberate: a hunk that merely
 * contains locking in its context is a hunk where the locking was already there,
 * so pairing its resources would mine a rule from behaviour the patch did not
 * change.
 *
 * ## The two pairing modes, and why there are two
 *
 * The resource has to be identified from the patch, and how that works depends on
 * what the lock is:
 *
 * - **A member lock** (`s->mu`) — the lock is a field of the same object the
 *   resource belongs to, so resources sharing the lock's **base identifier** are
 *   what it guards. `baseOf` is why this is checkable at a site the mining never
 *   saw.
 * - **A bare lock** (`g_mu`) — a global mutex guards whatever is accessed between
 *   its acquire and its release, and there is no base to match on. The region is
 *   the only evidence available.
 *
 * A patch can produce both kinds, and both are emitted; the sweep treats them the
 * same because both are the same statement — *this* resource requires *that* lock.
 *
 * ## What a rule is not
 *
 * It is not a claim that the patch is *correct*. A commit that added a lock around
 * one field of a struct it also accesses elsewhere is a commit that mined a rule
 * that its own code violates; that is a real possibility, it is the same one §4.4.1
 * accepts for shapes, and it is why a violation is a candidate for a human rather
 * than a finding.
 */

import { createHash } from 'crypto'

import { baseOf, hasFieldPath, normalizeExpression } from './alias'
import {
  LOCK_ACQUIRE_CALLS,
  LOCK_RELEASE_CALLS,
  accessedExpressions,
  callSites,
} from './events'

import type { Hunk } from '../patchmine/types'
import type { AtomicityRule } from './types'

const ACQUIRES = new Set<string>(LOCK_ACQUIRE_CALLS)
const RELEASES = new Set<string>(LOCK_RELEASE_CALLS)

/** Stable rule key: the pairing, since that is what the sweep acts on. */
export const atomicityRuleId = (resource: string, lock: string): string =>
  `ar_${createHash('sha256').update(`${resource}|${lock}`).digest('hex').slice(0, 16)}`

/** One line of a hunk's post-image, with the number it has after the patch. */
interface PostLine {
  text: string
  /** Line number in the post-image, 1-based. */
  line: number
  /** True when the patch itself added this line. */
  added: boolean
}

const postImageWithLines = (hunk: Hunk): PostLine[] => {
  const lines: PostLine[] = []
  for (const diffLine of hunk.lines) {
    if (diffLine.kind === 'removed') continue
    lines.push({
      text: diffLine.text,
      line: diffLine.newLine ?? hunk.newStart + lines.length,
      added: diffLine.kind === 'added',
    })
  }
  return lines
}

/** The lock a lock/unlock call is about: its first argument, normalized. */
const lockArgument = (line: string): { lock: string; callee: string; kind: 'acquire' | 'release' } | null => {
  for (const site of callSites(line)) {
    const argument = site.args[0]
    if (argument === undefined || argument.trim().length === 0) continue
    if (ACQUIRES.has(site.callee)) {
      return { lock: normalizeExpression(argument), callee: site.callee, kind: 'acquire' }
    }
    if (RELEASES.has(site.callee)) {
      return { lock: normalizeExpression(argument), callee: site.callee, kind: 'release' }
    }
  }
  return null
}

/**
 * The resources a hunk's added lock is shown guarding.
 *
 * Returns normalized expression keys. See the module note for the two pairing
 * modes. The region is what bounds the bare-lock mode: from the acquire to its
 * matching release when both are in the hunk, and to the end of the hunk when the
 * release is outside it (which is common, since a hunk shows three lines of
 * context on each side).
 */
export const guardedResources = (hunk: Hunk): { resources: string[]; lock: string } | null => {
  const lines = postImageWithLines(hunk)

  // The anchor: a lock the *patch* added. Without one this hunk established no
  // pairing, whatever else it contains.
  let anchor = -1
  let lock: { lock: string; callee: string; kind: 'acquire' | 'release' } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.added) continue
    const found = lockArgument(lines[index]!.text)
    if (!found) continue
    // An added *release* is a lock this patch introduced too — a hunk that adds
    // the `unlock` is adding the critical section's end, and the acquire is then
    // in the hunk's context above it.
    anchor = index
    lock = found
    if (found.kind === 'acquire') break
  }

  if (!lock || anchor === -1) return null

  // Walk back to the acquire when the anchor is the release, so the region is the
  // critical section rather than the tail of it.
  let start = anchor
  if (lock.kind === 'release') {
    for (let index = anchor; index >= 0; index -= 1) {
      const found = lockArgument(lines[index]!.text)
      if (found && found.kind === 'acquire' && normalizeExpression(found.lock) === lock.lock) {
        start = index
        break
      }
    }
  }

  // The region ends at the first matching release after the acquire, or at the end
  // of the hunk when the hunk does not show one.
  let end = lines.length - 1
  for (let index = start + 1; index < lines.length; index += 1) {
    const found = lockArgument(lines[index]!.text)
    if (found && found.kind === 'release' && normalizeExpression(found.lock) === lock.lock) {
      end = index
      break
    }
  }

  const region = lines.slice(start, end + 1)
  const lockKey = normalizeExpression(lock.lock)
  const memberLock = hasFieldPath(lockKey)
  const lockBase = baseOf(lockKey)

  // `from: 0` because the region is a diff fragment, not a function — it has no
  // signature to skip and its first brace is whatever brace happens to be inside
  // the critical section. Line numbers come back region-relative, which is why the
  // PostLine is looked up by index rather than by number.
  const accesses = accessedExpressions(
    region.map((line) => line.text),
    0,
  )

  const resources: string[] = []

  for (const access of accesses) {
    const line = region[access.line - 1]
    if (!line) continue
    // The acquire and release lines are about the lock, not about what it guards.
    // Skipping the line wholesale is what stops `mutex_lock(&s->mu)` from pairing
    // with the `s->mu` in its own argument.
    const onLockLine = lockArgument(line.text)
    if (onLockLine && normalizeExpression(onLockLine.lock) === lockKey) continue
    // The lock taking itself is not a resource it guards.
    if (access.key === lockKey) continue
    // A field access only is a resource; see `hasFieldPath`.
    if (!hasFieldPath(access.key)) continue
    // Member lock: the pairing is the shared base identifier. `s->mu` guards
    // `s->count`, and `t->count` is a different object.
    if (memberLock && baseOf(access.key) !== lockBase) continue
    if (!resources.includes(access.key)) resources.push(access.key)
  }

  if (resources.length === 0) return null
  return { resources, lock: lockKey }
}

/**
 * Whether a hunk added locking at all, without building a rule from it.
 *
 * Exported because the coverage counters need to tell two different empty results
 * apart: a history where no hunk added locking is a history with nothing to mine,
 * whereas a history where locking *was* added but no resource could be identified
 * is a mining gap. A count of rules alone cannot distinguish them.
 */
export const addsLock = (hunk: Hunk): boolean =>
  postImageWithLines(hunk).some(
    (line) => line.added && lockArgument(line.text) !== null,
  )

export interface RuleMiningResult {
  rules: AtomicityRule[]
  /** Hunks that added a lock, i.e. the miner's denominator. */
  hunksAddingLock: number
  /** Hunks that added a lock but yielded no identifiable guarded resource. */
  hunksWithoutResource: number
}

/**
 * Mine atomicity rules from one commit's hunks.
 *
 * Pure, so it can be tested against hand-written hunks without a repository — the
 * mining logic is where the judgement lives and it is the part worth testing
 * hardest. Aggregation across commits happens in `mergeRules`; the history walk
 * happens in `run.ts`, which is the half that needs a sandbox.
 *
 * Coverage is returned here rather than computed by a second pass over the same
 * hunks, because a second pass is exactly where the two counts would drift from the
 * thing they are supposed to count.
 */
export const mineRulesFromHunks = (input: {
  hunks: readonly Hunk[]
  originPatchSha: string
}): RuleMiningResult => {
  const rules = new Map<string, AtomicityRule>()
  let hunksAddingLock = 0
  let hunksWithoutResource = 0

  for (const hunk of input.hunks) {
    if (!addsLock(hunk)) continue
    hunksAddingLock += 1

    const guarded = guardedResources(hunk)
    if (!guarded) {
      hunksWithoutResource += 1
      continue
    }

    for (const resource of guarded.resources) {
      const id = atomicityRuleId(resource, guarded.lock)
      const existing = rules.get(id)
      if (existing) {
        // Two hunks in one commit establishing the same pairing is one rule seen
        // twice. `mergeRules` sums this across commits.
        existing.occurrences += 1
        continue
      }

      rules.set(id, {
        id,
        resource,
        lock: guarded.lock,
        originPatchSha: input.originPatchSha,
        originFile: hunk.filePath,
        occurrences: 1,
      })
    }
  }

  return { rules: [...rules.values()], hunksAddingLock, hunksWithoutResource }
}

/** Merge rules mined from several commits, summing occurrences. */
export const mergeRules = (groups: readonly AtomicityRule[][]): AtomicityRule[] => {
  const merged = new Map<string, AtomicityRule>()

  for (const group of groups) {
    for (const rule of group) {
      const existing = merged.get(rule.id)
      if (existing) {
        existing.occurrences += rule.occurrences
        continue
      }
      merged.set(rule.id, { ...rule })
    }
  }

  return [...merged.values()].sort(
    (left, right) =>
      right.occurrences - left.occurrences || left.id.localeCompare(right.id),
  )
}
