/**
 * Alias analysis on locks and on checked/used variables (spec §4.4.3).
 *
 * §4.4.3 asks for alias analysis "to hold precision", and that phrase decides the
 * whole design: this is a *precision* instrument, not a recall one. Every
 * ambiguity below resolves toward reporting less. That is the right trade here
 * because an FSM match is a claim about a race, races need a human to confirm, and
 * a race detector that cries wolf is one nobody reads — the same reasoning §2.4
 * applies to precision generally.
 *
 * ## Two relations, not one
 *
 * They are genuinely different and conflating them was the first thing that went
 * wrong when this module was built:
 *
 * - **`aliases`** — the same object. `access(p)` and `open(p)` are about the same
 *   path; `access(p)` and `open(q)` are not, and firing on them would report a
 *   race between two unrelated objects.
 * - **`guardedBy`** — this lock covers this access. Holding `m` protects `m.field`
 *   and `m->field` and `m[i]`, so this relation is *containment*, not equality.
 *   Using equality here would mean a lock on `m` never protects anything but `m`
 *   itself, and the lock-scope FSM would never find a correctly-locked region.
 *
 * ## What "alias" means here, precisely
 *
 * Must-alias by expression identity, after two steps of normalization:
 *
 * 1. **Syntactic** — casts, outer parentheses, address-of, and whitespace are
 *    removed, so `(void *)&s->mu` and `s->mu` are one key.
 * 2. **Copy propagation within the function** — `local = &s->mu;` makes `local`
 *    resolve to `s->mu` for the rest of the body, so a lock taken through a local
 *    is recognised as the same lock.
 *
 * Anything not resolvable this way does **not** alias. That is the
 * precision-holding direction and it is a real recall cost: two parameters that
 * point to the same struct at runtime are two keys here, and a race between them
 * is missed. Full alias analysis needs points-to information this module does not
 * have, and §4.4.3 is explicit that the flag is for logic flaws a human confirms.
 */

import { isCodeLine } from '../patchmine/shapes'

/**
 * A parenthesised group at the start of the expression: the cast candidate.
 *
 * Nested parentheses are excluded, so `(void (*)(int))` is not a candidate at all.
 */
const CAST_CANDIDATE = /^\(\s*([^()]*?)\s*\)/

/** Words that only ever appear inside a type, so they settle the question alone. */
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
  '_Atomic',
  '_Complex',
])

/**
 * Type names a single-word cast may use: the builtin scalars, plus anything that
 * *reads* as a typedef.
 *
 * This is deliberately conservative. The alternative — treating any identifier in
 * parentheses as a cast — silently mangles expressions: `(a) + (b)` became `+ (b)
 * once, which is how this predicate came to exist. A missed cast costs recall
 * (an atypical typedef name does not get stripped, so two spellings of one object
 * fail to alias); a false cast corrupts the key, which is worse.
 */
const BUILTIN_TYPES = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'bool',
  '_Bool',
  'size_t',
  'ptrdiff_t',
  'intptr_t',
  'uintptr_t',
  'uint',
  'ulong',
  'ushort',
  'byte',
])

/**
 * Whether the text inside a leading `(...)` reads as a type.
 *
 * See `BUILTIN_TYPES` for why this is a predicate rather than a regex. Anything
 * containing an operator, a subscript, a comma, or another bracket pair is an
 * expression, not a type.
 */
const isTypeCast = (inner: string): boolean => {
  const text = inner.trim()
  if (text.length === 0) return false

  // A type is built from identifiers, spaces, and stars and from nothing else. Any
  // other operator, bracket, or separator means this is an expression: `(a + b)`,
  // `(x[i])`, `(a, b)`. Written as a whitelist with no escape sequences, because
  // `\b`/`\s` in a pattern this module has to round-trip through JSON is a class of
  // bug the tests cannot see.
  if (!/^[A-Za-z0-9_ *]*$/.test(text)) return false

  const words = text.split(/[^A-Za-z0-9_]+/).filter((word) => word.length > 0)
  if (words.length === 0) return false

  const first = words[0]!
  if (TYPE_WORDS.has(first)) return true
  // Two bare identifiers with no type word is not a type, and it is not worth
  // guessing which one was meant.
  if (words.length > 1) return false
  if (NULL_CONSTANTS.has(first)) return false

  return BUILTIN_TYPES.has(first) || first.endsWith('_t') || /^[A-Z]/.test(first)
}

/** A plain expression path: identifiers, member chains, subscripts, one `&`. */
const EXPRESSION_PATH = /^&?\s*[A-Za-z_]\w*(?:\s*(?:->|\.)\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*$/

/**
 * Names that stand for the *absence* of an object rather than for one.
 *
 * `y = NULL` is not a binding: without this, `y` would resolve to the key `NULL`,
 * and every nulled local in the target would then alias every other — a precision
 * hole in the one relation that is supposed to hold precision.
 */
const NULL_CONSTANTS = new Set(['NULL', 'nullptr', 'NIL', 'nil', 'true', 'false'])

/** Statements that are not assignments however much they contain an `=`. */
const CONTROL_KEYWORDS = new Set([
  'if',
  'while',
  'for',
  'switch',
  'return',
  'else',
  'do',
  'case',
  'assert',
])

/**
 * The index of the `=` that assigns, or -1.
 *
 * `==`, `!=`, `<=`, `>=`, `->`, and the compound operators all contain an `=`, and
 * each would make this treat a condition or a call as a binding.
 */
const assignmentEquals = (text: string): number => {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '=') continue
    const before = text[index - 1] ?? ''
    const after = text[index + 1] ?? ''
    if (after === '=') continue
    if ('=!<>+-*/%&|^'.includes(before)) continue
    return index
  }
  return -1
}

/**
 * The identifier a declaration or assignment binds, or null when it binds none.
 *
 * The cases that have to be rejected are the ones where the *last identifier before*
 * the equals is not the name being bound:
 *
 * - `s->mu = …` and `s.mu = …` write a field, and the base (`s`) is not the target.
 * - `arr[i] = …` writes an element.
 * - `*m = …` stores through a pointer.
 * - `int (*fp)(void) = …` is a declarator with no single name to pick out.
 */
const boundName = (prefix: string): string | null => {
  if (prefix.includes(')')) return null

  const match = /([A-Za-z_]\w*)\s*$/.exec(prefix)
  if (!match) return null

  const name = match[1]!
  const before = prefix.slice(0, match.index).trimEnd()

  if (before === '*' || before === '&') return null
  if (/[.\[>]$/.test(before)) return null
  return name
}

/**
 * A single-statement `name = path` binding, declaration or not.
 *
 * Declarations are accepted (`struct mutex *m = &s->mu;`) because in C that is the
 * *common* form for a lock local, and a version that only saw `m = &s->mu` would miss
 * the majority of the copies this exists to follow.
 */
const extractBinding = (line: string): { name: string; value: string } | null => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  const statement = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed
  // Exactly one simple statement: a `for` header or two statements on a line would
  // make last-assignment-wins a claim about code this does not model.
  if (statement.includes(';') || statement.includes('{') || statement.includes('}')) {
    return null
  }

  const firstToken = /^[A-Za-z_]\w*/.exec(statement)?.[0]
  if (firstToken !== undefined && CONTROL_KEYWORDS.has(firstToken)) return null

  const at = assignmentEquals(statement)
  if (at === -1) return null

  const name = boundName(statement.slice(0, at).trimEnd())
  if (name === null) return null

  const value = statement.slice(at + 1).trim()
  // Only a *path*, so `x = 0`, `x = a + b`, and `x = malloc(n)` are all skipped:
  // none of them makes `x` name the object on the right.
  if (!EXPRESSION_PATH.test(value)) return null
  if (NULL_CONSTANTS.has(normalizeExpression(value))) return null

  return { name, value }
}

/** Strip leading address-of. `&s->mu` and `s->mu` name the same object. */
export const stripAddress = (expression: string): string => expression.replace(/^&+\s*/, '')

/**
 * Normalize an expression to a comparable key.
 *
 * Idempotent, because `aliases` normalizes both sides and `resolve` normalizes
 * what it returns: a non-idempotent version would make `a === b` depend on how
 * many times each side had been through it.
 */
export const normalizeExpression = (text: string): string => {
  let value = text.trim()

  // Repeatedly, so `(void *)(char *)p` comes out as `p`. Each round consumes one
  // leading cast and nothing else: the whole matched group is removed, so a cast
  // can never take part of the expression with it.
  for (let round = 0; round < 4; round += 1) {
    const match = CAST_CANDIDATE.exec(value)
    if (!match || !isTypeCast(match[1]!)) break
    value = value.slice(match[0].length).trim()
  }

  // Outer parentheses, repeatedly: `((p))`.
  for (let round = 0; round < 4; round += 1) {
    if (!value.startsWith('(') || !value.endsWith(')')) break
    const inner = value.slice(1, -1)
    if (!balanced(inner)) break
    value = inner.trim()
  }

  value = value.replace(/\s+/g, ' ')
  // Whitespace around a member operator is not part of the expression: `s  ->  mu`
  // and `s->mu` name the same field, and without this they would be two keys and the
  // alias relation would miss the lock. `.` is only collapsed when whitespace is
  // actually present, so `...` and a float literal are untouched.
  value = value.replace(/\s*->\s*/g, '->')
  value = value.replace(/\s+\./g, '.').replace(/\.\s+/g, '.')
  value = stripAddress(value)
  return value.trim()
}

/** Whether parentheses are balanced, so an `(a) + (b)` is not unwrapped. */
const balanced = (text: string): boolean => {
  let depth = 0
  for (const character of text) {
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

export interface Bindings {
  /** Follow `local = expr` chains to a fixed point. Returns the normalized key. */
  resolve: (expression: string) => string
  /** What a key resolved through, when it resolved through anything. */
  sourceOf: (expression: string) => string | null
  /** The raw one-hop assignments, exposed for tests and evidence lines. */
  readonly assignments: ReadonlyMap<string, string>
}

const MAX_HOPS = 8

/**
 * Collect `local = expression` assignments from a function body.
 *
 * Only `name = path` statements are kept, and the path restrictions are the
 * substance: `x = 0`, `x = NULL`, `x = a + b`, and `x = malloc(...)` are all
 * excluded because none of them makes `x` name the object on the right. A composite
 * expression could be aliased by a real analysis; it is skipped rather than guessed
 * at, which is the same direction as every other ambiguity in this module.
 *
 * The last assignment wins, which is wrong for a body that reassigns in a loop or
 * a branch. It is the conservative-enough choice for the common case (a local
 * initialised once and used) and it is recorded as an open item: a path-sensitive
 * version would need a CFG this module does not build.
 */
export const buildBindings = (lines: readonly string[]): Bindings => {
  const assignments = new Map<string, string>()

  for (const line of lines) {
    if (!isCodeLine(line)) continue
    const binding = extractBinding(line)
    if (!binding) continue
    assignments.set(binding.name, normalizeExpression(binding.value))
  }

  const resolve = (expression: string): string => {
    let key = normalizeExpression(expression)
    const seen = new Set<string>([key])

    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const next = assignments.get(key)
      if (next === undefined || next === key || seen.has(next)) break
      seen.add(next)
      key = next
    }

    return key
  }

  const sourceOf = (expression: string): string | null => {
    const original = normalizeExpression(expression)
    const resolved = resolve(original)
    return resolved === original ? null : resolved
  }

  return { resolve, sourceOf, assignments }
}

/**
 * Do these two expressions name the same object?
 *
 * Must-alias after normalization and copy propagation. Unresolvable expressions do
 * not alias — see the module note on why the ambiguity resolves this way.
 */
export const aliases = (left: string, right: string, bindings: Bindings): boolean => {
  const a = bindings.resolve(left)
  const b = bindings.resolve(right)
  if (a.length === 0 || b.length === 0) return false
  return a === b
}

/**
 * The base identifier an expression is rooted at: `s` for `s->count`, `s` for
 * `s.a.b`, `arr` for `arr[i]`, `p` for `p`.
 *
 * This is what makes an atomicity rule *checkable* on a site the mining never saw.
 * The mined pairing is `s->count` under `s->mu`, and the sweep has to decide whether
 * some `s->count` elsewhere is the same resource. Without points-to information the
 * honest answer is "same base identifier, therefore possibly the same object" — so
 * the base is the coarsest thing the rule can be keyed on, and it is deliberately
 * *not* the whole expression, because `s->count` and `s->mu` are two fields of one
 * object and the rule is a statement about that object.
 */
export const baseOf = (expression: string): string => {
  const value = stripAddress(normalizeExpression(expression))
  const match = /^([A-Za-z_]\w*)/.exec(value)
  return match?.[1] ?? value
}

/**
 * Whether an expression names a *field* rather than a whole object — i.e. it has a
 * member or subscript path.
 *
 * The distinction is what keeps atomicity mining from producing rules about bare
 * identifiers: `count` as a resource would match every local named `count` in the
 * target, which is a rule about nothing. A rule is only emitted for a field access,
 * which is where a shared resource in C actually lives.
 */
export const hasFieldPath = (expression: string): boolean => {
  const value = stripAddress(normalizeExpression(expression))
  return /->|\.|\[/.test(value)
}

/**
 * Does holding `lock` protect `accessed`?
 *
 * Containment, not equality: a lock on `m` covers `m.field`, `m->field`, and
 * `m[i]`. This is what makes the lock-scope FSM able to tell a properly serialized
 * region from one whose lock was dropped too early, which is the entire question
 * that FSM asks.
 */
export const guardedBy = (lock: string, accessed: string): boolean => {
  const held = stripAddress(lock)
  const used = stripAddress(accessed)
  if (held.length === 0 || used.length === 0) return false
  if (held === used) return true

  return (
    used.startsWith(`${held}->`) ||
    used.startsWith(`${held}.`) ||
    used.startsWith(`${held}[`)
  )
}

/** Whether a lock expression appears anywhere in a set of held locks. */
export const anyGuards = (held: readonly string[], accessed: string): boolean =>
  held.some((lock) => guardedBy(lock, accessed))
