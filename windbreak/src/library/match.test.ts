import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { parseFingerprint } from './fingerprint'
import { matchFingerprint } from './match'
import { seedLibraryState, unboundedCopyFingerprint } from './test-support'

import type { Database } from 'bun:sqlite'
import type { Fingerprint } from './types'

let db: Database

const fingerprint = (overrides: Partial<Fingerprint> = {}): Fingerprint =>
  parseFingerprint({ ...unboundedCopyFingerprint, ...overrides })

beforeEach(() => {
  const state = seedLibraryState({
    targets: [
      {
        id: 'target-a',
        functions: [
          { filePath: 'src/a.c', name: 'vulnerable', startLine: 1, endLine: 6 },
          { filePath: 'src/a.c', name: 'guarded', startLine: 10, endLine: 15 },
          { filePath: 'src/a.c', name: 'nested_outer', startLine: 20, endLine: 40 },
          { filePath: 'src/a.c', name: 'nested_inner', startLine: 25, endLine: 30 },
        ],
        refs: [
          { filePath: 'src/a.c', name: 'strcpy', line: 3 },
          { filePath: 'src/a.c', name: 'strlen', line: 4 },
          { filePath: 'src/a.c', name: 'strcpy', line: 12 },
          { filePath: 'src/a.c', name: 'strncpy', line: 13 },
          { filePath: 'src/a.c', name: 'strcpy', line: 27 },
          { filePath: 'src/a.c', name: 'read', line: 28 },
          { filePath: 'src/a.c', name: 'strcpy', line: 50 },
        ],
      },
    ],
  })
  db = state.db
})

afterEach(() => db.close())

describe('matchFingerprint (function scope)', () => {
  test('matches the site where the required call is present and guards are not', () => {
    const hits = matchFingerprint({ db, targetId: 'target-a', fingerprint: fingerprint() })

    // Ordered by file then line, so `vulnerable` (line 3) precedes `nested_inner`.
    expect(hits.map((hit) => hit.functionName)).toEqual(['vulnerable', 'nested_inner'])
  })

  test('does not match a function that already uses the bounded copy', () => {
    const hits = matchFingerprint({ db, targetId: 'target-a', fingerprint: fingerprint() })

    expect(hits.map((hit) => hit.functionName)).not.toContain('guarded')
  })

  test('ignores calls that fall outside any recorded function', () => {
    // `strcpy` at line 50 belongs to no function in the index; a function-scoped
    // pattern cannot attribute it to one, and guessing would blame the nearest
    // function above it.
    const hits = matchFingerprint({ db, targetId: 'target-a', fingerprint: fingerprint() })

    expect(hits.map((hit) => hit.line)).not.toContain(50)
  })

  test('attributes a nested call to the innermost function', () => {
    const hits = matchFingerprint({ db, targetId: 'target-a', fingerprint: fingerprint() })

    const nested = hits.find((hit) => hit.line === 27)
    expect(nested?.functionName).toBe('nested_inner')
  })

  test('anchors on the required call and reports the observed vocabulary', () => {
    const hits = matchFingerprint({ db, targetId: 'target-a', fingerprint: fingerprint() })
    const vulnerable = hits.find((hit) => hit.functionName === 'vulnerable')!

    expect(vulnerable.line).toBe(3)
    expect(vulnerable.matchedOn).toBe('strcpy')
    expect(vulnerable.observedCalls).toEqual(['strcpy', 'strlen'])
  })

  test('returns nothing when the required call is absent', () => {
    expect(
      matchFingerprint({
        db,
        targetId: 'target-a',
        fingerprint: fingerprint({ requireCalls: ['gets'] }),
      }),
    ).toEqual([])
  })
})

describe('matchFingerprint (predicates)', () => {
  test('requireAnyCalls matches a function with any one of them', () => {
    const hits = matchFingerprint({
      db,
      targetId: 'target-a',
      fingerprint: fingerprint({
        requireCalls: [],
        forbidCalls: [],
        requireAnyCalls: ['strncpy', 'strcpy'],
      }),
    })

    expect(hits.length).toBeGreaterThan(0)
  })

  test('order holds only when the two calls are in line order', () => {
    const ordered = matchFingerprint({
      db,
      targetId: 'target-a',
      fingerprint: fingerprint({ order: [{ before: 'strcpy', after: 'strlen' }] }),
    })
    expect(ordered.map((hit) => hit.functionName)).toContain('vulnerable')

    const reversed = matchFingerprint({
      db,
      targetId: 'target-a',
      fingerprint: fingerprint({ order: [{ before: 'strlen', after: 'strcpy' }] }),
    })
    expect(reversed.map((hit) => hit.functionName)).not.toContain('vulnerable')
  })

  test('an ordering pair needs both calls present', () => {
    expect(
      matchFingerprint({
        db,
        targetId: 'target-a',
        fingerprint: fingerprint({ order: [{ before: 'strcpy', after: 'socket' }] }),
      }),
    ).toEqual([])
  })

  test('the language filter excludes files the pattern does not apply to', () => {
    expect(
      matchFingerprint({
        db,
        targetId: 'target-a',
        fingerprint: fingerprint({ languages: ['c'] }),
      }).length,
    ).toBeGreaterThan(0)

    const none = seedLibraryState({
      targets: [
        {
          id: 'other',
          language: 'cpp',
          files: [{ path: 'src/a.c', language: 'cpp' }],
          functions: [{ filePath: 'src/a.c', name: 'f', startLine: 1, endLine: 5 }],
          refs: [{ filePath: 'src/a.c', name: 'strcpy', line: 2 }],
        },
      ],
    })

    expect(
      matchFingerprint({
        db: none.db,
        targetId: 'other',
        fingerprint: fingerprint({ languages: ['c'] }),
      }),
    ).toEqual([])
    none.db.close()
  })
})

describe('matchFingerprint (file scope)', () => {
  test('groups by file and reports no enclosing function', () => {
    const scoped = seedLibraryState({
      targets: [
        {
          id: 'flat',
          files: [
            { path: 'src/hit.c', language: 'c' },
            { path: 'src/clean.c', language: 'c' },
          ],
          refs: [
            { filePath: 'src/hit.c', name: 'strcpy', line: 3 },
            { filePath: 'src/hit.c', name: 'strlen', line: 4 },
            { filePath: 'src/clean.c', name: 'strcpy', line: 3 },
            { filePath: 'src/clean.c', name: 'strncpy', line: 4 },
          ],
        },
      ],
    })

    const hits = matchFingerprint({
      db: scoped.db,
      targetId: 'flat',
      fingerprint: fingerprint({ scope: 'file' }),
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]!.functionName).toBeNull()
    expect(hits[0]!.filePath).toBe('src/hit.c')
    scoped.db.close()
  })

  test('file scope spans functions, so a guard anywhere in the file refuses it', () => {
    // The guarded copy lives in the same file as the vulnerable one. A
    // file-scoped pattern therefore sees `strncpy` and does not match — the
    // honest answer for that scope, and the reason function scope is preferred.
    const hits = matchFingerprint({
      db,
      targetId: 'target-a',
      fingerprint: fingerprint({ scope: 'file' }),
    })

    expect(hits).toEqual([])
  })
})

describe('matchFingerprint (empty targets)', () => {
  test('a target with no program model produces no hits, not an error', () => {
    const empty = seedLibraryState({ targets: [{ id: 'bare' }] })

    expect(
      matchFingerprint({ db: empty.db, targetId: 'bare', fingerprint: fingerprint() }),
    ).toEqual([])
    empty.db.close()
  })
})
