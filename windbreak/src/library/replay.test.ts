import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { persistCandidates } from '../engines'
import { parseFingerprint } from './fingerprint'
import { refreshPatternPrecision, runVariantHunt } from './replay'
import { checkerIdFor, insertChecker, libraryPatternId, readChecker, readReplays } from './store'
import { seedReplayTargets, unboundedCopyFingerprint } from './test-support'

import type { Database } from 'bun:sqlite'
import type { Fingerprint, LibraryEntry } from './types'

let db: Database
let targetRoot: string

/**
 * Line numbers must agree with the program model in `test-support`, or the
 * snippet extraction and the match anchor would be describing different code.
 */
const SOURCES: Record<string, string> = {
  'src/parse.c': [
    '#include <string.h>', // 1
    '#include <stdio.h>',
    '',
    '/* src/parse.c */',
    '',
    '',
    '',
    '',
    '',
    'void read_name(const char *line) {', // 10
    '  char name[64];',
    '  strcpy(name, line);', // 12
    '  return (int)strlen(name);', // 13
    '}',
    '',
    '',
    '',
    '',
    '',
    'void safe_copy(const char *line) {', // 20
    '  char name[64];',
    '  strncpy(name, line, sizeof(name) - 1);', // 22
    '  snprintf(name + 63, 1, "");', // 23
    '}',
  ].join('\n'),
  'src/copies.c': [
    'void copy_a(const char *s) {', // 1
    '  char buf[8];',
    '  strcpy(buf, s);', // 3 — the model anchors on line 2
    '}',
    '',
    'void copy_b(const char *s) {', // 6
    '  char buf[8];',
    '  strcpy(buf, s);', // 7
    '}',
    '',
    'void copy_c(const char *s) {', // 11
    '  char buf[8];',
    '  strcpy(buf, s);', // 12
    '}',
  ].join('\n'),
}

const fingerprint = (overrides: Partial<Fingerprint> = {}): Fingerprint =>
  parseFingerprint({ ...unboundedCopyFingerprint, ...overrides })

const store = (input: {
  targetId: string
  originSite: LibraryEntry['originSite']
  fingerprint?: Fingerprint
  condition?: LibraryEntry['condition']
  evidenceTier?: string | null
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
    evidenceTier: input.evidenceTier === undefined ? 'human-reproduced' : input.evidenceTier,
    originSite: input.originSite,
    modelId: null,
    provider: null,
    promptTemplateVersion: null,
    preImageHits: 1,
    postImageClean: null,
  })

  return readChecker(db, id)!
}

const ORIGIN_SITE = {
  filePath: 'src/handler.c',
  functionName: 'parse_header',
  line: 5,
}

beforeEach(() => {
  targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-lib-'))
  for (const [file, contents] of Object.entries(SOURCES)) {
    fs.mkdirSync(path.dirname(path.join(targetRoot, file)), { recursive: true })
    fs.writeFileSync(path.join(targetRoot, file), contents)
  }

  const state = seedReplayTargets({ withVariants: true })
  db = state.db
})

afterEach(() => {
  db.close()
  fs.rmSync(targetRoot, { recursive: true, force: true })
})

const hunt = (overrides: Record<string, unknown> = {}) =>
  runVariantHunt({
    db,
    targetId: 'target-b',
    targetRoot,
    runId: 'run_target-b',
    targetCommitSha: 'bbbbbbbb',
    now: () => 1_700_000_000_000,
    ...overrides,
  })

describe('runVariantHunt', () => {
  test('replays a confirmed pattern and produces variant-hunt candidates', () => {
    const entry = store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt()

    expect(result.checkersConsidered).toBe(1)
    expect(result.outcomes).toEqual([
      {
        checkerId: entry.id,
        patternId: entry.patternId,
        revalidated: true,
        skippedReason: null,
        candidatesFound: 1,
      },
    ])

    const candidate = result.candidates[0]!
    expect(candidate.source).toBe('variant-hunt')
    expect(candidate.patternId).toBe(entry.patternId)
    expect(candidate.originPatchSha).toBe('aaaaaaaa')
    expect(candidate.cwe).toBe('CWE-120')
    expect(candidate.state).toBe('new')
    expect(candidate.filePath).toBe('src/parse.c')
    expect(candidate.startLine).toBe(12)
    // The snippet comes from the replayed target, not the origin one.
    expect(candidate.normalized.snippet).toContain('strcpy(name, line)')
    expect(candidate.normalized.message).toContain('unbounded copy')
  })

  test('does not report a site that already uses a bounded copy', () => {
    store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt()

    expect(result.candidates.map((candidate) => candidate.startLine)).not.toContain(22)
  })

  test('refuses an unconfirmed pattern and says which gate failed', () => {
    const entry = store({
      targetId: 'target-a',
      originSite: ORIGIN_SITE,
      condition: 'unconfirmed',
      evidenceTier: 'statically-verified',
    })

    const result = hunt()

    expect(result.candidates).toEqual([])
    expect(result.outcomes[0]!.revalidated).toBe(false)
    expect(result.outcomes[0]!.skippedReason).toContain('statically-verified')
    expect(result.outcomes[0]!.skippedReason).toContain('--allow-statically-verified')
    expect(readReplays(db, entry.id)[0]!.skippedReason).toContain('statically-verified')
  })

  test('replays an unconfirmed pattern when the researcher opts in', () => {
    store({
      targetId: 'target-a',
      originSite: ORIGIN_SITE,
      condition: 'unconfirmed',
      evidenceTier: 'statically-verified',
    })

    const result = hunt({ allowStaticallyVerified: true })

    expect(result.outcomes[0]!.revalidated).toBe(true)
    expect(result.candidates).toHaveLength(1)
  })

  test('skips a drifted pattern and records why, producing nothing', () => {
    const entry = store({
      targetId: 'target-a',
      originSite: { ...ORIGIN_SITE, functionName: 'renamed_function' },
    })

    const result = hunt()

    expect(result.candidates).toEqual([])
    expect(result.outcomes[0]!.revalidated).toBe(false)
    expect(result.outcomes[0]!.skippedReason).toMatch(/no longer catches/)
    expect(readReplays(db, entry.id)[0]!.revalidated).toBe(false)
    // The pattern still fires once *somewhere* in the origin target — which is
    // exactly why drift is decided against the recorded site and not a count.
    expect(readChecker(db, entry.id)!.preImageHits).toBe(1)
  })

  test('ignores a retired pattern', () => {
    const entry = store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    db.prepare('UPDATE checkers SET retired_at = ? WHERE id = ?').run('2026-01-01', entry.id)

    const result = hunt()

    expect(result.checkersConsidered).toBe(0)
    expect(result.candidates).toEqual([])
  })

  test('warns instead of failing when the library is empty', () => {
    const result = hunt()

    expect(result.warnings.join(' ')).toContain('empty')
    expect(result.candidates).toEqual([])
  })

  test('restricts the sweep to one pattern', () => {
    store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt({ patternId: 'wb-lib-c120-nope' })

    expect(result.checkersConsidered).toBe(0)
    expect(result.warnings.join(' ')).toContain('no live library entry')
  })

  test('caps a broad pattern and warns that it is broader than its bug', () => {
    // `target-d` copied the same bug into three functions.
    const narrow = fingerprint()
    store({ targetId: 'target-a', originSite: ORIGIN_SITE, fingerprint: narrow })

    const result = hunt({ targetId: 'target-d', maxCandidatesPerPattern: 1 })

    expect(result.candidates).toHaveLength(1)
    expect(result.outcomes[0]!.candidatesFound).toBe(1)
    expect(result.warnings.join(' ')).toContain('broader than the bug')
    expect(result.warnings.join(' ')).toContain('3 site(s)')
  })

  test('refuses every pattern when a post-image still matches', () => {
    store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt({ postImageTargetId: 'target-b' })

    expect(result.candidates).toEqual([])
    expect(result.outcomes[0]!.skippedReason).toMatch(/post-image/)
  })
})

describe('candidate persistence (§14.1)', () => {
  test('writes origin_patch_sha for replayed candidates', () => {
    store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt()

    const persisted = persistCandidates({
      db,
      runId: 'run_target-b',
      candidates: result.candidates,
    })

    expect(persisted.inserted).toBe(1)
    expect(persisted.bySource).toEqual({ 'variant-hunt': 1 })

    const row = db
      .query<{ origin_patch_sha: string; source: string; pattern_id: string }, [string]>(
        'SELECT origin_patch_sha, source, pattern_id FROM candidates WHERE source = ?',
      )
      .get('variant-hunt')!

    expect(row.origin_patch_sha).toBe('aaaaaaaa')
    expect(row.source).toBe('variant-hunt')
    expect(row.pattern_id).toStartWith('wb-lib-c120-')
  })
})

describe('refreshPatternPrecision (§10)', () => {
  test('records null before any candidate is persisted, then a measured ratio', () => {
    const entry = store({ targetId: 'target-a', originSite: ORIGIN_SITE })
    const result = hunt()

    expect(refreshPatternPrecision({ db, patternIds: [entry.patternId] })).toEqual({
      [entry.patternId]: null,
    })

    persistCandidates({ db, runId: 'run_target-b', candidates: result.candidates })

    expect(refreshPatternPrecision({ db, patternIds: [entry.patternId] })).toEqual({
      [entry.patternId]: 0,
    })
    expect(readChecker(db, entry.id)!.precisionObserved).toBe(0)
  })
})
