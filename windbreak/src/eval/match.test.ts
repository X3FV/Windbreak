import { describe, expect, test } from 'bun:test'

import { matchCandidate, normalizeRepoPath, pathsCorrespond, rangesOverlap } from './match'

import type { Fixture, FixtureBug, FixtureSite } from './types'

const site = (
  filePath: string,
  startLine: number | null = null,
  endLine: number | null = startLine,
): FixtureSite => ({ filePath, startLine, endLine, functionName: null })

const bug = (id: string, ...sites: FixtureSite[]): FixtureBug => ({
  id,
  cwe: null,
  cve: null,
  files: sites,
  fixCommit: null,
  note: null,
})

const fixture = (...bugs: FixtureBug[]): Fixture => ({
  id: 'fx-1',
  project: 'p',
  commitSha: 'abc1234',
  note: null,
  bugs,
})

describe('normalizeRepoPath', () => {
  test('collapses separators and leading markers', () => {
    expect(normalizeRepoPath('./src\\a.c')).toBe('src/a.c')
    expect(normalizeRepoPath('/src//a.c')).toBe('/src/a.c')
    expect(normalizeRepoPath('  src/a.c  ')).toBe('src/a.c')
  })
})

describe('pathsCorrespond', () => {
  test('matches on a segment boundary only', () => {
    expect(pathsCorrespond('/sandbox/target/src/a.c', 'src/a.c')).toBe(true)
    // `nota.c` ends with `a.c` but not with `/a.c`, so it is a different file.
    expect(pathsCorrespond('nota.c', 'a.c')).toBe(false)
  })

  test('is symmetric, deliberately', () => {
    expect(pathsCorrespond('src/a.c', 'src/a.c')).toBe(true)
    // A bare `a.c` corresponds to `src/a.c`: neither side knows the root, so the
    // relation cannot be directional. Narrowing the ambiguity is `candidateSites`'
    // job, not this one's.
    expect(pathsCorrespond('a.c', 'src/a.c')).toBe(true)
  })
})

describe('rangesOverlap', () => {
  test('treats a shared endpoint as overlap', () => {
    expect(rangesOverlap({ start: 10, end: 20 }, { start: 20, end: 30 })).toBe(true)
    expect(rangesOverlap({ start: 10, end: 19 }, { start: 20, end: 30 })).toBe(false)
  })
})

describe('matchCandidate', () => {
  test('matches on an overlapping range', () => {
    const truth = matchCandidate(
      { filePath: 'src/a.c', startLine: 15, endLine: 18 },
      fixture(bug('bug-1', site('src/a.c', 10, 20))),
    )
    expect(truth.kind).toBe('matched')
    if (truth.kind === 'matched') {
      expect(truth.basis).toBe('range')
      expect(truth.bugs.map((entry) => entry.id)).toEqual(['bug-1'])
    }
  })

  test('does not match a range in the same file that misses the site', () => {
    const truth = matchCandidate(
      { filePath: 'src/a.c', startLine: 100, endLine: 110 },
      fixture(bug('bug-1', site('src/a.c', 10, 20))),
    )
    expect(truth.kind).toBe('unmatched')
  })

  test('falls back to file-level matching, and says so', () => {
    const truth = matchCandidate(
      { filePath: 'src/a.c', startLine: null, endLine: null },
      fixture(bug('bug-1', site('src/a.c', 10, 20))),
    )
    expect(truth.kind).toBe('matched')
    if (truth.kind === 'matched') expect(truth.basis).toBe('file')
  })

  test('file-level matching also applies when the site has no lines', () => {
    const truth = matchCandidate(
      { filePath: 'src/a.c', startLine: 3, endLine: 4 },
      fixture(bug('bug-1', site('src/a.c'))),
    )
    expect(truth.kind).toBe('matched')
    if (truth.kind === 'matched') expect(truth.basis).toBe('file')
  })

  test('is unscorable without a path, rather than a false positive', () => {
    const truth = matchCandidate(
      { filePath: null, startLine: 1, endLine: 2 },
      fixture(bug('bug-1', site('src/a.c'))),
    )
    expect(truth.kind).toBe('unscorable')
    if (truth.kind === 'unscorable') expect(truth.reason).toContain('no file path')
  })

  test('corresponds a sandbox-absolute candidate path to a relative site', () => {
    const truth = matchCandidate(
      { filePath: '/tmp/sbx/target/src/a.c', startLine: 12, endLine: 12 },
      fixture(bug('bug-1', site('src/a.c', 10, 20))),
    )
    expect(truth.kind).toBe('matched')
  })

  test('prefers the most specific correspondence over a shallower one', () => {
    // `lib/a.c` and `a.c` both end the candidate path, so without the
    // most-specific rule this candidate would also be credited to a bug in the
    // parent directory — recall bought with a false match.
    const truth = matchCandidate(
      { filePath: '/sbx/lib/a.c', startLine: 5, endLine: 5 },
      fixture(
        bug('bug-lib', site('lib/a.c', 1, 9)),
        bug('bug-parent', site('a.c', 1, 9)),
      ),
    )
    expect(truth.kind).toBe('matched')
    if (truth.kind === 'matched') expect(truth.bugs.map((entry) => entry.id)).toEqual(['bug-lib'])
  })

  test('reports every bug a candidate covers, deduped by id', () => {
    const truth = matchCandidate(
      { filePath: 'src/a.c', startLine: 12, endLine: 12 },
      fixture(
        // Two sites of one bug are one finding.
        bug('bug-1', site('src/a.c', 10, 20), site('src/a.c', 30, 40)),
        bug('bug-2', site('src/a.c', 11, 13)),
      ),
    )
    expect(truth.kind).toBe('matched')
    if (truth.kind === 'matched') expect(truth.bugs.map((entry) => entry.id)).toEqual(['bug-1', 'bug-2'])
  })

  test('is unmatched in a file the fixture seeds nothing in', () => {
    const truth = matchCandidate(
      { filePath: 'src/elsewhere.c', startLine: 1, endLine: 2 },
      fixture(bug('bug-1', site('src/a.c', 1, 2))),
    )
    expect(truth.kind).toBe('unmatched')
  })
})
