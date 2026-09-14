import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { parseFingerprint } from './fingerprint'
import { revalidateChecker } from './revalidate'
import { checkerIdFor, libraryPatternId, readChecker, insertChecker } from './store'
import { seedReplayTargets, unboundedCopyFingerprint } from './test-support'

import type { Database } from 'bun:sqlite'
import type { Fingerprint, LibraryEntry } from './types'

let db: Database

const fingerprint = (): Fingerprint => parseFingerprint(unboundedCopyFingerprint)

const store = (input: {
  targetId: string | null
  originSite: LibraryEntry['originSite']
  fingerprint?: Fingerprint
  condition?: LibraryEntry['condition']
}): LibraryEntry => {
  const fp = input.fingerprint ?? fingerprint()
  const patternId = libraryPatternId(fp)
  const id = checkerIdFor(patternId, fp)

  insertChecker({
    db,
    patternId,
    originPatchSha: 'aaaaaaaa',
    condition: input.condition ?? 'confirmed',
    fingerprint: fp,
    findingId: 'find_cand-a1',
    candidateId: 'cand-a1',
    targetId: input.targetId,
    evidenceTier: 'human-reproduced',
    originSite: input.originSite,
    modelId: null,
    provider: null,
    promptTemplateVersion: null,
    preImageHits: null,
    postImageClean: null,
  })

  return readChecker(db, id)!
}

beforeEach(() => {
  db = seedReplayTargets().db
})

afterEach(() => db.close())

describe('revalidateChecker', () => {
  test('revalidates when the pattern still catches its origin site', () => {
    const entry = store({
      targetId: 'target-a',
      originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    })

    const result = revalidateChecker({ db, checker: entry })

    expect(result.revalidated).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.preImageHits).toBe(1)
    expect(result.originSiteHit?.functionName).toBe('parse_header')
    // No post-image was supplied, so the check did not run — and says so.
    expect(result.postImageClean).toBeNull()
  })

  test('reports drift when the pattern no longer catches the recorded site', () => {
    // Same file, different function: the pattern still fires in the origin
    // target, which is exactly why drift is decided against the site and not
    // against a hit count.
    const entry = store({
      targetId: 'target-a',
      originSite: { filePath: 'src/handler.c', functionName: 'some_other_function', line: 5 },
    })

    const result = revalidateChecker({ db, checker: entry })

    expect(result.revalidated).toBe(false)
    expect(result.reason).toMatch(/no longer catches/)
    expect(result.preImageHits).toBe(1)
    expect(result.originSiteHit).toBeNull()
  })

  test('reports drift when the pattern stops matching at all', () => {
    const narrowed = parseFingerprint({ ...unboundedCopyFingerprint, requireCalls: ['gets'] })
    const entry = store({
      targetId: 'target-a',
      fingerprint: narrowed,
      originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    })

    const result = revalidateChecker({ db, checker: entry })

    expect(result.revalidated).toBe(false)
    expect(result.preImageHits).toBe(0)
  })

  test('accepts a hit in a file with no enclosing function when the site recorded none', () => {
    const fileScoped = parseFingerprint({ ...unboundedCopyFingerprint, scope: 'file' })
    const entry = store({
      targetId: 'target-a',
      fingerprint: fileScoped,
      originSite: { filePath: 'src/handler.c', functionName: null, line: 5 },
    })

    expect(revalidateChecker({ db, checker: entry }).revalidated).toBe(true)
  })

  test('refuses to replay a pattern with no origin target', () => {
    const entry = store({
      targetId: null,
      originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    })

    const result = revalidateChecker({ db, checker: entry })

    expect(result.revalidated).toBe(false)
    expect(result.reason).toMatch(/no origin target/)
  })

  test('refuses to replay a pattern with no recorded origin site', () => {
    const entry = store({ targetId: 'target-a', originSite: null })

    const result = revalidateChecker({ db, checker: entry })

    expect(result.revalidated).toBe(false)
    expect(result.reason).toMatch(/no origin site/)
  })

  test('stays silent on a post-image that already contains the fix', () => {
    const entry = store({
      targetId: 'target-a',
      originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    })

    const result = revalidateChecker({
      db,
      checker: entry,
      postImageTargetId: 'target-c',
    })

    expect(result.revalidated).toBe(true)
    expect(result.postImageClean).toBe(1)
  })

  test('refuses a pattern that still fires on the post-image', () => {
    // `target-b` is the *pre-fix* form of the second project, so pointing the
    // silence check at it must fail.
    const entry = store({
      targetId: 'target-a',
      originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    })

    const result = revalidateChecker({
      db,
      checker: entry,
      postImageTargetId: 'target-b',
    })

    expect(result.revalidated).toBe(false)
    expect(result.postImageClean).toBe(0)
    expect(result.reason).toMatch(/post-image/)
  })
})
