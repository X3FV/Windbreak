import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { parseFingerprint } from './fingerprint'
import {
  checkerIdFor,
  countUnreadableCheckers,
  insertChecker,
  libraryPatternId,
  measurePatternPrecision,
  readChecker,
  readLibrary,
  readReplays,
  recordReplay,
  retireChecker,
  updateReplayStatistics,
} from './store'
import { seedLibraryState, unboundedCopyFingerprint } from './test-support'

import type { Database } from 'bun:sqlite'
import type { Fingerprint } from './types'

let db: Database

const fingerprint = (): Fingerprint => parseFingerprint(unboundedCopyFingerprint)

const insert = (overrides: Partial<Parameters<typeof insertChecker>[0]> = {}) => {
  const fp = fingerprint()
  return insertChecker({
    db,
    patternId: libraryPatternId(fp),
    originPatchSha: 'aaaaaaaa',
    condition: 'confirmed',
    fingerprint: fp,
    findingId: 'find_cand-a1',
    candidateId: 'cand-a1',
    targetId: 'target-a',
    evidenceTier: 'human-reproduced',
    originSite: { filePath: 'src/handler.c', functionName: 'parse_header', line: 5 },
    modelId: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    promptTemplateVersion: 'windbreak-checker-synth-v1',
    preImageHits: 1,
    postImageClean: null,
    ...overrides,
  })
}

beforeEach(() => {
  db = seedLibraryState({ targets: [{ id: 'target-a' }, { id: 'target-b' }] }).db
})

afterEach(() => db.close())

describe('ids', () => {
  test('the pattern id is stable and names the class', () => {
    const id = libraryPatternId(fingerprint())

    expect(id).toMatch(/^wb-lib-c120-[0-9a-f]{8}$/)
    expect(libraryPatternId(fingerprint())).toBe(id)
  })

  test('an edited fingerprint is a different pattern and a different checker', () => {
    const edited = parseFingerprint({ ...unboundedCopyFingerprint, requireCalls: ['strcat'] })

    expect(libraryPatternId(edited)).not.toBe(libraryPatternId(fingerprint()))
    expect(checkerIdFor(libraryPatternId(edited), edited)).not.toBe(
      checkerIdFor(libraryPatternId(fingerprint()), fingerprint()),
    )
  })
})

describe('insertChecker / readChecker', () => {
  test('round-trips the entry, including the fingerprint', () => {
    const id = insert()
    const entry = readChecker(db, id)!

    expect(entry.patternId).toBe(libraryPatternId(fingerprint()))
    expect(entry.condition).toBe('confirmed')
    expect(entry.fingerprint.requireCalls).toEqual(['strcpy'])
    expect(entry.originSite).toEqual({
      filePath: 'src/handler.c',
      functionName: 'parse_header',
      line: 5,
    })
    expect(entry.evidenceTier).toBe('human-reproduced')
    expect(entry.preImageHits).toBe(1)
    expect(entry.postImageClean).toBeNull()
    expect(entry.retiredAt).toBeNull()
  })

  test('returns null for an unknown checker', () => {
    expect(readChecker(db, 'chk_nope')).toBeNull()
  })
})

describe('readLibrary', () => {
  test('lists live checkers and can include retired ones', () => {
    const id = insert()
    expect(readLibrary(db).map((entry) => entry.id)).toEqual([id])

    retireChecker(db, id)
    expect(readLibrary(db)).toEqual([])
    expect(readLibrary(db, { includeRetired: true }).map((entry) => entry.id)).toEqual([id])
  })

  test('can be restricted to one pattern id', () => {
    insert()
    expect(readLibrary(db, { patternId: 'wb-lib-c120-nope' })).toEqual([])
    expect(readLibrary(db, { patternId: libraryPatternId(fingerprint()) })).toHaveLength(1)
  })

  test('a row whose stored fingerprint no longer parses is skipped and counted', () => {
    insert()
    db.prepare('UPDATE checkers SET source = ?').run('{"kind":"function-shape"}')

    expect(readLibrary(db)).toEqual([])
    expect(countUnreadableCheckers(db)).toBe(1)
  })
})

describe('retireChecker', () => {
  test('retires once, preserving the record', () => {
    const id = insert()

    expect(retireChecker(db, id)).toBe(1)
    expect(retireChecker(db, id)).toBe(0)
    expect(readChecker(db, id)!.retiredAt).not.toBeNull()
  })
})

describe('replay history', () => {
  test('records a replayed sweep', () => {
    const id = insert()
    recordReplay({
      db,
      checkerId: id,
      targetId: 'target-b',
      revalidated: true,
      candidatesFound: 2,
      skippedReason: null,
      targetCommitSha: 'bbbbbbbb',
    })

    const replays = readReplays(db, id)
    expect(replays).toHaveLength(1)
    expect(replays[0]).toMatchObject({
      targetId: 'target-b',
      revalidated: true,
      candidatesFound: 2,
      skippedReason: null,
      targetCommitSha: 'bbbbbbbb',
    })
  })

  test('records why a skipped sweep produced nothing', () => {
    const id = insert()
    recordReplay({
      db,
      checkerId: id,
      targetId: 'target-b',
      revalidated: false,
      candidatesFound: 0,
      skippedReason: 'drifted',
      targetCommitSha: null,
    })

    expect(readReplays(db, id)[0]!.skippedReason).toBe('drifted')
    expect(readReplays(db, id)[0]!.revalidated).toBe(false)
  })

  test('deleting a checker takes its replays with it', () => {
    const id = insert()
    recordReplay({
      db,
      checkerId: id,
      targetId: 'target-b',
      revalidated: true,
      candidatesFound: 1,
      skippedReason: null,
      targetCommitSha: null,
    })

    db.prepare('DELETE FROM checkers WHERE id = ?').run(id)
    expect(readReplays(db, id)).toEqual([])
  })
})

describe('precision (§10)', () => {
  test('is null until the pattern has produced candidates', () => {
    expect(measurePatternPrecision(db, 'wb-lib-c120-x').precision).toBeNull()
  })

  test('is confirmed over produced, counted over replayed candidates only', () => {
    const patternId = libraryPatternId(fingerprint())

    const state = seedLibraryState({
      targets: [{ id: 'target-b' }],
      candidates: [
        { id: 'cand-b1', targetId: 'target-b', source: 'variant-hunt', state: 'confirmed' },
        { id: 'cand-b2', targetId: 'target-b', source: 'variant-hunt', state: 'dropped' },
        { id: 'cand-b3', targetId: 'target-b', source: 'variant-hunt', state: 'new' },
      ],
    })

    state.db
      .prepare('UPDATE candidates SET pattern_id = ?')
      .run(patternId)

    // An engine candidate with the same pattern id is not a *replayed* hit and
    // must not enter the denominator.
    state.db
      .prepare(
        `INSERT INTO candidates
           (id, run_id, source, pattern_id, file_path, start_line, end_line, cwe,
            normalized_json, state)
         VALUES ('cand-semgrep', 'run_target-b', 'semgrep', ?, 'src/x.c', 1, 1, NULL, '{}', 'confirmed')`,
      )
      .run(patternId)

    const measured = measurePatternPrecision(state.db, patternId)
    expect(measured.produced).toBe(3)
    expect(measured.confirmed).toBe(1)
    expect(measured.precision).toBeCloseTo(1 / 3)

    state.db.close()
  })
})

describe('updateReplayStatistics', () => {
  test('records what validation actually ran', () => {
    const id = insert()
    updateReplayStatistics({
      db,
      checkerId: id,
      preImageHits: 3,
      postImageClean: 1,
      precisionObserved: 0.5,
    })

    const entry = readChecker(db, id)!
    expect(entry.preImageHits).toBe(3)
    expect(entry.postImageClean).toBe(1)
    expect(entry.precisionObserved).toBe(0.5)
  })
})
