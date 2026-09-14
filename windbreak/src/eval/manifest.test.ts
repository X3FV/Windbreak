import { describe, expect, test } from 'bun:test'

import { InvalidFixtureSetError, parseFixtureSet } from './manifest'

/** A valid set, so each case can vary exactly one thing. */
const valid = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  description: 'test set',
  fixtures: [
    {
      id: 'fx-1',
      project: 'libarchive',
      commitSha: 'abc1234',
      note: null,
      bugs: [
        {
          id: 'bug-1',
          cwe: 'CWE-120',
          cve: 'CVE-2024-1234',
          files: [{ filePath: 'src/archive.c', startLine: 10, endLine: 20, functionName: null }],
          fixCommit: 'def5678',
          note: null,
        },
      ],
    },
  ],
  ...overrides,
})

describe('parseFixtureSet', () => {
  test('accepts a well-formed set', () => {
    const set = parseFixtureSet(valid())
    expect(set.fixtures).toHaveLength(1)
    expect(set.fixtures[0]!.bugs[0]!.id).toBe('bug-1')
  })

  test('normalizes a site path to the form candidates are compared in', () => {
    const set = parseFixtureSet(
      valid({
        fixtures: [
          {
            id: 'fx-1',
            project: 'p',
            commitSha: 'abc1234',
            bugs: [
              {
                id: 'bug-1',
                cwe: null,
                cve: null,
                files: [
                  { filePath: './src/archive.c', startLine: 1, endLine: 2, functionName: null },
                  { filePath: '/src/string.c', startLine: 1, endLine: 2, functionName: null },
                ],
                fixCommit: null,
                note: null,
              },
            ],
          },
        ],
      }),
    )
    expect(set.fixtures[0]!.bugs[0]!.files.map((file) => file.filePath)).toEqual([
      'src/archive.c',
      'src/string.c',
    ])
  })

  test('accepts a minimal entry, normalizing what the author left out', () => {
    const set = parseFixtureSet({
      version: 1,
      fixtures: [
        {
          id: 'fx-1',
          project: 'p',
          commitSha: 'abc1234',
          bugs: [{ id: 'bug-1', files: [{ filePath: 'src/a.c' }] }],
        },
      ],
    })

    const bug = set.fixtures[0]!.bugs[0]!
    expect(bug.cwe).toBeNull()
    expect(bug.cve).toBeNull()
    expect(bug.fixCommit).toBeNull()
    expect(bug.note).toBeNull()
    // No line range means the whole file, which is the documented semantics.
    expect(bug.files[0]!.startLine).toBeNull()
    expect(bug.files[0]!.endLine).toBeNull()
    expect(set.fixtures[0]!.note).toBeNull()
  })

  test('still refuses a misspelled key on a minimal entry', () => {
    // The ergonomics above must not soften the strictness that catches this.
    expect(() =>
      parseFixtureSet({
        version: 1,
        fixtures: [
          {
            id: 'fx-1',
            project: 'p',
            commitSha: 'abc1234',
            bugs: [{ id: 'bug-1', files: [{ filePath: 'src/a.c', startline: 10 }] }],
          },
        ],
      }),
    ).toThrow(/Unrecognized key/)
  })

  test('carries a fixture annotation through', () => {
    const set = parseFixtureSet(
      valid({
        fixtures: [
          {
            id: 'fx-clean',
            project: 'p',
            commitSha: 'abc1234',
            bugs: [],
            note: 'negative control: this revision has no known bug',
          },
        ],
      }),
    )
    expect(set.fixtures[0]!.note).toBe('negative control: this revision has no known bug')
  })

  test('accepts a fixture that seeds no bugs, as a negative control', () => {
    const set = parseFixtureSet(
      valid({
        fixtures: [{ id: 'fx-clean', project: 'p', commitSha: 'abc1234', bugs: [] }],
      }),
    )
    expect(set.fixtures[0]!.bugs).toHaveLength(0)
  })

  test('rejects an unknown field rather than ignoring it', () => {
    expect(() =>
      parseFixtureSet(valid({ fixtures: [{ id: 'fx-1', project: 'p', commitSha: 'abc1234', bugs: [], snapshotPath: '/x' }] })),
    ).toThrow(InvalidFixtureSetError)
  })

  test('rejects a version this build does not read', () => {
    expect(() => parseFixtureSet(valid({ version: 2 }))).toThrow(/version 2 is not the version/)
  })

  test('rejects an empty fixture list', () => {
    expect(() => parseFixtureSet(valid({ fixtures: [] }))).toThrow(InvalidFixtureSetError)
  })

  test('rejects a duplicate fixture id', () => {
    const fixture = { id: 'fx-1', project: 'p', commitSha: 'abc1234', bugs: [] }
    expect(() =>
      parseFixtureSet(valid({ fixtures: [fixture, { ...fixture, project: 'other' }] })),
    ).toThrow(/fixture id "fx-1" appears twice/)
  })

  test('rejects two fixtures on the same commit of the same project', () => {
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            { id: 'a', project: 'p', commitSha: 'abc1234', bugs: [] },
            { id: 'b', project: 'p', commitSha: 'abc1234', bugs: [] },
          ],
        }),
      ),
    ).toThrow(/one run would be scored against both, doubling the bug count/)
  })

  test('allows the same commit under two different projects', () => {
    const set = parseFixtureSet(
      valid({
        fixtures: [
          { id: 'a', project: 'p', commitSha: 'abc1234', bugs: [] },
          { id: 'b', project: 'q', commitSha: 'abc1234', bugs: [] },
        ],
      }),
    )
    expect(set.fixtures).toHaveLength(2)
  })

  test('rejects a duplicate bug id inside one fixture', () => {
    const bug = {
      id: 'bug-1',
      cwe: null,
      cve: null,
      files: [{ filePath: 'src/a.c', startLine: null, endLine: null, functionName: null }],
      fixCommit: null,
      note: null,
    }
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [{ id: 'fx-1', project: 'p', commitSha: 'abc1234', bugs: [bug, { ...bug }] }],
        }),
      ),
    ).toThrow(/bug id "bug-1" appears twice/)
  })

  test('rejects a bug with no site', () => {
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            {
              id: 'fx-1',
              project: 'p',
              commitSha: 'abc1234',
              bugs: [{ id: 'bug-1', cwe: null, cve: null, files: [], fixCommit: null, note: null }],
            },
          ],
        }),
      ),
    ).toThrow(/at least one site/)
  })

  test('rejects an endLine with no startLine', () => {
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            {
              id: 'fx-1',
              project: 'p',
              commitSha: 'abc1234',
              bugs: [
                {
                  id: 'bug-1',
                  cwe: null,
                  cve: null,
                  files: [{ filePath: 'src/a.c', startLine: null, endLine: 9, functionName: null }],
                  fixCommit: null,
                  note: null,
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/sets endLine without startLine/)
  })

  test('rejects a site that ends before it starts', () => {
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            {
              id: 'fx-1',
              project: 'p',
              commitSha: 'abc1234',
              bugs: [
                {
                  id: 'bug-1',
                  cwe: null,
                  cve: null,
                  files: [{ filePath: 'src/a.c', startLine: 20, endLine: 10, functionName: null }],
                  fixCommit: null,
                  note: null,
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/ends \(10\) before it starts \(20\)/)
  })

  test('rejects a bug whose fix commit is the vulnerable commit', () => {
    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            {
              id: 'fx-1',
              project: 'p',
              commitSha: 'abc1234',
              bugs: [
                {
                  id: 'bug-1',
                  cwe: null,
                  cve: null,
                  files: [{ filePath: 'src/a.c', startLine: null, endLine: null, functionName: null }],
                  fixCommit: 'abc1234',
                  note: null,
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/which is the vulnerable commit/)
  })

  test('rejects a malformed CWE, CVE, and commit sha', () => {
    const files = [{ filePath: 'src/a.c', startLine: null, endLine: null, functionName: null }]
    const bug = { id: 'bug-1', cwe: 'CWE-abc', cve: null, files, fixCommit: null, note: null }
    expect(() =>
      parseFixtureSet(
        valid({ fixtures: [{ id: 'fx-1', project: 'p', commitSha: 'abc1234', bugs: [bug] }] }),
      ),
    ).toThrow(/must look like CWE-120/)

    expect(() =>
      parseFixtureSet(
        valid({
          fixtures: [
            {
              id: 'fx-1',
              project: 'p',
              commitSha: 'not-a-sha',
              bugs: [{ ...bug, cwe: null }],
            },
          ],
        }),
      ),
    ).toThrow(/must be a hex commit sha/)
  })

  test('names the defect in the message, because the author is the audience', () => {
    try {
      parseFixtureSet(valid({ version: 9 }))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidFixtureSetError)
      expect((error as Error).message).toContain('version 9')
      expect((error as Error).message).toContain('refused rather than repaired')
    }
  })
})
