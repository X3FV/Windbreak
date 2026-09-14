import { describe, expect, test } from 'bun:test'

import { halfPath, InvalidPairSetError, parsePairSet, PAIR_SET_KIND } from './pairs'

const valid = (overrides: Record<string, unknown> = {}) => ({
  kind: PAIR_SET_KIND,
  version: 1,
  description: 'test corpus',
  corpus: 'primevul-test',
  pairs: [
    {
      id: 'p-1',
      project: 'libarchive',
      cwe: 'CWE-120',
      cve: 'CVE-2024-1234',
      commitSha: 'abc1234',
      fixCommit: 'def5678',
      vulnerable: 'void f(char *s) { char b[8]; strcpy(b, s); }',
      patched: 'void f(char *s) { char b[8]; strncpy(b, s, sizeof(b) - 1); }',
      filePath: 'src/a.c',
      note: null,
    },
  ],
  ...overrides,
})

describe('parsePairSet', () => {
  test('accepts a well-formed corpus', () => {
    const set = parsePairSet(valid())
    expect(set.pairs).toHaveLength(1)
    expect(set.pairs[0]!.id).toBe('p-1')
  })

  test('normalizes what the author left out', () => {
    const set = parsePairSet({
      kind: PAIR_SET_KIND,
      version: 1,
      corpus: 'c',
      pairs: [{ id: 'p-1', project: 'p', vulnerable: 'a', patched: 'b' }],
    })
    const pair = set.pairs[0]!
    expect(pair.cwe).toBeNull()
    expect(pair.cve).toBeNull()
    expect(pair.commitSha).toBeNull()
    expect(pair.fixCommit).toBeNull()
    expect(pair.filePath).toBeNull()
    expect(pair.note).toBeNull()
  })

  test('rejects a version this build does not read', () => {
    expect(() => parsePairSet(valid({ version: 2 }))).toThrow(/version 2 is not the version/)
  })

  test('requires the kind discriminator', () => {
    const { kind, ...withoutKind } = valid()
    void kind
    expect(() => parsePairSet(withoutKind)).toThrow(InvalidPairSetError)
  })

  test('rejects an empty corpus', () => {
    expect(() => parsePairSet(valid({ pairs: [] }))).toThrow(/no pairs scores nothing/)
  })

  test('rejects a duplicate pair id', () => {
    const pair = valid().pairs[0]!
    expect(() => parsePairSet(valid({ pairs: [pair, { ...pair }] }))).toThrow(
      /pair id "p-1" appears twice/,
    )
  })

  test('rejects byte-identical halves, which cannot measure discrimination', () => {
    expect(() =>
      parsePairSet(
        valid({
          pairs: [
            {
              id: 'p-1',
              project: 'p',
              vulnerable: 'void f(void) { }',
              patched: 'void f(void) { }',
            },
          ],
        }),
      ),
    ).toThrow(/byte-identical halves/)
  })

  test('rejects an empty half', () => {
    const pair = valid().pairs[0]!
    expect(() => parsePairSet(valid({ pairs: [{ ...pair, patched: '' }] }))).toThrow(
      /patched half cannot be empty/,
    )
  })

  test('rejects a fix commit equal to the vulnerable commit', () => {
    const pair = valid().pairs[0]!
    expect(() => parsePairSet(valid({ pairs: [{ ...pair, fixCommit: 'abc1234' }] }))).toThrow(
      /which is the vulnerable commit/,
    )
  })

  test('rejects a malformed CWE and sha', () => {
    const pair = valid().pairs[0]!
    expect(() => parsePairSet(valid({ pairs: [{ ...pair, cwe: 'CWE-x' }] }))).toThrow(
      /must look like CWE-120/,
    )
    expect(() => parsePairSet(valid({ pairs: [{ ...pair, commitSha: 'nope' }] }))).toThrow(
      /must be a hex commit sha/,
    )
  })

  test('names the defect in the message, because the author is the audience', () => {
    try {
      parsePairSet(valid({ version: 9 }))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPairSetError)
      expect((error as Error).message).toContain('refused rather than repaired')
    }
  })
})

describe('halfPath', () => {
  test('uses the recorded path when the corpus has one', () => {
    const set = parsePairSet(valid())
    expect(halfPath(set.pairs[0]!)).toBe('src/a.c')
  })

  test('synthesizes one that does not imply a checkout', () => {
    const set = parsePairSet({
      kind: PAIR_SET_KIND,
      version: 1,
      corpus: 'c',
      pairs: [{ id: 'p-1', project: 'libarchive', vulnerable: 'a', patched: 'b' }],
    })
    expect(halfPath(set.pairs[0]!)).toBe('libarchive/p-1.c')
  })
})
