/**
 * Applying a model's patch to the working copy (spec §20.30, slice 2).
 *
 * A pure module with no filesystem in it: it turns (original text, patch text)
 * into new text or a thrown `PatchError`. The writing is the workspace's job,
 * because the workspace is the only place that knows a path is allowed to be
 * written. Keeping the two apart is what makes the applier testable against a
 * table of cases instead of against a temporary directory.
 *
 * ## Strict on purpose
 *
 * A patch that does not apply is **refused**, never fuzzy-matched into place. The
 * SDK's built-in applier tries three sources and up to three fuzz levels, which is
 * the right trade for an editor that must keep moving; it is the wrong trade here,
 * because this tree is the thing a security claim is going to be checked against.
 * A hunk silently landing two lines lower than the model intended changes which
 * code the model then reasons about, and the failure it produces is a *wrong
 * answer*, not a visible error. Exact context, or a refusal that names the hunk.
 *
 * The one concession is the bare `@@`: a hunk header with no line numbers is
 * located by searching for its context block. That is not fuzz — the block must
 * match exactly — it is reading the header the way models actually emit it.
 *
 * ## Two forms, because models emit two
 *
 * - **Unified diff**, from `git diff` / `diff -u`: `--- a/p`, `+++ b/p`, then
 *   `@@ -old,count +new,count @@` hunks.
 * - **The `*** Begin Patch` envelope** freebuff's own built-in `apply_patch` takes:
 *   `*** Update File: p` / `*** Add File: p` / `*** Delete File: p`, with `@@`
 *   hunks under each.
 *
 * The second is accepted because a model that has used the built-in tool many
 * times will reach for that shape, and refusing it would be a costing of turns for
 * a difference in punctuation. Both reduce to the same hunks, so there is one
 * applier and one set of failure messages.
 */

/** What a patch section does to its file. */
export type PatchAction = 'update' | 'create' | 'delete'

/**
 * One hunk, still carrying its line prefixes.
 *
 * `oldStart` is null for a bare `@@`, which is the only case that is *located*
 * rather than *placed*. Counts are kept because a caller may want to report what
 * the model thought it was changing, but the applier verifies the actual lines
 * rather than trusting them — a count that disagrees with the body is a hazard,
 * not a hint.
 */
export interface PatchHunk {
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
  /** Raw body lines, each prefixed with ' ', '+' or '-'. */
  lines: string[]
}

export interface ParsedPatchFile {
  path: string
  action: PatchAction
  /** Empty for `delete`. */
  hunks: PatchHunk[]
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

const HUNK_HEADER = /^@@(?: -(\d+)(?:,(\d+))?)?(?: \+(\d+)(?:,(\d+))?)? @@/

/**
 * Strip the `a/` and `b/` prefixes a unified diff adds, and tidy a path.
 *
 * An empty path is refused; anything else is left for the workspace to contain,
 * because *this* module has no root to compare against and pretending to check
 * containment here would be a second, weaker boundary.
 */
const normalizePatchPath = (raw: string): string => {
  let value = raw.trim()
  // `diff --git a/x b/x` and the `+++ b/x` header both quote paths with spaces.
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    value = value.slice(1, -1)
  }
  // A tab separates the path from a timestamp in `diff -u` output.
  const tab = value.indexOf('\t')
  if (tab !== -1) value = value.slice(0, tab)

  if (value === '/dev/null') return value
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2)

  if (value.length === 0) {
    throw new PatchError('a patch names an empty path')
  }
  return value
}

/** True for the section headers of the `*** Begin Patch` envelope. */
const sectionAction = (line: string): { action: PatchAction; path: string } | null => {
  const update = line.match(/^\*\*\* (?:Update|Move) File: (.+)$/)
  if (update?.[1]) return { action: 'update', path: update[1] }

  const add = line.match(/^\*\*\* Add File: (.+)$/)
  if (add?.[1]) return { action: 'create', path: add[1] }

  const remove = line.match(/^\*\*\* Delete File: (.+)$/)
  if (remove?.[1]) return { action: 'delete', path: remove[1] }

  return null
}

const isEnvelopeMarker = (line: string): boolean =>
  line.startsWith('*** Begin Patch') ||
  line.startsWith('*** End Patch') ||
  line.startsWith('*** End of File') ||
  line.startsWith('*** Move to:')

const parseHunkHeader = (line: string): PatchHunk => {
  const match = line.match(HUNK_HEADER)
  if (!match) return { oldStart: null, oldCount: null, newStart: null, newCount: null, lines: [] }

  const [, oldStart, oldCount, newStart, newCount] = match
  return {
    // A bare `@@` has no numbers, so both starts stay null and the hunk is located
    // by content.
    oldStart: oldStart === undefined ? null : Number(oldStart),
    oldCount: oldCount === undefined ? null : Number(oldCount),
    newStart: newStart === undefined ? null : Number(newStart),
    newCount: newCount === undefined ? null : Number(newCount),
    lines: [],
  }
}

/**
 * Read a patch into one section per file.
 *
 * Throws on anything it cannot read rather than skipping it: a patch with a
 * malformed half must not apply its good half and report success, because the
 * model would then reason about a tree that is in neither state.
 */
export const parsePatch = (patch: string): ParsedPatchFile[] => {
  const raw = patch.replace(/\r\n/g, '\n').split('\n')

  // Trailing newline produces one empty element; a patch that is only whitespace
  // is a patch of nothing.
  if (raw.length >= 1 && raw[raw.length - 1] === '') raw.pop()

  const files: ParsedPatchFile[] = []
  let current: ParsedPatchFile | null = null
  let hunk: PatchHunk | null = null

  const flushHunk = (): void => {
    if (hunk && current) {
      current.hunks.push(hunk)
      hunk = null
    }
  }

  const flushFile = (): void => {
    flushHunk()
    if (current) files.push(current)
    current = null
  }

  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] as string

    if (isEnvelopeMarker(line)) continue

    const section = sectionAction(line)
    if (section) {
      flushFile()
      current = { path: normalizePatchPath(section.path), action: section.action, hunks: [] }
      continue
    }

    if (line.startsWith('@@')) {
      if (!current) {
        throw new PatchError(
          'the patch has a hunk before it names a file; a hunk needs a +++ or *** header first',
        )
      }
      flushHunk()
      hunk = parseHunkHeader(line)
      continue
    }

    if (line.startsWith('--- ')) {
      // A unified-diff file header. The path comes from `+++`, which is the
      // post-image: a deletion's `+++` is `/dev/null`, and that is exactly the
      // signal that decides the action.
      continue
    }

    if (line.startsWith('+++ ')) {
      const after = normalizePatchPath(line.slice(4))
      const before =
        raw[index - 1]?.startsWith('--- ')
          ? normalizePatchPath((raw[index - 1] as string).slice(4))
          : null

      flushFile()

      const action: PatchAction =
        after === '/dev/null' ? 'delete' : before === '/dev/null' ? 'create' : 'update'
      // For a deletion the `+++` is `/dev/null`, so the path has to come from
      // `---`; everywhere else the post-image names the file.
      current = {
        path: action === 'delete' && before ? before : after,
        action,
        hunks: [],
      }
      continue
    }

    if (line.startsWith('diff --git ') || line.startsWith('index ')) continue

    if (line.startsWith('\\')) continue // `\ No newline at end of file`

    if (!current) continue

    if (line.length === 0) {
      // A blank line in a hunk body is a context line whose space was trimmed by
      // the transport. Treated as one, because the alternative is refusing
      // patches that are otherwise exact.
      if (hunk) hunk.lines.push(' ')
      continue
    }

    const marker = line[0]
    if (marker !== ' ' && marker !== '+' && marker !== '-') {
      throw new PatchError(
        `the patch has a line that is neither a hunk header nor a +/- body line: ${JSON.stringify(
          line,
        )}`,
      )
    }

    if (!hunk) {
      // `*** Add File` bodies have no `@@`. Every line is an addition; anything
      // else in that position is a malformed section.
      if (current.action === 'create') {
        if (marker !== '+') {
          throw new PatchError(
            `an added file may only contain + lines, but the patch has ${JSON.stringify(line)}`,
          )
        }
        hunk = { oldStart: null, oldCount: null, newStart: null, newCount: null, lines: [] }
      } else {
        throw new PatchError(
          `the patch has body lines before any @@ header in ${current.path}`,
        )
      }
    }

    hunk.lines.push(line)
  }

  flushFile()

  if (files.length === 0) {
    throw new PatchError('the patch is empty: it names no file and has no hunks')
  }

  return files
}

/** The two sides of a hunk: what must be there, and what replaces it. */
const hunkSides = (hunk: PatchHunk): { old: string[]; next: string[] } => {
  const oldLines: string[] = []
  const nextLines: string[] = []

  for (const line of hunk.lines) {
    const marker = line[0]
    const body = line.slice(1)
    if (marker === '+') {
      nextLines.push(body)
    } else if (marker === '-') {
      oldLines.push(body)
    } else {
      oldLines.push(body)
      nextLines.push(body)
    }
  }

  return { old: oldLines, next: nextLines }
}

const matchesAt = (lines: string[], block: string[], at: number): boolean => {
  if (at < 0 || at + block.length > lines.length) return false
  for (let i = 0; i < block.length; i += 1) {
    if (lines[at + i] !== block[i]) return false
  }
  return true
}

/** Where a hunk's old block sits, or -1. Exact matches only — see the header. */
const locate = (
  lines: string[],
  block: string[],
  hunk: PatchHunk,
  cursor: number,
): number => {
  if (block.length === 0) return cursor

  if (hunk.oldStart !== null) {
    const expected = hunk.oldStart - 1
    if (matchesAt(lines, block, expected)) return expected
  }

  for (let index = cursor; index <= lines.length - block.length; index += 1) {
    if (matchesAt(lines, block, index)) return index
  }

  return -1
}

const splitLines = (text: string): { lines: string[]; trailingNewline: boolean } => {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const lines = body.length === 0 ? [] : body.split('\n')
  return { lines, trailingNewline }
}

/**
 * Apply one file's hunks to its text.
 *
 * `path` is passed only so a refusal can say which file it was about — an error
 * that names the file is the difference between a model re-reading one file and a
 * model re-reading the tree.
 *
 * Returns text with the original's trailing-newline state preserved: a hunk that
 * adds a line to a file with no final newline yields a file with no final newline.
 */
export const applyHunks = (
  original: string,
  hunks: readonly PatchHunk[],
  patchPath: string,
): { content: string; inserted: number; removed: number } => {
  const { lines, trailingNewline } = splitLines(original)
  const result = [...lines]

  let cursor = 0
  let inserted = 0
  let removed = 0

  for (const [index, hunk] of hunks.entries()) {
    const { old, next } = hunkSides(hunk)
    const at = locate(result, old, hunk, cursor)

    if (at === -1) {
      throw new PatchError(
        `hunk ${index + 1} of ${patchPath} does not match: its context lines are not ` +
          'in the file. Nothing was written. Re-read the file and patch against what it ' +
          'actually contains.',
      )
    }

    result.splice(at, old.length, ...next)
    cursor = at + next.length

    inserted += hunk.lines.filter((line) => line.startsWith('+')).length
    removed += hunk.lines.filter((line) => line.startsWith('-')).length
  }

  return {
    content: result.join('\n') + (trailingNewline ? '\n' : ''),
    inserted,
    removed,
  }
}

/** The body of a `*** Add File` section, or a unified diff that creates one. */
export const contentOfNewFile = (file: ParsedPatchFile): string => {
  const lines = file.hunks.flatMap((hunk) => hunk.lines)
  const content = lines.map((line) => {
    if (!line.startsWith('+')) {
      throw new PatchError(
        `a new file may only contain + lines, but ${file.path} has ${JSON.stringify(line)}`,
      )
    }
    return line.slice(1)
  })

  return content.length === 0 ? '' : `${content.join('\n')}\n`
}
