/**
 * The five shape detectors (spec §4.4.1).
 *
 * Two operations live here and they are used for different things:
 *
 * - `classifyHunk` reads a fix commit's hunk and decides **which of §4.4.1's five
 *   shapes the fix added**, extracting the subject and the operation the fix was
 *   about. This is how a patch becomes a candidate pattern.
 * - `detectShape` answers **"does this region still have the pre-fix shape?"**
 *   It is called twice on every classified hunk — once on the pre-image, once on
 *   the post-image — and that pair of answers is §4.4.1's validation. It is then
 *   called on sibling functions in the current tree.
 *
 * ## These are surface detectors, and the spec's validation is what makes them safe to use
 *
 * A regex cannot decide whether a pointer can be null. Nothing here does dataflow,
 * and none of these detectors is precise on its own — `null-check` subject-free
 * would fire on most of a C codebase, which is exactly the failure mode §4.3
 * warns about ("generic rules exceed 90% FP on OWASP").
 *
 * What keeps that honest is the admission rule. A pattern is only mined if the
 * detector fires on its own patch's pre-image *and* not on the post-image, so
 * every mined pattern demonstrably explains the fix it came from. That is a
 * weaker property than precision — it does not follow that a pattern is a good
 * detector — and the spec asks for exactly this much because the stages that
 * follow (triage, cross-model verification) are the ones built to judge.
 *
 * ## Two deliberate narrowings, both costing recall
 *
 * 1. **Only explicit `NULL`/`nullptr` counts as a null test.** `if (p == 0)` is a
 *    null check in C and is not read as one here. Accepting `0` would classify
 *    every added `if (count == 0) return;` as a null check, and because such a
 *    patch still passes validation — the pre-image uses `count` and has no test,
 *    the post-image has one — the result would be a *validated* pattern about an
 *    integer. A false pattern that passes validation is worse than a missed one,
 *    because validation is the only gate there is.
 * 2. **A shape with no portable `operation` is dropped rather than swept
 *    subject-free.** The subject of a fix (`dst`) does not appear in any other
 *    function, so a subject-free sweep would be shape-only and far too broad. The
 *    operation (`strcpy`) is the part that generalises. Where a patch yields no
 *    operation there is nothing to sweep with, so the pattern is rejected and
 *    counted.
 */

import { addedLines, postImage, preImage, removedLines } from './diff'

import type { CommitPatch, FixShape, Hunk, ShapeFinding, ShapeHint } from './types'

/** Comment and blank lines, which no detector should read. */
const COMMENT_OR_BLANK = /^\s*(?:\/\/|\/\*|\*\/|\*(?:\s|$)|\/\/\/|#)/

/**
 * These five detectors are C and C++ **by the tables further down this file** —
 * `NULL_TESTS`, `RELEASE_FN`, `LOCK_ACQUIRE`, `ARROW_DEREF`. Which languages that
 * amounts to is declared in one place, `detectors/capability.ts`, rather than as a
 * constant here: the check-to-use FSMs and the POSIX signal table cover the same
 * languages today for their own reasons, and a single shared list could not say so
 * once they diverge. The filter a sweep builds and the callables it therefore skips
 * both come from that matrix — see it for why the choice is per-detector.
 *
 * Adding a language to a detector without giving `nullTestedIdentifiers`, `releases`,
 * `acquiresLock` and `toctou/events.ts` its tables would turn the false negatives
 * that matrix accepts into the false positives it prevents.
 */

/**
 * `*p = NULL;` starts with `*` and is code, not a comment continuation, which is
 * why the `*` case above requires whitespace or end-of-line after it.
 */
export const isCodeLine = (line: string): boolean => !COMMENT_OR_BLANK.test(line)

/** Identifiers tested for null with an explicit `NULL`/`nullptr`. See note 1. */
const NULL_TESTS: readonly RegExp[] = [
  /!\s*([A-Za-z_]\w*)\s*(?:->|\.|\)|,|;|\s*$)/g,
  /([A-Za-z_]\w*)\s*(?:==|!=)\s*(?:NULL|nullptr)\b/g,
  /\b(?:NULL|nullptr)\s*(?:==|!=)\s*([A-Za-z_]\w*)/g,
]

/** Release-family calls — the end of an allocation's lifetime. */
const RELEASE_FN =
  /\b(free|kfree|kzfree|kvfree|vfree|g_free|g_free0|fclose|CloseHandle)\s*\(\s*&?([A-Za-z_]\w*)/g

/** C++ `delete p;` / `delete[] p;` — no parentheses to match. */
const DELETE_STMT = /\bdelete(?:\[\])?\s+(?:\(\s*)?&?([A-Za-z_]\w*)/

const LOCK_ACQUIRE =
  /\b(mutex_lock|mutex_lock_interruptible|spin_lock|spin_lock_irqsave|spin_lock_irq|spin_lock_bh|pthread_mutex_lock|mtx_lock|EnterCriticalSection|down_read|down_write|down_interruptible|rcu_read_lock|sem_wait|WaitForSingleObject|lock)\s*\(/g

const LOCK_RELEASE =
  /\b(mutex_unlock|spin_unlock|spin_unlock_irqrestore|spin_unlock_irq|spin_unlock_bh|pthread_mutex_unlock|mtx_unlock|LeaveCriticalSection|up_read|up_write|rcu_read_unlock|sem_post|ReleaseMutex|unlock)\s*\(/g

/** `A[i]` where the index is an identifier rather than a constant. */
const INDEX_EXPR = /([A-Za-z_]\w*)\s*\[\s*([A-Za-z_]\w*)\s*\]/g

/** A dereference of an identifier: `p->field` or `p[index]`. */
const ARROW_DEREF = /([A-Za-z_]\w*)\s*->/g

/** `X = callee(` — the assignment a guard exists to check (see note 2). */
const ASSIGN_FROM_CALL = /([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/g

/** Calls that are keywords or operators rather than callees. */
const NON_CALLEES = new Set([
  'if', 'while', 'for', 'switch', 'return', 'sizeof', 'defined', 'else',
  'catch', 'throw', 'do', 'case', 'assert', 'static_assert',
])

/** `p = NULL;` — the reassignment a use-after-free fix adds after a release. */
const NULL_ASSIGNMENT = /([A-Za-z_]\w*)\s*=\s*(?:NULL|nullptr|0)\s*;/

/** Identifiers dereferenced or indexed in a region. */
const dereferencedIdentifiers = (lines: readonly string[]): Set<string> => {
  const found = new Set<string>()
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const match of line.matchAll(ARROW_DEREF)) found.add(match[1]!)
    for (const match of line.matchAll(INDEX_EXPR)) found.add(match[1]!)
  }
  return found
}

/** Identifiers an explicit `NULL` test covers. */
export const nullTestedIdentifiers = (lines: readonly string[]): Set<string> => {
  const found = new Set<string>()
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const pattern of NULL_TESTS) {
      // Each pattern is global; a fresh `lastIndex` per line keeps them safe to
      // reuse across calls.
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        if (match[1]) found.add(match[1])
      }
    }
  }
  return found
}

/** Identifiers released by `free`/`kfree`/`delete` in a region, with the line index. */
export const releases = (
  lines: readonly string[],
): Array<{ identifier: string; index: number; callee: string }> => {
  const found: Array<{ identifier: string; index: number; callee: string }> = []

  lines.forEach((line, index) => {
    if (!isCodeLine(line)) return
    RELEASE_FN.lastIndex = 0
    for (const match of line.matchAll(RELEASE_FN)) {
      if (match[2]) found.push({ identifier: match[2], index, callee: match[1]! })
    }
    const del = DELETE_STMT.exec(line)
    if (del?.[1]) found.push({ identifier: del[1], index, callee: 'delete' })
  })

  return found
}

/** Whether a region acquires a lock. Unlocks alone do not count. */
export const acquiresLock = (lines: readonly string[]): boolean => {
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    LOCK_ACQUIRE.lastIndex = 0
    if (LOCK_ACQUIRE.test(line)) return true
  }
  return false
}

export const releasesLock = (lines: readonly string[]): boolean => {
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    LOCK_RELEASE.lastIndex = 0
    if (LOCK_RELEASE.test(line)) return true
  }
  return false
}

/** The first non-keyword callee in a line, or null. */
export const firstCallee = (line: string): string | null => {
  for (const match of line.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1]!
    if (!NON_CALLEES.has(name)) return name
  }
  return null
}

/** Call names present in a region, in order, ignoring keywords. */
export const callees = (lines: readonly string[]): string[] => {
  const found: string[] = []
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const match of line.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
      const name = match[1]!
      if (!NON_CALLEES.has(name)) found.push(name)
    }
  }
  return found
}

/** Identifiers appearing as arguments to a call of `callee`. */
export const argumentsTo = (lines: readonly string[], callee: string): Set<string> => {
  const found = new Set<string>()
  const pattern = new RegExp(`\\b${escapeRegex(callee)}\\s*\\(([^;]*?)\\)`, 'g')

  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const match of line.matchAll(pattern)) {
      for (const identifier of match[1]!.matchAll(/[A-Za-z_]\w*/g)) {
        found.add(identifier[0]!)
      }
    }
  }
  return found
}

/** Every identifier passed as an argument to any call in the region. */
export const callArguments = (lines: readonly string[]): Set<string> => {
  const found = new Set<string>()

  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const match of line.matchAll(/([A-Za-z_]\w*)\s*\(([^;]*?)\)/g)) {
      if (NON_CALLEES.has(match[1]!)) continue
      for (const identifier of match[2]!.matchAll(/[A-Za-z_]\w*/g)) {
        found.add(identifier[0]!)
      }
    }
  }
  return found
}

const escapeRegex = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Split a parameter list on top-level commas.
 *
 * Nested commas are real — `void (*cb)(int a, int b)` and `f(int (*g)(int, int))`
 * both appear — so a plain `split(',')` would invent parameters that do not
 * exist.
 */
export const splitTopLevel = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))

  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The signature text preceding the body brace, when the region includes it. */
export const signatureText = (lines: readonly string[]): string | null => {
  const parts: string[] = []
  for (let index = 0; index < Math.min(lines.length, 12); index += 1) {
    const line = lines[index]!
    parts.push(line)
    if (line.includes('{')) break
  }

  const joined = parts.join(' ')
  const brace = joined.indexOf('{')
  const signature = (brace === -1 ? joined : joined.slice(0, brace)).trim()
  return signature.includes('(') ? signature : null
}

/**
 * Pointer parameter names of the function a region belongs to.
 *
 * This is what lets the `null-check` detector work **subject-free**, which the
 * sibling sweep needs: the variable a fix protected (`dst`) is a local name that
 * appears nowhere else, so searching for siblings means searching for "a pointer
 * parameter dereferenced with no null test". A whole-function region carries its
 * signature, so the parameters are recoverable; a hunk fragment does not, which
 * is why validation always passes an explicit subject instead.
 */
export const pointerParameters = (lines: readonly string[]): string[] => {
  const signature = signatureText(lines)
  if (signature === null) return []

  const open = signature.indexOf('(')
  let depth = 0
  let close = -1
  for (let index = open; index < signature.length; index += 1) {
    const character = signature[index]!
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return []

  const names: string[] = []
  for (const parameter of splitTopLevel(signature.slice(open + 1, close))) {
    // A function pointer's name is inside a nested parenthesised declarator.
    const functionPointer = /\(\s*\*+\s*([A-Za-z_]\w*)\s*\)/.exec(parameter)
    if (functionPointer?.[1]) {
      names.push(functionPointer[1])
      continue
    }

    if (!parameter.includes('*')) continue
    const declared = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*$/.exec(parameter)
    if (declared?.[1]) names.push(declared[1])
  }
  return names
}

/**
 * Parameter names of the function a region belongs to, **in order**.
 *
 * Ordered and sparse, which is the difference from `pointerParameters`. That one
 * answers "which pointers does this function take", which is what a null-check
 * subject needs and what a set is good for. Matching a call site needs a different
 * question — *which position* is which parameter, because arguments are matched by
 * position. `(int flags, const char *path)` is one pointer either way, but `path` is
 * the argument at index 1 and no set can say so.
 *
 * `null` marks a parameter that names nothing (a bare type such as `int`, or an
 * unnamed `void *`), because a position that cannot be named cannot be matched to an
 * argument and must occupy its slot rather than shift the ones after it.
 */
export const parameterNames = (lines: readonly string[]): Array<string | null> => {
  const signature = signatureText(lines)
  if (signature === null) return []

  const open = signature.indexOf('(')
  let depth = 0
  let close = -1
  for (let index = open; index < signature.length; index += 1) {
    const character = signature[index]!
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return []

  const parameters = splitTopLevel(signature.slice(open + 1, close))
  // `void` alone is an empty list, not a parameter named `void`.
  if (parameters.length === 1 && parameters[0] === 'void') return []

  return parameters.map((parameter) => {
    // A function pointer's name is inside a nested parenthesised declarator.
    const functionPointer = /\(\s*\*+\s*([A-Za-z_]\w*)\s*\)/.exec(parameter)
    if (functionPointer?.[1]) return functionPointer[1]

    const declared = /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*$/.exec(parameter)
    const name = declared?.[1]
    // The whole parameter being one identifier means that identifier is the type.
    if (name === undefined || name === parameter.trim()) return null
    return name
  })
}

/**
 * The first line (1-based) where `identifier` is used, or null.
 *
 * Deliberately broad — a dereference, a release, or an argument to *any* call.
 * It used to require the identifier to be an argument to the one mined
 * operation, and that was wrong in a way that cost recall silently: whenever the
 * operation heuristic picked the wrong callee out of a hunk's context, the
 * pre-image stopped firing and the pattern was dropped. Narrowing the *sweep* to
 * the mined operation is the job of `siblings.ts`, which can do it as a prefilter
 * on the whole function; narrowing the *detector* only ever produced rejections.
 *
 * Returning a line rather than a boolean is what makes a candidate's snippet show
 * the defect instead of the enclosing function's signature.
 */
/**
 * The index of the line opening the body, or -1 when the region has no brace.
 *
 * A region taken from the program model starts at the function's first line, so
 * its signature is inside it. The signature must not be scanned for *uses*: the
 * pattern `name(args)` matches a declaration exactly as well as a call, so
 * `int paste(char *dst, const char *src)` would report `dst` as used on the
 * signature line and every site would be reported at line 1. A hunk fragment has
 * no signature and no brace, which leaves the skip inert — which is what keeps
 * validation, where the region is a fragment, working unchanged.
 */
const bodyStartIndex = (lines: readonly string[]): number => {
  for (let index = 0; index < Math.min(lines.length, 12); index += 1) {
    if (lines[index]!.includes('{')) return index
  }
  return -1
}

/**
 * Whether a line opens a function definition rather than calling one.
 *
 * The `name(args)` pattern matches a declaration exactly as well as a call, so
 * `int copy(char *dst, const char *src) {` reports `copy` as a callee. That is the
 * wrong answer for "the operation this fix was about" in a way that is easy to
 * miss: the mined pattern would say `null-check` about the function's own name,
 * validate against nothing, and quietly cost the recall it exists to produce.
 */
const looksLikeDeclaration = (line: string): boolean => {
  const trimmed = line.trim()
  if (/^(if|for|while|switch|else|do|catch)\b/.test(trimmed)) return false
  return /\)\s*\{?\s*$/.test(trimmed)
}

const firstUseLine = (lines: readonly string[], identifier: string): number | null => {
  const escaped = escapeRegex(identifier)
  const deref = new RegExp(`\\b${escaped}\\s*(?:->|\\.|\\[)`)
  const released = new RegExp(`\\b(?:free|kfree|kzfree|kvfree|vfree|g_free|g_free0|fclose|CloseHandle)\\s*\\(\\s*&?${escaped}\\b`)
  const deleted = new RegExp(`\\bdelete(?:\\[\\])?\\s+\\(?&?${escaped}\\b`)
  const passed = new RegExp(`\\b[A-Za-z_]\\w*\\s*\\([^;]*?\\b${escaped}\\b`)

  const releasedAt = releases(lines).findIndex((release) => release.identifier === identifier)
  const from = bodyStartIndex(lines) + 1

  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!isCodeLine(line)) continue
    if (deref.test(line) || released.test(line) || deleted.test(line) || passed.test(line)) {
      return index + 1
    }
  }

  // A release still counts as a use, and it is the one a null check is most likely
  // about. Reported relative to the whole region, as every other line here is.
  return releasedAt === -1 ? null : releasedAt + 1
}

/**
 * Does this region still carry the pre-fix shape?
 *
 * Returns the first finding, or null. Callers that need "did it fire at all" —
 * which is every validation call — only care about null versus non-null; the
 * evidence line exists so a candidate can say *why* it was emitted.
 */
export const detectShape = (
  lines: readonly string[],
  shape: FixShape,
  hint: ShapeHint = {},
): ShapeFinding | null => {
  const findings = detectAll(lines, shape, hint)
  return findings.length === 0 ? null : findings[0]!
}

/** Every finding of a shape in a region, in line order. */
export const detectAll = (
  lines: readonly string[],
  shape: FixShape,
  hint: ShapeHint = {},
): ShapeFinding[] => {
  const subject = hint.subject ?? null
  const operation = hint.operation ?? null

  switch (shape) {
    case 'null-check': {
      // Subject-free: the pointer parameters of the enclosing function. Without a
      // signature — a hunk fragment, or a file whose symbols are not indexed —
      // there is nothing to reason about, so nothing fires.
      const candidates = subject !== null ? [subject] : pointerParameters(lines)
      if (candidates.length === 0) return []

      const tested = nullTestedIdentifiers(lines)
      const findings: ShapeFinding[] = []

      for (const candidate of candidates) {
        if (tested.has(candidate)) continue
        const line = firstUseLine(lines, candidate)
        if (line === null) continue
        findings.push({
          shape,
          subject: candidate,
          operation,
          line,
          evidence:
            operation !== null
              ? `\`${candidate}\` is used by \`${operation}\` with no null test`
              : `\`${candidate}\` is used with no null test`,
        })
      }
      return findings
    }

    case 'bounds-check': {
      const compared = comparisons(lines)
      const findings: ShapeFinding[] = []

      for (const line of codeLineIndices(lines)) {
        INDEX_EXPR.lastIndex = 0
        for (const match of lines[line]!.matchAll(INDEX_EXPR)) {
          const index = match[2]!
          if (subject !== null && index !== subject) continue
          if (compared.has(index)) continue
          findings.push({
            shape,
            subject: index,
            operation,
            line: line + 1,
            evidence: `\`${match[1]}\` is indexed by \`${index}\` with no bounds check`,
          })
        }
      }

      // An operation-scoped form, for a fix that guards a call rather than an
      // index — `memcpy(dst, src, len)` behind a `len <= sizeof` test.
      if (findings.length === 0 && operation !== null) {
        const at = lines.findIndex(
          (line) => isCodeLine(line) && callees([line]).includes(operation),
        )
        const boundIdentifiers =
          subject !== null ? compared.has(subject) : compared.size > 0
        if (at !== -1 && !boundIdentifiers) {
          findings.push({
            shape,
            subject,
            operation,
            line: at + 1,
            evidence: `\`${operation}\` is called with no bounds check`,
          })
        }
      }

      return findings
    }

    case 'guard': {
      // A guard checks the result of a call. Without knowing which call, there is
      // nothing to look for — see note 2.
      if (operation === null) return []
      const findings: ShapeFinding[] = []

      for (const line of codeLineIndices(lines)) {
        const text = lines[line]!

        ASSIGN_FROM_CALL.lastIndex = 0
        const assignment = ASSIGN_FROM_CALL.exec(text)
        if (assignment && assignment[2] === operation) {
          const assigned = assignment[1]!
          if (subject !== null && assigned !== subject) continue
          if (resultIsTested(lines, assigned)) continue
          findings.push({
            shape,
            subject: assigned,
            operation,
            line: line + 1,
            evidence: `the result of \`${operation}\` is stored in \`${assigned}\` and never checked`,
          })
          continue
        }

        // A bare call statement: the result is discarded outright.
        const callee = firstCallee(text)
        if (callee !== operation) continue
        if (/=/.test(text.split(operation)[0] ?? '')) continue
        if (/^\s*if\s*\(/.test(text) || /\breturn\b/.test(text)) continue
        findings.push({
          shape,
          subject,
          operation,
          line: line + 1,
          evidence: `the result of \`${operation}\` is discarded`,
        })
      }

      return findings
    }

    case 'lock': {
      if (operation === null) return []
      if (acquiresLock(lines)) return []

      const at = lines.findIndex(
        (line) => isCodeLine(line) && callees([line]).includes(operation),
      )
      if (at === -1) return []

      return [
        {
          shape,
          subject,
          operation,
          line: at + 1,
          evidence: `\`${operation}\` is called with no lock held`,
        },
      ]
    }

    case 'lifetime': {
      const found = releases(lines)
      const candidates =
        subject !== null
          ? found.filter((release) => release.identifier === subject)
          : found

      for (const release of candidates) {
        const after = lines.slice(release.index + 1)
        const name = release.identifier
        const usedAfter =
          dereferencedIdentifiers(after).has(name) ||
          after.some(
            (line) =>
              isCodeLine(line) &&
              new RegExp(`\\b${escapeRegex(name)}\\b`).test(line) &&
              // Reassignment is not a use.
              !new RegExp(`\\b${escapeRegex(name)}\\s*=`).test(line),
          )

        if (usedAfter) {
          return [
            {
              shape,
              subject: name,
              operation: release.callee,
              line: release.index + 1,
              evidence: `\`${name}\` is used after \`${release.callee}\``,
            },
          ]
        }
      }
      return []
    }

    default:
      return []
  }
}

/** Indices of code lines, so detectors can report a real line number. */
const codeLineIndices = (lines: readonly string[]): number[] =>
  lines.map((line, index) => (isCodeLine(line) ? index : -1)).filter((index) => index >= 0)

/** Identifiers compared against anything — the bound side of a bounds check. */
const comparisons = (lines: readonly string[]): Set<string> => {
  const found = new Set<string>()
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    for (const match of line.matchAll(/([A-Za-z_]\w*)\s*(?:<=|>=|<|>)\s*([A-Za-z_]\w*)/g)) {
      found.add(match[1]!)
      found.add(match[2]!)
    }
  }
  return found
}

/** Whether a value derived from a call is checked before it is used. */
const resultIsTested = (lines: readonly string[], identifier: string): boolean => {
  const escaped = escapeRegex(identifier)
  const tests = [
    new RegExp(`!\\s*${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*(?:==|!=|<=|>=|<|>)\\s*(?:-1|0|NULL|nullptr|EOF|\\w+)`),
    new RegExp(`(?:-1|0|NULL|nullptr|EOF|\\w+)\\s*(?:==|!=|<=|>=|<|>)\\s*\\b${escaped}\\b`),
  ]

  return lines.some((line) => isCodeLine(line) && tests.some((test) => test.test(line)))
}

export interface ClassifiedHunk {
  shape: FixShape
  hint: ShapeHint
  /** The defect the patch fixed, phrased for a candidate message. */
  description: string
}

/**
 * Which of §4.4.1's five shapes did this hunk add, and what is it about?
 *
 * The decision procedure is ordered, and the order is the design. A null test is
 * checked before a bounds comparison because `if (p != NULL)` also reads as a
 * comparison; a release before a comparison for the same reason. `guard` is last
 * and requires the strongest evidence — an assignment from a call in the
 * pre-image — because it is the only shape whose classification cannot be made
 * from the added lines alone, and guessing it would produce patterns about
 * variables that were never call results.
 *
 * Returns null for a hunk matching none of the five. §4.4.1's taxonomy is closed,
 * so an unrecognised patch yields no pattern rather than the nearest guess.
 */
export const classifyHunk = (hunk: Hunk): ClassifiedHunk | null => {
  const added = addedLines(hunk)
    .map((line) => line.text)
    .filter((line) => isCodeLine(line))
  if (added.length === 0) return null

  const before = preImage(hunk).filter((line) => isCodeLine(line))
  const after = postImage(hunk).filter((line) => isCodeLine(line))

  // The operation is the code the fix was about, so the *removed* lines are read
  // first: a fix that replaced a dangerous call removed it, which makes the
  // removed side the better evidence than the surviving context. Getting this
  // wrong is not dangerous — a wrong operation makes the detector miss the
  // pre-image, and the pattern is then rejected rather than emitted — but it does
  // silently cost recall, which is why the removed side is preferred.
  // The signature has to be skipped on both paths, for the reason
  // `looksLikeDeclaration` gives: a declaration looks exactly like a call.
  const guardedOperation = (): string | null => {
    const removed = removedLines(hunk)
      .map((line) => line.text)
      .filter((line) => isCodeLine(line) && !looksLikeDeclaration(line))
    const context = before.slice(bodyStartIndex(before) + 1)
    return firstCalleeIn(removed) ?? firstCalleeIn(context)
  }

  for (const line of added) {
    // 1. An explicit null test.
    for (const pattern of NULL_TESTS) {
      pattern.lastIndex = 0
      const match = pattern.exec(line)
      if (match?.[1]) {
        return {
          shape: 'null-check',
          hint: { subject: match[1], operation: guardedOperation() },
          description: `\`${match[1]}\` was used without a null test`,
        }
      }
    }
  }

  for (const line of added) {
    // 2. A lock acquire. The subject is the first argument, when there is one.
    LOCK_ACQUIRE.lastIndex = 0
    if (LOCK_ACQUIRE.test(line)) {
      const argument = /\(\s*&?\s*([A-Za-z_]\w*)/.exec(line)
      return {
        shape: 'lock',
        hint: { subject: argument?.[1] ?? null, operation: guardedOperation() },
        description: 'a shared access was made with no lock held',
      }
    }
  }

  for (const line of added) {
    // 3. A release: an allocation's lifetime was ended.
    RELEASE_FN.lastIndex = 0
    const released = RELEASE_FN.exec(line)
    const deleted = DELETE_STMT.exec(line)
    const identifier = released?.[2] ?? deleted?.[1]

    if (identifier) {
      return {
        shape: 'lifetime',
        hint: { subject: identifier, operation: released?.[1] ?? 'delete' },
        description: `\`${identifier}\` was used after being released`,
      }
    }
  }

  for (const line of added) {
    // 3b. The other half of the same fix: `p = NULL;` added where the release is
    //     already present in the context.
    //
    //     This branch exists because without it the most common real fix —
    //     `free(p);` unchanged, `p = NULL;` added, the later use removed —
    //     classifies as *nothing*, since the release it is about is not an added
    //     line. The hunk would then be counted unrecognised and the pattern never
    //     mined. Requiring the release in the pre-image is what keeps this from
    //     firing on every `x = 0;` assignment in a patch.
    const nulled = NULL_ASSIGNMENT.exec(line)
    if (nulled?.[1] && releases(before).some((r) => r.identifier === nulled[1])) {
      return {
        shape: 'lifetime',
        hint: { subject: nulled[1], operation: null },
        description: `\`${nulled[1]}\` was used after being released`,
      }
    }
  }

  for (const line of added) {
    // 4. A comparison between two identifiers is a bounds check.
    const comparison = /([A-Za-z_]\w*)\s*(?:<=|>=|<|>)\s*([A-Za-z_]\w*)/.exec(line)
    if (comparison) {
      return {
        shape: 'bounds-check',
        hint: {
          subject: comparison[1]!,
          operation: firstCallee(before.find((text) => firstCallee(text) !== null) ?? ''),
        },
        description: `\`${comparison[1]}\` was used without a bounds check`,
      }
    }
  }

  for (const line of added) {
    // 5. A comparison against a literal is a return-value guard — but only when
    //    some line of this hunk stored a call result in that variable. Without
    //    that the comparison is something else and the hunk is not a `guard`.
    //
    //    The assignment is looked for on **both** sides, because which side it is
    //    on distinguishes two common fixes of the same defect. If the call was
    //    already assigned and only the `if` was added, the assignment is in the
    //    pre-image. If the fix changed a discarded call into an assigned one —
    //    `read(fd, b, n);` becoming `ret = read(fd, b, n);` — it is in the added
    //    lines. Searching only the pre-image handled the first and silently
    //    dropped the second, and the second is the more common repair.
    const againstLiteral =
      /([A-Za-z_]\w*)\s*(?:<=|>=|<|>|==|!=)\s*(?:-1|0|EOF|NULL|nullptr)\b/.exec(line)
    if (!againstLiteral) continue

    const tested = againstLiteral[1]!
    const searchable = [...before, ...after]
    for (const candidate of searchable) {
      ASSIGN_FROM_CALL.lastIndex = 0
      const assignment = ASSIGN_FROM_CALL.exec(candidate)
      if (!assignment || assignment[1] !== tested) continue
      return {
        shape: 'guard',
        hint: { subject: tested, operation: assignment[2]! },
        description: `the result of \`${assignment[2]}\` was never checked`,
      }
    }
  }

  return null
}

/** The first non-keyword callee across a set of lines, or null. */
const firstCalleeIn = (lines: readonly string[]): string | null => {
  for (const line of lines) {
    if (!isCodeLine(line)) continue
    const callee = firstCallee(line)
    if (callee !== null) return callee
  }
  return null
}

/** Every hunk of a commit that classified, with its classification. */
export const classifyCommit = (
  commit: CommitPatch,
): Array<{ hunk: Hunk; classified: ClassifiedHunk }> => {
  const found: Array<{ hunk: Hunk; classified: ClassifiedHunk }> = []

  for (const hunk of commit.hunks) {
    const classified = classifyHunk(hunk)
    if (classified) found.push({ hunk, classified })
  }

  return found
}
