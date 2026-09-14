/**
 * The signal-handler machine (spec §4.4.3, CWE-364).
 *
 * CWE-364 is the one race class §4.4.3's four machines cannot express, and it is
 * different from them in a way that shapes this whole module: its defects do not
 * happen *between* two statements inside one function. They happen because the
 * function is running at all while something else is midway through its own work. So
 * there is no check, no use, and no third event — the interruption itself is the
 * middle, and it is nowhere in the source.
 *
 * ## The four shapes, and where each one's anchor is
 *
 * | shape | the defect is | anchor |
 * |---|---|---|
 * | `unsafe-call` | the handler calls a function whose internal state it can interrupt | the call |
 * | `reentrancy-window` | the handler releases a resource and *then* clears the reference | the release, with the clear as the far end |
 * | `shared-state` | the handler and other code both touch a non-atomic object | the handler's touch, with the other one named |
 * | `non-local-jump` | the handler never returns to the interrupted code | the jump |
 *
 * Two of those need input the handler's own body does not contain, and both come from
 * the pre-pass in `scan.ts`: whether the function is a handler at all (`handlers.ts`),
 * and which *other* function touches the same file-scope object. That second one is
 * the reason the analysis is two-pass, and it is the whole of what makes
 * `shared-state` a statement about a race rather than a statement about a global.
 *
 * ## Non-locality is decided by file scope, and that is the precision mechanism
 *
 * A race between a handler and the regular code needs an object both can name. In C
 * that means file scope, so `shared-state` only fires for names found in
 * `fileScopeDeclarations` — which removes the entire class of false positives that a
 * "bare identifier that is not a local" heuristic would produce, where a handler's
 * local `n` and `main`'s local `n` would look like one shared object. The cost is
 * real and recorded: a global declared in a header and never re-declared in the
 * translation unit being read is not seen.
 *
 * The same scan that finds file-scope names also finds the `sig_atomic_t` ones, which
 * is not a coincidence: `sig_atomic_t` is the one type a handler may assign to, so
 * recognising it is how the *documented fix* is told apart from the defect. A key
 * declared `volatile sig_atomic_t` is the compliant solution, and firing on it would
 * make this machine report the cure.
 */

import { aliases } from './alias'
import { isAsyncUnsafe, isNonLocalJump } from './handlers'
import { bodyStartIndex, callSites } from './events'
import { isCodeLine } from '../patchmine/shapes'

import type { Bindings } from './alias'
import type { AtomicEvent, SignalFinding, SignalHandler, SignalOtherLocation } from './types'
import type { FileScopeDeclarations } from './types'

/**
 * Calls that block or defer signal delivery.
 *
 * Used as a **veto**: an access to shared state inside a region where delivery is
 * blocked is not racy, which is exactly the mitigation POSIX recommends for code that
 * cannot be made reentrant. The veto is coarse — it asks whether the function masks
 * signals *anywhere*, not whether the mask covers the specific access, because
 * following which signals a `sigaddset` added would mean modelling the set. Coarse in
 * the direction of reporting less, which is this module's standing trade, and
 * recorded in §20.23.
 */
export const SIGNAL_MASK_CALLS = [
  'sigprocmask',
  'pthread_sigmask',
  'sigblock',
  'sigsetmask',
  'sigsuspend',
  'sigpause',
] as const

const MASKERS = new Set<string>(SIGNAL_MASK_CALLS)

/** Identifiers that are type or storage syntax rather than an object's name. */
const TYPE_WORDS = new Set([
  'const',
  'volatile',
  'static',
  'register',
  'unsigned',
  'signed',
  'long',
  'short',
  'struct',
  'union',
  'enum',
  'extern',
  'typedef',
  'inline',
  'auto',
  'restrict',
  '_Atomic',
  '_Bool',
  'constexpr',
  'constinit',
])

const TYPE_INTRODUCERS = new Set(['struct', 'union', 'enum', 'typedef'])

/** Constants that clear a reference rather than binding it to an object. */
const NULL_LIKE = ['NULL', 'nullptr', 'nil', 'NIL', 'None']

/**
 * Identifier tokens in a line, with offsets.
 *
 * A manual scan rather than a pattern with a word boundary in it. Two reasons, and
 * the second is the one that matters: this file has to round-trip through the tooling
 * that writes it, and an escape sequence that arrives mangled (a `\b` decoded as a
 * backspace byte, which has happened here) produces a pattern that compiles and
 * silently matches the wrong thing. A character scan has no such failure mode.
 */
export const identifierTokens = (
  text: string,
): Array<{ name: string; at: number }> => {
  const found: Array<{ name: string; at: number }> = []
  const isWord = (character: string): boolean => /[A-Za-z0-9_]/.test(character)
  const isStart = (character: string): boolean => /[A-Za-z_]/.test(character)

  let index = 0
  while (index < text.length) {
    if (!isStart(text[index]!)) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < text.length && isWord(text[end]!)) end += 1
    found.push({ name: text.slice(index, end), at: index })
    index = end
  }

  return found
}

const countOf = (text: string, character: string): number => {
  let total = 0
  for (const current of text) if (current === character) total += 1
  return total
}

/**
 * Remove balanced `{...}` groups, so an initialiser's contents cannot be read as names.
 *
 * `struct sigaction sa = { .sa_handler = on_int };` has two identifiers that look like
 * objects being declared and are neither.
 */
const stripBraced = (text: string): string => {
  let result = ''
  let depth = 0

  for (const character of text) {
    if (character === '{') {
      depth += 1
      continue
    }
    if (character === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) result += character
  }

  return result
}

/**
 * Remove bracketed groups, so an array bound cannot be read as a name.
 *
 * `int arr[N];` has two identifiers and one object, and the object is the first.
 */
const stripBracketed = (text: string): string => {
  let result = ''
  let depth = 0

  for (const character of text) {
    if (character === '[') {
      depth += 1
      continue
    }
    if (character === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) result += character
  }

  return result
}

/**
 * The text before a declarator's initialiser.
 *
 * Everything after the `=` is a *value*, and treating it as names was a real defect:
 * `static char *info = NULL;` reported `NULL` as a file-scope object, and any macro in
 * an initialiser position would have been reported too.
 */
const beforeInitialiser = (text: string): string => {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '=') continue
    if (text[index + 1] === '=') continue
    if ('=!<>+-*/%&|^'.includes(text[index - 1] ?? '')) continue
    return text.slice(0, index)
  }
  return text
}

/**
 * The objects a file declares outside every function, plus which are `sig_atomic_t`.
 *
 * File scope is found by brace depth: a declaration starts on a line whose depth is
 * zero, and ends at the `;` that returns to zero. The one case that needs care is the
 * function *definition*, which also starts at depth zero — it is told apart by having
 * a `(` before its `{`, whereas a file-scope initialiser list (`static const char
 * *t[] = { … };`) does not.
 *
 * That distinction is load-bearing, and the way it is applied matters more than it
 * looks. Abandoning the pending declaration the moment a body opens is what makes it
 * work; merely *flagging* it and deciding at the `;` does not, because a body with no
 * statement in it never reaches a `;` — so the buffer would still be open when the
 * next declaration arrives and would swallow it. Mutation testing found exactly that:
 * an empty `void handler(int sig) { }` made every object declared after it invisible.
 */
export const fileScopeDeclarations = (
  fileLines: readonly string[],
): FileScopeDeclarations => {
  const globals = new Set<string>()
  const sigAtomic = new Set<string>()

  let depth = 0
  let buffer: string | null = null

  const finish = (): void => {
    if (buffer === null) return
    const text = buffer
    buffer = null
    collectDeclaration(text, globals, sigAtomic)
  }

  for (const raw of fileLines) {
    if (!isCodeLine(raw)) continue
    const trimmed = raw.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const atTop = depth === 0
    if (buffer !== null) buffer = `${buffer} ${trimmed}`
    else if (atTop && !trimmed.startsWith('}')) buffer = trimmed

    depth += countOf(raw, '{') - countOf(raw, '}')

    // A block opened at file scope is either a body or an initialiser. A body is
    // abandoned *now*, not at its `;` — see the note above on why the deferred version
    // silently loses whatever is declared after an empty function.
    if (buffer !== null && depth > 0) {
      const braceAt = buffer.indexOf('{')
      if (braceAt >= 0 && buffer.slice(0, braceAt).includes('(')) buffer = null
    }

    if (buffer !== null && depth === 0 && buffer.includes(';')) finish()
  }

  return { globals, sigAtomic }
}

/**
 * Pull the object names out of one complete file-scope declaration.
 *
 * One name per comma-separated declarator, and the name is the **last non-type
 * identifier before that declarator's `=`**. Taking the last is what lets a typedef-ish
 * type name sit in front of it (`static jmp_buf env;` yields `env`, not `jmp_buf`), and
 * cutting at the `=` is what keeps an initialiser's contents out entirely.
 *
 * Declarations containing a parenthesis are skipped by the caller, which drops
 * function-pointer globals. That is a recall cost, recorded in §20.23: a name is worth
 * less than a `void (*fp)(int)` parsed as an object called `void`.
 */
const collectDeclaration = (
  declaration: string,
  globals: Set<string>,
  sigAtomic: Set<string>,
): void => {
  // A prototype: a `(` in the declarator head means the names are a signature, not
  // objects. Only the head, though — *after* the brace is an initialiser, and
  // `{ .len = sizeof(x) }` is one of the most common shapes a file-scope table has.
  // Testing the whole declaration instead silently dropped every table initialised with
  // a call or a `sizeof`.
  const braceAt = declaration.indexOf('{')
  const head = braceAt >= 0 ? declaration.slice(0, braceAt) : declaration
  if (head.includes('(')) return

  const first = identifierTokens(declaration)[0]?.name ?? ''

  // A type definition or a struct-typed object's initialiser. Skipped rather than
  // guessed at: the names inside are fields, and a field reported as a global would
  // be a shared-state finding about nothing. Recorded cost: `struct foo g = { … };`
  // at file scope is not seen.
  if (TYPE_INTRODUCERS.has(first) && declaration.includes('{')) return
  if (first === 'typedef') return

  const text = stripBracketed(stripBraced(declaration))
  const atomic = text.includes('sig_atomic_t')

  for (const item of text.split(',')) {
    const names = identifierTokens(beforeInitialiser(item))
      .map((token) => token.name)
      .filter((name) => !TYPE_WORDS.has(name))

    const name = names[names.length - 1]
    if (name === undefined || name.length === 0) continue

    globals.add(name)
    if (atomic) sigAtomic.add(name)
  }
}

/** Whether a name is the target of an assignment at this point in the text. */
const writesAt = (text: string, afterIndex: number): boolean => {
  let rest = text.slice(afterIndex).trimStart()
  if (rest.startsWith('++') || rest.startsWith('--')) return true

  // A subscript chain between the name and the `=`: `g_buf[i] = 0;` writes the global.
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) return false
    rest = rest.slice(close + 1).trimStart()
  }

  if (rest.startsWith('==')) return false
  if (rest.startsWith('=')) return true
  // A compound assignment: `+=`, `|=`, `<<=`. A comparison operator whose second
  // character is an `=` is not one, and the set below is what separates them.
  if (rest.length > 1 && rest[1] === '=' && '+-*/%&|^<>'.includes(rest[0]!)) {
    return rest[0] !== '<' && rest[0] !== '>'
  }
  return false
}

/** One touch of a file-scope object inside a function. */
export interface GlobalTouch {
  key: string
  /** 1-based line of the first touch, within the region. */
  line: number
  /**
   * 1-based line of the first *write*, or null when the function only reads it.
   *
   * Kept separately from `line` because the two are different lines and the finding has
   * to name the one its sentence is about. A shared-state finding whose text reads
   * "written at line 16" while line 16 is `syslog(…, logMessage)` is sending a reviewer
   * to a read — and this is not hypothetical, it is what the first CLI run over a real
   * target printed.
   */
  wroteAt: number | null
  /** True when `wroteAt` is set. Derived, and redundant on purpose for readability. */
  wrote: boolean
  text: string
}

/**
 * Every touch of a file-scope object in a function body.
 *
 * `scope` is the filter, and it is the whole precision story of `shared-state`: a
 * local whose name coincides with nothing at file scope is not a candidate, so the
 * shape cannot fire on two unrelated locals that happen to share a name.
 *
 * The signature is skipped, for the same reason `extractEvents` skips it — a
 * parameter list is not a use of anything.
 */
export const globalTouches = (input: {
  lines: readonly string[]
  scope: FileScopeDeclarations
}): GlobalTouch[] => {
  const { lines, scope } = input
  if (scope.globals.size === 0) return []

  const found: GlobalTouch[] = []
  const byKey = new Map<string, GlobalTouch>()

  for (let index = bodyStartIndex(lines) + 1; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (!isCodeLine(raw)) continue
    const line = index + 1

    for (const token of identifierTokens(raw)) {
      if (!scope.globals.has(token.name)) continue

      let entry = byKey.get(token.name)
      if (entry === undefined) {
        entry = { key: token.name, line, wroteAt: null, wrote: false, text: raw.trim() }
        byKey.set(token.name, entry)
        found.push(entry)
      }

      // The write line is recorded in exactly one place, and only the first one. Two
      // places setting it (one at creation, one on a later line) leaves a mutation in
      // either that nothing can detect, because the other covers for it — which is how
      // mutation testing found this shape in the first place.
      if (writesAt(raw, token.at + token.name.length) && entry.wroteAt === null) {
        entry.wroteAt = line
        entry.wrote = true
      }
    }
  }

  return found
}

/**
 * References cleared to a null constant, in line order.
 *
 * This is the far end of the `reentrancy-window` shape and it is deliberately *not*
 * a `use` event: `describe.ts`'s sibling in `alias.ts` excludes `y = NULL` from the
 * binding relation precisely because a null write binds nothing, and
 * `extractEvents` therefore emits nothing for it. That exclusion is what leaves the
 * window invisible to `lifetime-race`, and finding it is this module's job.
 */
export const invalidatedKeys = (
  lines: readonly string[],
): Array<{ key: string; line: number; text: string }> => {
  const found: Array<{ key: string; line: number; text: string }> = []

  for (let index = bodyStartIndex(lines) + 1; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (!isCodeLine(raw)) continue

    for (const token of identifierTokens(raw)) {
      const rest = raw.slice(token.at + token.name.length)
      const trimmed = rest.trimStart()
      if (!trimmed.startsWith('=') || trimmed.startsWith('==')) continue

      const value = trimmed.slice(1).trimStart()
      const isNull = NULL_LIKE.some(
        (constant) => value.startsWith(constant) && !/[A-Za-z0-9_]/.test(value[constant.length] ?? ''),
      )
      const isZero = value.startsWith('0') && !/[.A-Za-z0-9_]/.test(value[1] ?? '')
      if (!isNull && !isZero) continue

      found.push({ key: token.name, line: index + 1, text: raw.trim() })
    }
  }

  return found
}

/** Whether a function blocks signal delivery anywhere. The `shared-state` veto. */
export const masksSignals = (lines: readonly string[]): boolean =>
  lines.some((line) => callSites(line).some((site) => MASKERS.has(site.callee)))

/** Shape 1 — the handler calls a function it can interrupt midway. */
export const unsafeCalls = (
  events: readonly AtomicEvent[],
): Array<Extract<SignalFinding, { shape: 'unsafe-call' }>> => {
  const found: Array<Extract<SignalFinding, { shape: 'unsafe-call' }>> = []
  const seen = new Set<string>()

  for (const event of events) {
    if (event.callee === null || !isAsyncUnsafe(event.callee)) continue
    const key = `${event.callee}|${event.line}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      shape: 'unsafe-call',
      line: event.line,
      resource: event.callee,
      callee: event.callee,
      signals: [],
    })
  }

  return found
}

/** Shape 4 — the handler abandons the interrupted code instead of returning to it. */
export const nonLocalJumps = (
  events: readonly AtomicEvent[],
): Array<Extract<SignalFinding, { shape: 'non-local-jump' }>> => {
  const found: Array<Extract<SignalFinding, { shape: 'non-local-jump' }>> = []
  const seen = new Set<string>()

  for (const event of events) {
    if (event.callee === null || !isNonLocalJump(event.callee)) continue
    const key = `${event.callee}|${event.line}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      shape: 'non-local-jump',
      line: event.line,
      resource: event.callee,
      callee: event.callee,
      signals: [],
    })
  }

  return found
}

/**
 * Shape 2 — the release-and-clear window, in a handler that can be re-entered.
 *
 * The precondition is the shape's whole precision story, so it is checked and not
 * assumed: a handler installed for a *single* signal is blocked against itself while
 * it runs, so it cannot re-enter and the window is not a window. Only a handler on
 * two signals, or one installed with `SA_NODEFER`, can be stopped inside its own
 * release-to-clear pair — which is exactly why CWE-831 ("handler associated with
 * multiple signals") is a *precondition* here rather than a finding of its own.
 *
 * `free(p); p = NULL;` is the defensive form, and this shape is the statement that it
 * is not sufficient while the handler is re-enterable.
 */
export const reentrancyWindows = (input: {
  events: readonly AtomicEvent[]
  lines: readonly string[]
  bindings: Bindings
  handler: SignalHandler
}): Array<Extract<SignalFinding, { shape: 'reentrancy-window' }>> => {
  const { events, lines, bindings, handler } = input
  if (handler.signals.length < 2 && !handler.nodefer) return []

  const invalidations = invalidatedKeys(lines)
  if (invalidations.length === 0) return []

  const found: Array<Extract<SignalFinding, { shape: 'reentrancy-window' }>> = []
  const seen = new Set<string>()

  for (const event of events) {
    if (event.kind !== 'release' || event.key.length === 0) continue

    const key = bindings.resolve(event.key)
    if (seen.has(key)) continue

    const clear = invalidations.find(
      (entry) => entry.line > event.line && aliases(entry.key, event.key, bindings),
    )
    if (!clear) continue

    seen.add(key)
    found.push({
      shape: 'reentrancy-window',
      releaseLine: event.line,
      invalidateLine: clear.line,
      resource: key,
      signals: [...handler.signals],
    })
  }

  return found
}

/**
 * Shape 3 — an object the handler touches that other code touches too.
 *
 * Three gates, each removing a class of non-race:
 *
 * 1. **`sig_atomic_t` is excluded.** It is the documented-correct mechanism, and a
 *    machine that reported it would be reporting the fix.
 * 2. **Something must write it.** A read-only object cannot be observed
 *    half-updated, so an object nobody mutates is not a race however many functions
 *    read it. This is what stops enum-like constants and configuration from filling
 *    the output.
 * 3. **The other access must not be signal-masked.** Delivery blocked is delivery
 *    deferred, and `scan.ts` applies that veto while building the map, so a key whose
 *    only other accesses are masked never arrives here.
 *
 * The other location is chosen deterministically: a writer if there is one, else the
 * first access in `(file, function, line)` order. One finding per key, because one
 * shared object with an unsynchronised writer is one defect however many places read
 * it.
 */
export const sharedStateRaces = (input: {
  touches: readonly GlobalTouch[]
  scope: FileScopeDeclarations
  otherTouches: ReadonlyMap<string, readonly SignalOtherLocation[]>
  signals: readonly string[]
}): SignalFinding[] => {
  const { touches, scope, otherTouches, signals } = input
  const found: SignalFinding[] = []
  const seen = new Set<string>()

  for (const touch of touches) {
    if (scope.sigAtomic.has(touch.key)) continue
    if (seen.has(touch.key)) continue

    const others = otherTouches.get(touch.key)
    if (others === undefined || others.length === 0) continue

    const writer = others.find((entry) => entry.written)
    if (!touch.wrote && writer === undefined) continue

    seen.add(touch.key)
    found.push({
      shape: 'shared-state',
      // The write when the handler writes, else the first read. Anchoring on the
      // mutation is what makes the sentence's verb true of the line it names.
      line: touch.wroteAt ?? touch.line,
      wrote: touch.wrote,
      resource: touch.key,
      other: writer ?? others[0]!,
      signals: [...signals],
    })
  }

  return found
}

export interface SignalShapesInput {
  /** The handler's region lines. */
  lines: readonly string[]
  /** The handler's event stream. */
  events: readonly AtomicEvent[]
  bindings: Bindings
  handler: SignalHandler
  /** The file the handler lives in, already scanned for file-scope objects. */
  scope: FileScopeDeclarations
  /** Every other function's unmasked touches, keyed by object name. */
  otherTouches: ReadonlyMap<string, readonly SignalOtherLocation[]>
}

export interface SignalShapeResult {
  findings: SignalFinding[]
  /**
   * Unsafe-call findings not emitted because a reentrancy window already claimed the
   * line.
   *
   * `free(p)` in a re-enterable handler is reported twice over — `free` is not
   * async-signal-safe, *and* the release-to-clear pair is a window. They are not
   * independent: the window's whole mechanism is the re-entrant `free`, so fixing
   * either removes both. Reporting one line as two candidates would spend a
   * verification call on a defect already described, which is the same cost the
   * module already pays between `lock-scope` and the atomicity rules. The window is
   * the more specific claim about that line, so it is the one that survives.
   */
  suppressed: number
}

/**
 * Run every signal shape over one handler.
 *
 * Order matters for one reason only: the window claim is computed before the unsafe
 * calls so that it can suppress the release line it is about.
 */
export const runSignalShapes = (input: SignalShapesInput): SignalShapeResult => {
  const windows = reentrancyWindows({
    events: input.events,
    lines: input.lines,
    bindings: input.bindings,
    handler: input.handler,
  })
  const claimed = new Set(windows.map((finding) => finding.releaseLine))

  const calls: Array<Extract<SignalFinding, { shape: 'unsafe-call' }>> = []
  let suppressed = 0
  for (const finding of unsafeCalls(input.events)) {
    if (claimed.has(finding.line)) {
      suppressed += 1
      continue
    }
    calls.push({ ...finding, signals: [...input.handler.signals] })
  }

  const jumps = nonLocalJumps(input.events).map((finding) => ({
    ...finding,
    signals: [...input.handler.signals],
  }))

  return {
    findings: [
      ...windows,
      ...calls,
      ...sharedStateRaces({
        touches: globalTouches({ lines: input.lines, scope: input.scope }),
        scope: input.scope,
        otherTouches: input.otherTouches,
        signals: input.handler.signals,
      }),
      ...jumps,
    ],
    suppressed,
  }
}

/** The line a signal finding points a reviewer at, region-relative. */
export const signalFindingLine = (finding: SignalFinding): number => {
  switch (finding.shape) {
    case 'unsafe-call':
      return finding.line
    case 'reentrancy-window':
      return finding.invalidateLine
    case 'shared-state':
      return finding.line
    case 'non-local-jump':
      return finding.line
  }
}

/**
 * The earlier end of the claim, when the shape has one.
 *
 * Only `reentrancy-window` does, and it is the release — the line a reviewer has to
 * read to see that the window exists at all.
 */
export const signalFindingCheckLine = (finding: SignalFinding): number | null =>
  finding.shape === 'reentrancy-window' ? finding.releaseLine : null
