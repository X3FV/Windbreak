import { describe, expect, test } from 'bun:test'

import {
  CODEBASE_EMPTY_MESSAGE,
  CODEBASE_NO_TARGET_MESSAGE,
  buildCodebaseLines,
  buildCodebaseRows,
  formatCodebaseBytes,
} from '../codebase-lines'

import type {
  ReviewCodebase,
  ReviewCodebaseFile,
  ReviewFilesystemCodebase,
  ReviewInventoryCodebase,
} from '@codebuff/windbreak/review'

const file = (
  path: string,
  options: { language?: string | null; bytes?: number; binary?: boolean } = {},
): ReviewCodebaseFile => ({
  path,
  language: options.language === undefined ? 'c' : options.language,
  bytes: options.bytes ?? 100,
  binary: options.binary ?? false,
})

/** A scanned target's inventory, which is the pane's preferred source. */
const codebase = (
  files: ReviewCodebaseFile[],
  overrides: Partial<ReviewInventoryCodebase> = {},
): ReviewCodebase => ({
  source: 'inventory',
  targetId: 't1',
  location: '/home/researcher/project-a',
  commitSha: 'abc1234',
  files,
  ...overrides,
})

/** §20.31's second source: a walk of a checkout nothing has scanned. */
const walked = (
  files: ReviewCodebaseFile[],
  overrides: Partial<ReviewFilesystemCodebase> = {},
): ReviewCodebase => ({
  source: 'filesystem',
  location: '/home/researcher/unscanned',
  commitSha: null,
  truncated: false,
  files,
  ...overrides,
})

const texts = (lines: { text: string }[]): string[] => lines.map((line) => line.text)

describe('formatCodebaseBytes', () => {
  test('abbreviates at the byte and megabyte boundaries', () => {
    expect(formatCodebaseBytes(0)).toBe('0 B')
    expect(formatCodebaseBytes(1023)).toBe('1023 B')
    expect(formatCodebaseBytes(1024)).toBe('1.0k')
    expect(formatCodebaseBytes(1024 * 1024)).toBe('1.0M')
  })
})

describe('buildCodebaseRows', () => {
  test('nests files under their directories, directories first then files', () => {
    const rows = buildCodebaseRows([
      file('src/copy.c'),
      file('src/fmt.c'),
      file('README.md', { language: 'markdown' }),
      file('docs/adr/0001.md', { language: 'markdown' }),
    ])

    expect(rows.map((row) => [row.depth, row.kind, row.name])).toEqual([
      [0, 'directory', 'docs'],
      [1, 'directory', 'adr'],
      [2, 'file', '0001.md'],
      [0, 'directory', 'src'],
      [1, 'file', 'copy.c'],
      [1, 'file', 'fmt.c'],
      // A root-level file sorts after the directories, because directories come first.
      [0, 'file', 'README.md'],
    ])
  })

  test('a directory counts every file beneath it, not only its own', () => {
    const rows = buildCodebaseRows([
      file('src/copy.c'),
      file('src/deep/fmt.c'),
      file('src/deep/deeper/x.c'),
    ])

    const src = rows.find((row) => row.path === 'src')!
    expect(src.fileCount).toBe(3)
    expect(rows.find((row) => row.path === 'src/deep')!.fileCount).toBe(2)
  })

  test('intermediate directories are created for a path that names none', () => {
    // `a/b/c.c` with no `a/` or `a/b/` entry in the inventory still has to render as a
    // tree: the inventory lists files, and the directories are derived from them.
    const rows = buildCodebaseRows([file('a/b/c.c')])
    expect(rows.map((row) => row.path)).toEqual(['a', 'a/b', 'a/b/c.c'])
  })

  test('a path with no separator is a root-level file at depth zero', () => {
    const rows = buildCodebaseRows([file('Makefile', { language: null })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ path: 'Makefile', name: 'Makefile', depth: 0, kind: 'file' })
  })

  test('an empty path is skipped rather than rendered as a nameless row', () => {
    expect(buildCodebaseRows([file('')])).toEqual([])
  })
})

describe('buildCodebaseLines', () => {
  test('the header names the target, the commit, the count and the size', () => {
    const result = buildCodebaseLines(
      codebase([file('src/copy.c', { bytes: 2048 }), file('src/fmt.c', { bytes: 1024 })]),
    )

    expect(result.lines[0]!.text).toBe(
      'target: /home/researcher/project-a · 2 files · 3.0k · 1 language',
    )
    expect(result.lines[1]!.text).toBe('commit: abc1234')
    expect(result.fileCount).toBe(2)
  })

  test('a commit that is not on record is omitted, not printed as null', () => {
    // A target with no pinned revision is one the pipeline could not pin; saying
    // `commit: null` would read as a revision named "null".
    const result = buildCodebaseLines(codebase([file('src/copy.c')], { commitSha: null }))
    expect(texts(result.lines)).not.toContain('commit: null')
    expect(result.lines[0]!.text).not.toContain('commit')
  })

  test('a file row carries its language and size, and directories carry their count', () => {
    const result = buildCodebaseLines(
      codebase([file('src/copy.c', { bytes: 2048 }), file('src/fmt.c', { bytes: 512 })]),
    )

    expect(texts(result.lines)).toContain('  copy.c  c · 2.0k')
    expect(texts(result.lines)).toContain('src/  (2)')
  })

  test('a binary is marked, so a file the detectors skip is visible as one', () => {
    const result = buildCodebaseLines(
      codebase([file('bin/tool', { language: null, bytes: 4096, binary: true })]),
    )
    expect(texts(result.lines)).toContain('  tool  4.0k · binary')
  })

  test('the cap is reported, so a partial listing cannot read as a complete one', () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`src/f${index}.c`))
    const result = buildCodebaseLines(codebase(files), { maxRows: 4 })

    // The cap is on *rows*, not files: `src/` is one row and the ten files are ten
    // more, so eleven rows exist and four are shown.
    expect(result.omitted).toBe(7)
    expect(texts(result.lines).some((line) => line.includes('not shown'))).toBe(true)
    expect(result.fileCount).toBe(10)
  })

  test('a listing under the cap says nothing about a cap', () => {
    const result = buildCodebaseLines(codebase([file('src/copy.c')]), { maxRows: 500 })
    expect(result.omitted).toBe(0)
    expect(texts(result.lines).some((line) => line.includes('not shown'))).toBe(false)
  })

  test('no target on record is its own sentence, and says where a listing comes from', () => {
    // §18: "nothing was scanned" and "the repository has no files" must not print the
    // same way, and this is the first of the three states that has to differ.
    const result = buildCodebaseLines(null)

    expect(result.fileCount).toBeNull()
    expect(result.omitted).toBe(0)
    expect(result.lines[0]).toEqual({ text: CODEBASE_NO_TARGET_MESSAGE, tone: 'warning' })
    expect(texts(result.lines).join(' ')).toContain('recon')
  })

  test('an empty inventory is a statement about recon, not about the repository', () => {
    // The other state, and the one most likely to be misread: a tree with no rows looks
    // exactly like a checkout with no files.
    const result = buildCodebaseLines(codebase([]))

    expect(result.fileCount).toBe(0)
    expect(texts(result.lines)).toContain(CODEBASE_EMPTY_MESSAGE)
    expect(texts(result.lines).join(' ')).toContain('not a checkout with no files')
    // The header still names the target: the inventory is empty, the target is not.
    expect(result.lines[0]!.text).toContain('/home/researcher/project-a')
  })

  test('the target line and the rows are different tones, so the pane need not parse text', () => {
    const result = buildCodebaseLines(codebase([file('src/copy.c')]))
    const byText = new Map(result.lines.map((line) => [line.text, line.tone]))

    expect(byText.get('src/  (1)')).toBe('info')
    expect(byText.get('  copy.c  c · 100 B')).toBe('normal')
  })
})

describe('the fallback listing (§20.31)', () => {
  test('it names the root, not a target, and is labelled as unscanned', () => {
    // The mistake this prevents is a reasonable one: a file tree beside a queue reads as
    // the queue's target, and here it is not.
    const result = buildCodebaseLines(walked([file('src/copy.c')]))

    expect(result.lines[0]!.text).toContain('root: /home/researcher/unscanned')
    expect(result.lines[0]!.text).toContain('not scanned')
    expect(result.lines[0]!.text).not.toContain('target:')
    // Warned rather than muted: this header is the only thing distinguishing the two
    // listings, so it is not chrome.
    expect(result.lines[0]!.tone).toBe('warning')
  })

  test('it says outright that no finding cites what it lists', () => {
    const result = buildCodebaseLines(walked([file('src/copy.c')]))

    expect(result.lines.some((line) => line.text.includes('not recon’s inventory'))).toBe(true)
    expect(result.lines.some((line) => line.text.includes('no finding cites these files'))).toBe(
      true,
    )
  })

  test('no commit line, because a walk pinned nothing', () => {
    // A revision nobody recorded would make the listing look reproducible against one.
    const result = buildCodebaseLines(walked([file('src/copy.c')]))

    expect(texts(result.lines).some((line) => line.startsWith('commit:'))).toBe(false)
  })

  test('an empty walk is a sentence about the walk, not about recon', () => {
    const result = buildCodebaseLines(walked([]))

    expect(result.fileCount).toBe(0)
    expect(texts(result.lines).some((line) => line.includes('the walk found no files'))).toBe(true)
    // The recon sentence must not appear: nothing was indexed here.
    expect(texts(result.lines)).not.toContain(CODEBASE_EMPTY_MESSAGE)
  })

  test('the walk’s own cap is reported separately from the display cap', () => {
    // Two different ceilings: one is how much of the repository was gathered and the
    // other is how much is drawn. Reporting only the second would present a partial walk
    // as a small repository.
    const result = buildCodebaseLines(walked([file('src/copy.c')], { truncated: true }))

    expect(texts(result.lines).some((line) => line.includes('walk stopped'))).toBe(true)
  })

  test('a walk that was not capped says nothing about a cap', () => {
    const result = buildCodebaseLines(walked([file('src/copy.c')]))
    expect(texts(result.lines).some((line) => line.includes('walk stopped'))).toBe(false)
  })
})
