import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { seedState } from '../pipeline/test-support'
import { patternId } from './mine'
import { findSiblingSites } from './siblings'

import type { SeededState } from '../pipeline/test-support'
import type { MinedPattern } from './types'

const UNGUARDED = `int paste(char *dst, const char *src) {
  strcpy(dst, src);
  return 0;
}
`

const GUARDED = `int copy(char *dst, const char *src) {
  if (dst == NULL) return -1;
  if (src == NULL) return -1;
  strcpy(dst, src);
  return 0;
}
`

/** Both arguments of the call, but only one of them, is checked. */
const HALF_GUARDED = `int half(char *dst, const char *src) {
  if (dst == NULL) return -1;
  strcpy(dst, src);
  return 0;
}
`

let seeded: SeededState | null = null
let root: string | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

/** A temp checkout with the given files, so the sweep has real source to read. */
const checkout = (files: Record<string, string>): string => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-patchmine-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const pattern = (over: Partial<MinedPattern> = {}): MinedPattern => ({
  id: patternId('null-check', 'strcpy'),
  shape: 'null-check',
  originPatchSha: 'a'.repeat(40),
  originFile: 'src/unsafe.c',
  originSubject: 'fix: guard strcpy',
  subject: 'dst',
  operation: 'strcpy',
  description: '`dst` was used without a null test',
  validation: { preImageFlagged: true, postImageFlagged: false, accepted: true },
  occurrences: 1,
  ...over,
})

describe('findSiblingSites', () => {
  test('finds the unguarded function and skips the guarded one', () => {
    const targetRoot = checkout({ 'src/mix.c': UNGUARDED + '\n' + GUARDED })
    seeded = seedState({
      symbols: [
        { filePath: 'src/mix.c', name: 'paste', startLine: 1, endLine: 4 },
        { filePath: 'src/mix.c', name: 'copy', startLine: 6, endLine: 11 },
      ],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
    })

    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.functionName).toBe('paste')
    // The site is reported where the defect is, not at the enclosing function's
    // first line — the candidate's snippet is cut from this line.
    expect(result.sites[0]!.matchLine).toBe(2)
    expect(result.outcomes).toEqual([
      { patternId: pattern().id, shape: 'null-check', sites: 1, capped: false },
    ])
  })

  test('a half-guarded function is still a site, because the shape is still true', () => {
    // Not a defect in the detector: `src` really is passed to `strcpy` with no
    // null test, so the pattern's shape holds. The practical value is that an
    // *incomplete* fix — one argument guarded and the other not — surfaces as a
    // sibling rather than being read as already handled.
    const targetRoot = checkout({ 'src/half.c': HALF_GUARDED })
    seeded = seedState({
      symbols: [{ filePath: 'src/half.c', name: 'half', startLine: 1, endLine: 5 }],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
    })

    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.evidence).toContain('src')
  })

  test('the operation prefilter excludes a function that never calls it', () => {
    // This is what makes the sweep patch-mined rather than a stock linter: the
    // claim is about the *same callee* the fix was about.
    const targetRoot = checkout({ 'src/mix.c': UNGUARDED })
    seeded = seedState({
      symbols: [{ filePath: 'src/mix.c', name: 'paste', startLine: 1, endLine: 4 }],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern({ id: patternId('null-check', 'memcpy'), operation: 'memcpy' })],
    })

    expect(result.sites).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test('caps sites per pattern and says the sweep is partial', () => {
    const many = Array.from({ length: 5 }, (_, index) => `int f${index}(char *p) {\n  strcpy(p, "x");\n  return 0;\n}\n`).join('\n')
    const targetRoot = checkout({ 'src/many.c': many })
    seeded = seedState({
      symbols: Array.from({ length: 5 }, (_, index) => ({
        filePath: 'src/many.c',
        name: `f${index}`,
        startLine: index * 5 + 1,
        endLine: index * 5 + 4,
      })),
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
      maxSitesPerPattern: 2,
    })

    expect(result.sites).toHaveLength(2)
    expect(result.outcomes[0]!.capped).toBe(true)
    // A truncated sweep must not read as a complete one.
    expect(result.warnings[0]).toContain('reached the 2-site cap')
  })

  test('no indexed functions is a warning, not a silent empty result', () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seedState({})

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
    })

    expect(result.sites).toEqual([])
    expect(result.warnings[0]).toContain('No indexed functions')
    // The pattern is still accounted for, so "no sites" is attributed to the
    // missing program model rather than to the pattern finding nothing.
    expect(result.outcomes).toHaveLength(1)
    expect(result.outcomes[0]!.sites).toBe(0)
  })

  test('callables in a language with no shape tables are reported as unswept', () => {
    // A sibling sweep over a Python repository finds nothing. That must read as
    // "the tables are C's", not as "no sibling defects exist" — the same
    // distinction the missing-program-model warning above makes.
    //
    // The Python fixture is one the C `bounds-check` detector *would* fire on,
    // which is what makes the guard load-bearing: `buf[i]` is an index by an
    // identifier with no comparison, so with the language filter removed this
    // yields a site, and a benign fixture would have let the test pass with the
    // guard deleted.
    const targetRoot = checkout({
      'src/unsafe.c': UNGUARDED,
      'src/app.py': 'def get(buf, i):\n    return buf[i]\n',
    })
    seeded = seedState({
      symbols: [
        { filePath: 'src/unsafe.c', name: 'paste', startLine: 1, endLine: 4 },
        {
          filePath: 'src/app.py',
          name: 'get',
          startLine: 1,
          endLine: 2,
          language: 'python',
        },
      ],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern({ shape: 'bounds-check', operation: null })],
    })

    // Neither the C function (no index expression) nor the Python one was swept.
    expect(result.sites).toEqual([])
    expect(result.warnings.some((line) => line.includes('1 callable(s) were not swept'))).toBe(
      true,
    )
  })

  test('a method is swept like a function, because both are callables', () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seedState({
      symbols: [
        { filePath: 'src/unsafe.c', name: 'paste', startLine: 1, endLine: 4, kind: 'method' },
      ],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
    })

    expect(result.sites).toHaveLength(1)
  })

  test('a file that cannot be read is skipped rather than throwing', () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seedState({
      symbols: [
        { filePath: 'src/missing.c', name: 'gone', startLine: 1, endLine: 4 },
        { filePath: 'src/unsafe.c', name: 'paste', startLine: 1, endLine: 4 },
      ],
    })

    const result = findSiblingSites({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      patterns: [pattern()],
    })

    expect(result.sites.map((site) => site.functionName)).toEqual(['paste'])
  })
})
