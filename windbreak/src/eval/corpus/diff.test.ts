import { describe, expect, test } from 'bun:test'

import { cvesInMessage, isCSourcePath, parseChangedFiles } from './diff'

describe('parseChangedFiles', () => {
  test('reads the pre-fix line range of a hunk', () => {
    const diff = [
      'diff --git a/src/a.c b/src/a.c',
      '--- a/src/a.c',
      '+++ b/src/a.c',
      '@@ -10,5 +10,6 @@ int f(void)',
      '-old',
      '+new',
    ].join('\n')

    expect(parseChangedFiles(diff)).toEqual([
      { filePath: 'src/a.c', ranges: [{ start: 10, end: 14 }] },
    ])
  })

  test('an omitted count means one line, not none', () => {
    // `@@ -7 +7 @@` is a single changed line. Reading the missing count as 0
    // would drop the hunk and the pair with it; reading it as anything else
    // would shift every later range.
    const diff = ['--- a/x.c', '+++ b/x.c', '@@ -7 +7 @@'].join('\n')
    expect(parseChangedFiles(diff)).toEqual([
      { filePath: 'x.c', ranges: [{ start: 7, end: 7 }] },
    ])
  })

  test('a pure deletion contributes no range', () => {
    // `-3,0` is a deletion: the post-fix side has nothing there to bracket a
    // function in the revision the fix produced.
    const diff = ['--- a/x.c', '+++ b/x.c', '@@ -3,0 +4,2 @@'].join('\n')
    expect(parseChangedFiles(diff)).toEqual([{ filePath: 'x.c', ranges: [] }])
  })

  test('a deleted file is not a range to attribute', () => {
    const diff = ['--- a/gone.c', '+++ /dev/null', '@@ -1,4 +0,0 @@'].join('\n')
    expect(parseChangedFiles(diff)).toEqual([])
  })

  test('several hunks in one file are kept in order', () => {
    const diff = [
      '--- a/x.c',
      '+++ b/x.c',
      '@@ -40,2 +40,3 @@',
      ' ctx',
      '-a',
      '+b',
      '+c',
      '@@ -5,1 +5,1 @@',
      '-x',
      '+y',
    ].join('\n')

    expect(parseChangedFiles(diff)[0]!.ranges).toEqual([
      { start: 5, end: 5 },
      { start: 40, end: 41 },
    ])
  })

  test('a source line that looks like a file header is not read as one', () => {
    // A line `++ foo` in the source is rendered `+++ foo` in the diff, so the
    // file list must be tracked by hunk line counts rather than by prefix.
    const diff = [
      '--- a/x.c',
      '+++ b/x.c',
      '@@ -1,1 +1,2 @@',
      '-a',
      '+++ b/decoy.c',
    ].join('\n')

    expect(parseChangedFiles(diff)).toEqual([
      { filePath: 'x.c', ranges: [{ start: 1, end: 1 }] },
    ])
  })

  test('a path git quoted is unquoted, so it can meet a candidate', () => {
    const diff = ['--- "a/sp ace.c"', '+++ "b/sp ace.c"', '@@ -1,2 +1,2 @@'].join('\n')
    expect(parseChangedFiles(diff)[0]!.filePath).toBe('sp ace.c')
  })
})

describe('cvesInMessage', () => {
  test('finds, uppercases, dedupes and sorts', () => {
    const message = 'fix CVE-2024-1234 and cve-2024-1234, also CVE-2023-999999'
    expect(cvesInMessage(message)).toEqual(['CVE-2023-999999', 'CVE-2024-1234'])
  })

  test('a message naming no CVE yields nothing rather than a guess', () => {
    // The corpus's index is the message. Inventing an id here would put a pair
    // in the corpus that no advisory backs.
    expect(cvesInMessage('fix: bounds check in the parser')).toEqual([])
  })

  test('does not match an id that is too short to be one', () => {
    expect(cvesInMessage('CVE-2024-123')).toEqual([])
  })
})

describe('isCSourcePath', () => {
  test('accepts the C family and refuses the rest', () => {
    expect(isCSourcePath('src/a.c')).toBe(true)
    expect(isCSourcePath('src/a.h')).toBe(true)
    expect(isCSourcePath('src/a.cpp')).toBe(true)
    expect(isCSourcePath('src/a.py')).toBe(false)
    expect(isCSourcePath('src/a.go')).toBe(false)
    expect(isCSourcePath('README.md')).toBe(false)
  })
})
