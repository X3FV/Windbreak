/**
 * Unified-diff parsing for patch mining (spec §4.4.1).
 *
 * The input is one `git log -p` invocation's stdout, not a single patch, because
 * the alternative is one sandboxed `git show` per commit and every spawn is a
 * fresh nsjail/bwrap launch. One spawn with a commit cap is the cheaper shape,
 * and it keeps the whole mining read deterministic in a single place.
 *
 * The output is deliberately lossy in the direction that matters: a hunk is
 * reduced to the three kinds of line a shape detector can use, and everything
 * else about the diff (rename metadata, mode changes, index lines) is dropped
 * rather than carried around unread. What is *not* dropped is a hunk's position
 * on both sides — mining reports the origin site and needs to name lines the
 * reader can find in the pre-image and the post-image respectively.
 *
 * ## The format contract
 *
 * Callers must pass the format in `LOG_FORMAT` (`--format=<it>`). Records are
 * separated by 0x1e and fields by 0x1f, chosen because git will not put either
 * into a subject: a `%s` containing a comma or a pipe would have made a
 * printable separator ambiguous, and a commit subject is attacker-controlled
 * text from the target repository.
 */

import type { CommitPatch, DiffLine, Hunk } from './types'

/** `--format` value `readCommitPatches` depends on. */
export const LOG_FORMAT = '%x1e%H%x1f%ct%x1f%s'

const RECORD_SEPARATOR = '\x1e'
const FIELD_SEPARATOR = '\x1f'
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The post-image path of a `diff --git`/`+++` header, or null for a deletion. */
const parsePostImagePath = (line: string): string | null => {
  if (!line.startsWith('+++ ')) return null

  let raw = line.slice(4).trim()
  // `+++ b/path` (git's default), and `+++ /dev/null` for a deletion.
  if (raw === '/dev/null') return null

  // Strip a leading `a/`/`b/` prefix only when it is the usual one, so a path
  // that legitimately starts with `a/` and was emitted without a prefix is not
  // mangled.
  if (raw.startsWith('b/')) raw = raw.slice(2)

  // A path with spaces arrives quoted and possibly escaped; the common case is
  // handled and anything else is taken literally rather than mis-parsed.
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    raw = raw.slice(1, -1)
  }

  return raw.length > 0 ? raw : null
}

/**
 * Parse `git log -p` output into commits with their hunks.
 *
 * A commit with no hunks is still returned: a fix commit that only touched a
 * test or a changelog is a fact the coverage counts should reflect rather than a
 * commit that silently vanishes. Filtering happens later, where the reason can be
 * recorded.
 */
export const parseCommitPatches = (stdout: string): CommitPatch[] => {
  const commits: CommitPatch[] = []

  for (const chunk of stdout.split(RECORD_SEPARATOR)) {
    // The first record is whatever preceded the first separator — normally empty,
    // since `--format` starts each commit with `%x1e`. Anything else is a partial
    // chunk from a truncated read and is skipped rather than guessed at.
    if (chunk.length === 0) continue

    const newlineAt = chunk.indexOf('\n')
    const headerLine = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt)
    const body = newlineAt === -1 ? '' : chunk.slice(newlineAt + 1)

    const [sha, committedAt, ...subjectParts] = headerLine.split(FIELD_SEPARATOR)
    if (!sha || !committedAt) continue

    const seconds = Number.parseInt(committedAt, 10)
    commits.push({
      sha,
      committedAt: Number.isFinite(seconds) ? seconds : 0,
      // A subject cannot contain 0x1f, but it can contain the field separator's
      // absence — rejoin rather than take the first part.
      subject: subjectParts.join(FIELD_SEPARATOR),
      hunks: parseHunks(body),
    })
  }

  return commits
}

/** Walk a patch body, emitting hunks. Exported for the tests that need one. */
export const parseHunks = (body: string): Hunk[] => {
  const hunks: Hunk[] = []
  let currentFile: string | null = null
  let current: Hunk | null = null
  let oldLine = 0
  let newLine = 0

  const close = (): void => {
    if (current) hunks.push(current)
    current = null
  }

  for (const raw of body.split('\n')) {
    // `diff --git a/x b/x` opens a file section and can only appear between
    // hunks — as a content line it would carry its own ` `/`+`/`-` marker and so
    // cannot reach this branch.
    if (raw.startsWith('diff --git ')) {
      close()
      currentFile = null
      continue
    }

    // The file-metadata block is read **only with no hunk open**, and that guard
    // is load-bearing rather than defensive. An added line whose text begins
    // `++ ` is emitted as `+++ …`, and a removed line beginning `-- ` as `--- …`
    // — both are real source lines that a naive `startsWith` reads as headers,
    // silently swallowing the very line a shape detector was looking for.
    if (current === null) {
      if (raw.startsWith('+++ ')) {
        // A path applies to the hunks that follow it; a deletion (`/dev/null`)
        // leaves `currentFile` null so its hunks are dropped.
        currentFile = parsePostImagePath(raw)
        continue
      }

      if (raw.startsWith('--- ') || raw.startsWith('index ') ||
          raw.startsWith('new file') || raw.startsWith('deleted file') ||
          raw.startsWith('old mode') || raw.startsWith('new mode') ||
          raw.startsWith('similarity index') || raw.startsWith('rename ') ||
          raw.startsWith('copy ') || raw.startsWith('Binary files ') ||
          raw.startsWith('GIT binary patch')) {
        continue
      }
    }

    const header = HUNK_HEADER.exec(raw)
    if (header) {
      close()
      if (currentFile === null) continue

      oldLine = Number.parseInt(header[1]!, 10)
      newLine = Number.parseInt(header[3]!, 10)
      current = {
        filePath: currentFile,
        oldStart: oldLine,
        oldCount: Number.parseInt(header[2] ?? '1', 10),
        newStart: newLine,
        newCount: Number.parseInt(header[4] ?? '1', 10),
        lines: [],
      }
      continue
    }

    if (current === null) continue

    const marker = raw[0]
    const text = raw.slice(1)

    if (marker === ' ') {
      current.lines.push({ kind: 'context', text, oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (marker === '+') {
      current.lines.push({ kind: 'added', text, oldLine: null, newLine })
      newLine += 1
    } else if (marker === '-') {
      current.lines.push({ kind: 'removed', text, oldLine, newLine: null })
      oldLine += 1
    }
    // `\ No newline at end of file` and any other marker are ignored: they carry
    // no source text a detector could match.
  }

  close()
  return hunks
}

/** The pre-image text of a hunk: context and removed lines, in order. */
export const preImage = (hunk: Hunk): string[] =>
  hunk.lines
    .filter((line) => line.kind !== 'added')
    .map((line) => line.text)

/** The post-image text of a hunk: context and added lines, in order. */
export const postImage = (hunk: Hunk): string[] =>
  hunk.lines
    .filter((line) => line.kind !== 'removed')
    .map((line) => line.text)

/** Added lines only, with their post-image line numbers. */
export const addedLines = (hunk: Hunk): DiffLine[] =>
  hunk.lines.filter((line) => line.kind === 'added')

/** Removed lines only, with their pre-image line numbers. */
export const removedLines = (hunk: Hunk): DiffLine[] =>
  hunk.lines.filter((line) => line.kind === 'removed')
