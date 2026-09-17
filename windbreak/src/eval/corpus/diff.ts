/**
 * Reading a fix commit (spec §11.1).
 *
 * §11.1's corpus is vulnerable/patched pairs, and the thing that makes a corpus
 * worth scoring against is that its ground truth came from somewhere other than
 * the researcher's judgement. A commit that fixes a CVE is that source: the
 * revision before it is known to contain the defect and the revision after it is
 * known not to, and neither claim is the author's opinion.
 *
 * So this module does not decide what a bug is. It reads two facts off a commit
 * and hands them on:
 *
 * - **which lines the commit changed**, on the pre-fix side, because that is
 *   what identifies the function the fix is about;
 * - **which CVE ids the message names**, because that is the entry's identifier
 *   and, where the project tags them, the only authority in the file.
 *
 * Both parsers are pure and total: a diff or a message they cannot read yields
 * nothing rather than a guess. A commit that names no CVE, or changes no line,
 * contributes no pair — and a corpus that silently invented one would be exactly
 * the hand-seeded fixture this tier exists to replace.
 */

/** A changed region on the *pre-fix* side, 1-based inclusive. */
export interface ChangedRange {
  start: number
  end: number
}

export interface ChangedFile {
  /** Path as git records it, relative to the repository root. */
  filePath: string
  /** Changed regions in the vulnerable revision's numbering. Sorted, non-overlapping. */
  ranges: ChangedRange[]
}

/**
 * Paths git quotes because they contain characters it would otherwise reinterpret.
 *
 * `git diff` wraps such a path in double quotes and backslash-escapes the
 * offending bytes. A corpus entry whose path kept those quotes would match no
 * candidate, and — because matching is done on trailing path segments — it would
 * fail as a *miss* rather than as malformed ground truth.
 */
const unquoteGitPath = (value: string): string => {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  const body = value.slice(1, -1)
  const bytes: number[] = []
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char))
      continue
    }
    const next = body[index + 1]
    index += 1
    if (next === undefined) break
    if (next === 'n') bytes.push(10)
    else if (next === 't') bytes.push(9)
    else if (next === 'r') bytes.push(13)
    else if (/[0-7]/.test(next)) {
      const octal = body.slice(index, index + 3)
      const match = /^[0-7]{1,3}/.exec(`${next}${body.slice(index + 1, index + 3)}`)
      bytes.push(Number.parseInt(match ? match[0] : next, 8))
      index += (match ? match[0].length : 1) - 1
      void octal
    } else bytes.push(...new TextEncoder().encode(next))
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The path a `+++` header names, with the `b/` prefix removed.
 *
 * Git quotes a path that holds a space or a non-ASCII byte, and writes it as
 * `"b/sp ace.c"`. Matching `b/` directly therefore misses exactly the files
 * whose names are awkward — a silent loss of ground truth in a module whose whole
 * job is to not lose it. `/dev/null` carries no prefix and must not be rewritten.
 */
const headerPath = (line: string): string | null => {
  const match = /^\+\+\+ (.*)$/.exec(line)
  if (match === null) return null

  let raw = match[1]!
  // A tab-separated field can follow the path; it is not part of it.
  const tab = raw.indexOf('\t')
  if (tab >= 0) raw = raw.slice(0, tab)

  const unquoted = unquoteGitPath(raw.trim())
  return /^[ab]\//.test(unquoted) ? unquoted.slice(2) : unquoted
}

/**
 * The changed regions per file, keyed by the **new** path.
 *
 * The new path is the key because a rename is a change to the file the fix
 * produced, and the vulnerable revision is read by asking git for the old path
 * (see `build.ts`). Keys are the path as written after `b/`, so a candidate's
 * path and a corpus entry's path can meet once both are normalized.
 *
 * A pure deletion (`-n,0`) carries no post-fix line to attribute, and a hunk
 * whose count is omitted means one line, not none — both are handled here rather
 * than left to the caller, because getting them wrong shifts every range in the
 * file by one and the resulting pair would look plausible.
 */
export const parseChangedFiles = (diff: string): ChangedFile[] => {
  const byPath = new Map<string, ChangedRange[]>()
  let current: string | null = null

  // Hunk bodies are consumed by *count* rather than by looking at each line's
  // first character. A source line `++ foo` is rendered `+++ foo`, which a
  // `+++ `-prefix test cannot tell from a file header — and reading it as one
  // would attribute the rest of the diff to a file that does not exist.
  let remainingOld = 0
  let remainingNew = 0

  for (const line of diff.split('\n')) {
    if (remainingOld > 0 || remainingNew > 0) {
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) remainingNew -= 1
      else if (line.startsWith('-')) remainingOld -= 1
      else {
        remainingOld -= 1
        remainingNew -= 1
      }
      continue
    }

    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      const countOld = hunk[2] === undefined ? 1 : Number(hunk[2])
      const countNew = hunk[4] === undefined ? 1 : Number(hunk[4])
      remainingOld = countOld
      remainingNew = countNew

      // `-n,0` is a pure deletion: the post-fix side has nothing there to
      // bracket a function in, so it contributes no range.
      if (current !== null && countOld > 0) {
        const start = Number(hunk[1])
        byPath.get(current)!.push({ start, end: start + countOld - 1 })
      }
      continue
    }

    if (line.startsWith('+++ ')) {
      const path = headerPath(line)
      current = path === null || path === '/dev/null' ? null : path
      if (current !== null && !byPath.has(current)) byPath.set(current, [])
      continue
    }
  }

  return [...byPath.entries()].map(([filePath, ranges]) => ({
    filePath,
    ranges: ranges.sort((left, right) => left.start - right.start),
  }))
}

const CVE_ID = /CVE-\d{4}-\d{4,7}/gi

/**
 * CVE ids named in a commit message, upper-cased and deduplicated.
 *
 * A fix commit frequently names more than one — a release that closes two
 * findings, or a regression test that references the original — so the result is
 * a list and the builder emits one pair per CVE per function. Attributing such a
 * commit to only the first id would understate the corpus by exactly the bugs
 * that were fixed together, which is a biased loss rather than a random one.
 */
export const cvesInMessage = (message: string): string[] => {
  const found = message.match(CVE_ID) ?? []
  return [...new Set(found.map((id) => id.toUpperCase()))].sort()
}

/** True for the source files a function-level corpus can extract halves from. */
export const isCSourcePath = (filePath: string): boolean =>
  /\.(c|h|cc|cpp|cxx|hh|hpp|hxx)$/.test(filePath)
