/**
 * Extracting the event stream from a function body (spec §4.4.3).
 *
 * Every one of the four FSMs is a statement about *ordering* — a check, then
 * something, then a use — and ordering is precisely what a line-oriented pattern
 * cannot express. So the region is first reduced to an ordered list of events, and
 * from there each FSM is a small machine over that list rather than another set of
 * regexes. The alias relation is the only thing that decides whether two events
 * are about the same resource.
 *
 * ## The classification tables are the substance, so they are exported
 *
 * What counts as a path check, a path use, a fetch, a lock, and a release is the
 * module's actual judgement about C code, and a reader who wants to disagree with
 * a finding needs to see those lists rather than reverse-engineer them out of
 * control flow. They are therefore const arrays at the top of this file, each with
 * the reason it contains what it does.
 *
 * Two of the lists are deliberately *curated rather than generic*, which is a
 * recall cost taken on purpose:
 *
 * - **Fetches are the user-copy family.** `copy_from_user`, `get_user`, `copyin`
 *   and their relatives are the documented double-fetch surface, where a second
 *   read of attacker-controlled memory is a known bug class. Treating every
 *   `read(fd, buf, n)` as a fetch would put every file read in the codebase into
 *   the double-fetch FSM's input, and the FSM would drown.
 * - **Releases are a named set, not "any call that takes a pointer."** `free`,
 *   `kfree`, `fput`, `kref_put` and friends are unambiguous. `put(x)` alone is not
 *   — it is as likely to be a hash insert — so a bare `put` is not a release here.
 */

import { isCodeLine, splitTopLevel } from '../patchmine/shapes'
import { normalizeExpression } from './alias'

import type { AtomicEvent, AtomicEventKind } from './types'

/**
 * Calls that test a path *without binding to it*.
 *
 * This is the check side of the canonical filesystem race: the call answers a
 * question about the name, and the name is re-resolved by whatever runs next.
 */
export const PATH_CHECK_CALLS = [
  'access',
  'faccessat',
  'faccessat2',
  'eaccess',
  'stat',
  'stat64',
  'lstat',
  'lstat64',
  '__xstat',
  '__lxstat',
] as const

/**
 * Calls that resolve a path to an object.
 *
 * The use side. A check on a path followed by one of these is the CWE-367 shape
 * regardless of what the check was, because the binding between the name and the
 * object is established here and was established nowhere the check could see.
 */
export const PATH_USE_CALLS = [
  'open',
  'openat',
  'open64',
  'fopen',
  'freopen',
  'creat',
  'unlink',
  'unlinkat',
  'remove',
  'rename',
  'renameat',
  'chmod',
  'fchmodat',
  'chown',
  'lchown',
  'truncate',
  'opendir',
  'mkdir',
  'mkdirat',
  'rmdir',
  'symlink',
  'link',
  'execve',
  'execv',
  'execl',
  'chdir',
  'chroot',
  'utime',
  'utimes',
  'mkfifo',
  'mknod',
] as const

/**
 * Reads that copy a value in from outside the function's trust boundary, with the
 * argument positions they read into and from.
 *
 * The second read is the bug: the attacker changes the source between the two, and
 * the check was performed on the first copy.
 */
export const FETCH_CALLS: ReadonlyArray<{
  callee: string
  /** Argument index holding the destination local. */
  target: number
  /** Argument index holding the external source. */
  source: number
}> = [
  { callee: 'copy_from_user', target: 0, source: 1 },
  { callee: '__copy_from_user', target: 0, source: 1 },
  { callee: '_copy_from_user', target: 0, source: 1 },
  { callee: 'copyin', target: 0, source: 1 },
  { callee: 'get_user', target: 0, source: 1 },
  { callee: '__get_user', target: 0, source: 1 },
  { callee: 'probe_kernel_read', target: 0, source: 1 },
  { callee: 'fwread', target: 0, source: 1 },
]

export const LOCK_ACQUIRE_CALLS = [
  'mutex_lock',
  'mutex_lock_interruptible',
  'mutex_lock_killable',
  'spin_lock',
  'spin_lock_irqsave',
  'spin_lock_irq',
  'spin_lock_bh',
  'pthread_mutex_lock',
  'mtx_lock',
  'EnterCriticalSection',
  'down_read',
  'down_write',
  'down_interruptible',
  'rcu_read_lock',
  'sem_wait',
  'WaitForSingleObject',
  'lock',
] as const

export const LOCK_RELEASE_CALLS = [
  'mutex_unlock',
  'spin_unlock',
  'spin_unlock_irqrestore',
  'spin_unlock_irq',
  'spin_unlock_bh',
  'pthread_mutex_unlock',
  'mtx_unlock',
  'LeaveCriticalSection',
  'up_read',
  'up_write',
  'rcu_read_unlock',
  'sem_post',
  'ReleaseMutex',
  'unlock',
] as const

/** Calls that end a resource's lifetime. See the module note on curation. */
export const LIFETIME_RELEASE_CALLS = [
  'free',
  'kfree',
  'kzfree',
  'kvfree',
  'vfree',
  'g_free',
  'g_free0',
  'fclose',
  'close',
  'fput',
  'kref_put',
  'refcount_dec',
  'refcount_dec_and_test',
  'sock_put',
  'xfree',
] as const

const CALLEE_KEYWORDS = new Set([
  'if',
  'while',
  'for',
  'switch',
  'return',
  'sizeof',
  'defined',
  'else',
  'do',
  'case',
  'assert',
])

const setOf = (values: readonly string[]): ReadonlySet<string> => new Set(values)

const PATH_CHECKS = setOf(PATH_CHECK_CALLS)
const PATH_USES = setOf(PATH_USE_CALLS)
const LOCKS = setOf(LOCK_ACQUIRE_CALLS)
const UNLOCKS = setOf(LOCK_RELEASE_CALLS)
const RELEASES_ = setOf(LIFETIME_RELEASE_CALLS)
const FETCHES = new Map(FETCH_CALLS.map((entry) => [entry.callee, entry]))

export interface CallSite {
  callee: string
  args: string[]
  /** 0-based character offset of the callee in the line. */
  at: number
}

/**
 * Every `callee(...)` in a line, with balanced arguments.
 *
 * Keywords are skipped, so `if (x)` is not a call to `if`. Nesting is handled, so
 * `copy_from_user(&a, p + off(p), n)` yields one call site with three arguments
 * rather than three sites or a truncated argument list.
 */
export const callSites = (line: string): CallSite[] => {
  const sites: CallSite[] = []

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '(') continue

    // Walk back over the identifier that precedes the paren.
    let start = index
    while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1]!)) start -= 1
    if (start === index) continue

    const callee = line.slice(start, index)
    if (CALLEE_KEYWORDS.has(callee)) continue
    // A member call `obj->fn(` is not a plain callee; its resource is the object,
    // which the deref rule already records.
    if (start > 0 && /[.>]/.test(line[start - 1]!)) continue

    // Find the matching close paren.
    let depth = 0
    let close = -1
    for (let scan = index; scan < line.length; scan += 1) {
      const character = line[scan]!
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) {
          close = scan
          break
        }
      }
    }
    if (close === -1) continue

    sites.push({
      callee,
      args: splitTopLevel(line.slice(index + 1, close)),
      at: start,
    })

    index = close
  }

  return sites
}

/**
 * The line opening the function body, or -1 when the region has no brace.
 *
 * Exported because `accessedExpressions` needs the same notion of "where the body
 * starts": a signature line reads as text full of accesses (`int f(struct s *s)`,
 * `int arr[10]`), and an access sweep that began there would report the function's
 * own parameters as uses of a shared resource.
 */
export const bodyStartIndex = (lines: readonly string[]): number => {
  for (let index = 0; index < Math.min(lines.length, 12); index += 1) {
    if (lines[index]!.includes('{')) return index
  }
  return -1
}

const push = (
  events: AtomicEvent[],
  kind: AtomicEventKind,
  line: number,
  key: string,
  text: string,
  extra: { callee?: string | null; target?: string | null; source?: string | null } = {},
): void => {
  events.push({
    kind,
    line,
    key,
    text: text.trim(),
    callee: extra.callee ?? null,
    target: extra.target ?? null,
    source: extra.source ?? null,
  })
}

/**
 * A full expression path, with any member or subscript chain: `s->count`,
 * `t->inner->v`, `arr[i].len`.
 *
 * Deliberately *path-aware*, and that is the fix for a real defect: a version that
 * captured bare identifiers made `if (s->count < 0)` a check on `count` while the
 * later use was a use of `s->count`, so no FSM could ever pair them and lock-scope
 * detected nothing at all.
 */
const CONDITION_PATH = /[A-Za-z_]\w*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*|\s*\[[^\]\n]*\])*/g

/**
 * The values a condition tests.
 *
 * Every path in the condition, minus the callees: `if (is_valid(p))` tests `p`, not
 * `is_valid`, so a path that is immediately followed by `(` is a call and not an
 * operand. This is a scan over paths rather than a scan over comparison operators,
 * which is what keeps `->` from being read as a `>`: `if (s->count > 0)` must yield
 * `s->count`, and an operator-first pattern yields `count` instead.
 */
const testedIdentifiers = (condition: string): string[] => {
  const found: string[] = []

  for (const match of condition.matchAll(CONDITION_PATH)) {
    const path = match[0]! 
    const after = condition.slice((match.index ?? 0) + path.length).trimStart()
    if (after.startsWith('(')) continue
    if (CALLEE_KEYWORDS.has(path)) continue
    found.push(path)
  }

  return [...new Set(found)]
}

/**
 * Reduce a function region to its ordered events.
 *
 * The signature is skipped: a declaration reads as a call (`int f(char *p)`), and
 * an event stream that began with a spurious call to `f` would put every function
 * into every FSM's input.
 */
export const extractEvents = (lines: readonly string[]): AtomicEvent[] => {
  const events: AtomicEvent[] = []
  const from = bodyStartIndex(lines) + 1

  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (!isCodeLine(raw)) continue
    const line = index + 1

    // Keys a call on this line already classified, so the access pass below does not
    // re-report the same expression as a generic `use`. `free(s->buf)` *releases*
    // `s->buf`; emitting a use of `s->buf` on the same line would make the lifetime
    // FSM read the release's own argument as a use-after-free.
    const classified = new Set<string>()

    for (const site of callSites(raw)) {
      const first = site.args[0] ?? ''
      const key = normalizeExpression(first)

      if (LOCKS.has(site.callee)) {
        classified.add(key)
        push(events, 'lock', line, first, raw, { callee: site.callee })
        continue
      }
      if (UNLOCKS.has(site.callee)) {
        classified.add(key)
        push(events, 'unlock', line, first, raw, { callee: site.callee })
        continue
      }
      if (RELEASES_.has(site.callee)) {
        classified.add(key)
        push(events, 'release', line, first, raw, { callee: site.callee })
        continue
      }

      const fetch = FETCHES.get(site.callee)
      if (fetch) {
        classified.add(key)
        push(events, 'fetch', line, first, raw, {
          callee: site.callee,
          target: site.args[fetch.target] ?? null,
          source: site.args[fetch.source] ?? null,
        })
        continue
      }

      if (PATH_CHECKS.has(site.callee)) {
        classified.add(key)
        push(events, 'check', line, first, raw, { callee: site.callee })
        continue
      }
      if (PATH_USES.has(site.callee)) {
        classified.add(key)
        push(events, 'use', line, first, raw, { callee: site.callee })
        continue
      }

      // Anything else is an unclassified call. It is recorded as `call` rather
      // than `use` so the FSMs can decide: `process(p)` after `free(p)` is a use
      // of a released pointer, while `strlen(p)` before any release is not.
      classified.add(key)
      push(events, 'call', line, first, raw, { callee: site.callee })
    }

    // A conditional's operands are checks. Only the condition text is read, so an
    // assignment inside the body is not mistaken for a test of the assigned value.
    // These are emitted *before* the access pass below, so a check and a use on the
    // same line are ordered the way the source reads.
    const condition = /(?:if|while)\s*\(([^)]*)\)/.exec(raw)?.[1]
    if (condition) {
      for (const identifier of testedIdentifiers(condition)) {
        classified.add(normalizeExpression(identifier))
        push(events, 'check', line, identifier, raw, { callee: null })
      }
    }

    // Every field or subscript access is a use of the object it reads. The key is
    // the *whole* path (`s->count`, not `s`), which is what lets a check on a field
    // pair with a later use of that same field.
    for (const access of accessedExpressions([raw], 0)) {
      if (classified.has(access.key)) continue
      push(events, 'use', line, access.key, raw, { callee: null })
    }
  }

  return events
}

/**
 * A field or subscript access, as an atomicity rule has to see it.
 *
 * Distinct from `AtomicEvent`: the FSMs ask "which call happened in which order",
 * while an atomicity rule asks "was this shared field touched with its lock held".
 * The second question is about *expressions*, including ones on lines with no call
 * at all (`s->count += 1;`), so reusing the event stream would mean inventing a
 * `use` for every assignment and losing the distinction the FSMs rely on.
 */
export interface AccessSite {
  /** Normalized expression key. */
  key: string
  /** 1-based line within the region. */
  line: number
  text: string
}

/**
 * A member or subscript path: `s->count`, `s.a.b`, `arr[i]`, `t->v[i]`.
 *
 * Multi-segment on purpose. Matching only one segment would find `s->count` but
 * miss `t->inner->count`, and the longest match is the more specific resource.
 */
const ACCESS_PATH =
  /\b([A-Za-z_]\w*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*|\s*\[[^\]\n]*\])+)/g

/**
 * Every field/subscript access in a region, deduplicated per line.
 *
 * `from` is an explicit start index rather than a body-start search, because the
 * right start differs by caller: a function region wants `bodyStartIndex(lines) + 1`
 * so its signature is skipped, while a diff hunk's post-image is a fragment with no
 * signature and wants `0`. Probing for a brace inside a fragment would stop at the
 * first `{` — often an `if (…) {` in the middle of the critical section — and report
 * nothing before it.
 *
 * A line can hold several accesses (`s->a = s->b;`); they are all returned, because
 * a rule about `s->b` must not be satisfied by a lock taken for `s->a`.
 */
export const accessedExpressions = (lines: readonly string[], from = 0): AccessSite[] => {
  const found: AccessSite[] = []

  for (let index = from; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (!isCodeLine(raw)) continue
    const line = index + 1
    const seen = new Set<string>()

    for (const match of raw.matchAll(ACCESS_PATH)) {
      const key = normalizeExpression(match[1]!)
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      found.push({ key, line, text: raw })
    }
  }

  return found
}

/** Events that count as a use of a resource, for the FSMs. */
export const isUseEvent = (event: AtomicEvent): boolean =>
  event.kind === 'use' || event.kind === 'call'

/**
 * Whether a `check` event came from a path-checking call.
 *
 * The distinction matters because `check` is also emitted for a comparison's
 * operands, and only the call form says anything about a *name*. A `if (fd < 0)`
 * check followed by `open(path)` is not the filesystem race; `access(path)`
 * followed by `open(path)` is.
 */
export const isPathCheckEvent = (event: AtomicEvent): boolean =>
  event.callee !== null && PATH_CHECKS.has(event.callee)

/** Whether a `use` event came from a path-resolving call. */
export const isPathUseEvent = (event: AtomicEvent): boolean =>
  event.callee !== null && PATH_USES.has(event.callee)
