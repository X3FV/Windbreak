import { describe, expect, test } from 'bun:test'

import { buildCorpus } from './build'

import type { CorpusBuilderDeps, ParsedCallable } from './build'

interface FakeRepo {
  /** The raw output of `git log --grep=CVE-`. */
  log: string
  /** commit -> its first parent. */
  parents: Record<string, string>
  /** commit -> unified-0 diff against its parent. */
  diffs: Record<string, string>
  /** `${revision}:${path}` -> file content. */
  files: Record<string, string>
  /** file content -> the callables the parser reports for it. */
  parsed?: Record<string, readonly ParsedCallable[]>
}

const logEntry = (sha: string, committedAt: number, subject: string, body = ''): string =>
  `${sha}\x1f${committedAt}\x1f${subject}\x1f${body}\x1e`

const fakeGit =
  (repo: FakeRepo) =>
  (_repoDir: string, args: readonly string[]): string => {
    if (args[0] === 'log') return repo.log
    if (args[0] === 'rev-parse') {
      const sha = args[1]!.replace(/\^$/, '')
      const parent = repo.parents[sha]
      if (parent === undefined) throw new Error(`no parent for ${sha}`)
      return `${parent}\n`
    }
    if (args[0] === 'diff') {
      const diff = repo.diffs[args[args.length - 1]!]
      if (diff === undefined) throw new Error('no diff')
      return diff
    }
    if (args[0] === 'show') {
      const content = repo.files[args[1]!]
      if (content === undefined) throw new Error(`no file ${args[1]}`)
      return content
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }

const depsFor = (repo: FakeRepo): CorpusBuilderDeps => ({
  runGit: fakeGit(repo),
  parseCallables: async (source) => repo.parsed?.[source] ?? [],
})

const FUNC: ParsedCallable = {
  name: 'parse_header',
  qualifier: null,
  kind: 'function',
  startLine: 1,
  endLine: 3,
}

const BEFORE = 'int parse_header(char *b) {\n  strcpy(b, src);\n}'
const AFTER = 'int parse_header(char *b) {\n  memcpy(b, src, n);\n}'

const HUNK = [
  'diff --git a/src/a.c b/src/a.c',
  '--- a/src/a.c',
  '+++ b/src/a.c',
  '@@ -1,3 +1,3 @@',
  '-  strcpy(b, src);',
  '+  memcpy(b, src, n);',
].join('\n')

const oneCommitRepo = (overrides: Partial<FakeRepo> = {}): FakeRepo => ({
  log: logEntry('f'.repeat(40), 1_700_000_000, 'fix a bug', 'CVE-2024-1234'),
  parents: { ['f'.repeat(40)]: 'a'.repeat(40) },
  diffs: { ['f'.repeat(40)]: HUNK },
  files: {
    [`${'a'.repeat(40)}:src/a.c`]: BEFORE,
    [`${'f'.repeat(40)}:src/a.c`]: AFTER,
  },
  parsed: { [BEFORE]: [FUNC], [AFTER]: [FUNC] },
  ...overrides,
})

const sources = [{ project: 'demo', repoDir: '/nonexistent' }]

describe('buildCorpus', () => {
  test('emits one pair per CVE, pinned to the fix and its parent', async () => {
    const result = await buildCorpus({ sources, deps: depsFor(oneCommitRepo()) })

    expect(result.pairSet.kind).toBe('function-pairs')
    expect(result.pairSet.pairs).toHaveLength(1)

    const pair = result.pairSet.pairs[0]!
    expect(pair.project).toBe('demo')
    expect(pair.cve).toBe('CVE-2024-1234')
    expect(pair.fixCommit).toBe('f'.repeat(40))
    expect(pair.commitSha).toBe('a'.repeat(40))
    expect(pair.filePath).toBe('src/a.c')
    expect(pair.vulnerable).toBe(BEFORE)
    expect(pair.patched).toBe(AFTER)
    expect(pair.id).toContain('parse_header')
  })

  test('drops a pair whose halves differ only in comments', async () => {
    // The guard that keeps a reformatted function out of the corpus. Seeding it
    // would record a bug no rule could fire on, which is indistinguishable from
    // a rule that missed.
    const prose = 'int parse_header(char *b) {\n  use(b);\n}'
    const proseWithComment = 'int parse_header(char *b) {\n  /* note */ use(b);\n}'
    const repo = oneCommitRepo({
      files: {
        [`${'a'.repeat(40)}:src/a.c`]: prose,
        [`${'f'.repeat(40)}:src/a.c`]: proseWithComment,
      },
      parsed: { [prose]: [FUNC], [proseWithComment]: [FUNC] },
    })
    const result = await buildCorpus({ sources, deps: depsFor(repo) })

    expect(result.pairSet.pairs).toHaveLength(0)
    expect(result.drops.map((drop) => drop.reason)).toContain(
      'the two halves differ only in comments and whitespace',
    )
  })

  test('drops a commit whose changed lines fall in no callable', async () => {
    const repo = oneCommitRepo({ parsed: { [BEFORE]: [], [AFTER]: [] } })
    const result = await buildCorpus({ sources, deps: depsFor(repo) })

    expect(result.pairSet.pairs).toHaveLength(0)
    expect(result.drops[0]!.reason).toBe('no callable overlaps the changed line range')
  })

  test('drops a commit that touches no C source', async () => {
    const repo = oneCommitRepo({
      diffs: {
        ['f'.repeat(40)]: ['--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@'].join('\n'),
      },
    })
    const result = await buildCorpus({ sources, deps: depsFor(repo) })

    expect(result.pairSet.pairs).toHaveLength(0)
    expect(result.drops[0]!.reason).toBe('the commit changes no C or C++ source file')
  })

  test('keeps the oldest commit for a CVE and function', async () => {
    const older = '1'.repeat(40)
    const newer = '2'.repeat(40)
    const repo = oneCommitRepo({
      log:
        logEntry(newer, 2_000, 'refine the fix', 'CVE-2024-1234') +
        logEntry(older, 1_000, 'fix it', 'CVE-2024-1234'),
      parents: { [newer]: 'a'.repeat(40), [older]: 'a'.repeat(40) },
      diffs: { [newer]: HUNK, [older]: HUNK },
      files: {
        [`${'a'.repeat(40)}:src/a.c`]: BEFORE,
        [`${newer}:src/a.c`]: AFTER,
        [`${older}:src/a.c`]: AFTER,
      },
    })

    const result = await buildCorpus({ sources, deps: depsFor(repo) })

    expect(result.pairSet.pairs).toHaveLength(1)
    expect(result.pairSet.pairs[0]!.fixCommit).toBe(older)
    expect(result.stats.pairsDeduplicated).toBe(1)
  })

  test('one function naming two CVEs yields a pair for each', async () => {
    const repo = oneCommitRepo({
      log: logEntry('f'.repeat(40), 1_700_000_000, 'fix two', 'CVE-2024-1234 CVE-2024-5678'),
    })
    const result = await buildCorpus({ sources, deps: depsFor(repo) })

    expect(result.pairSet.pairs.map((pair) => pair.cve).sort()).toEqual([
      'CVE-2024-1234',
      'CVE-2024-5678',
    ])
  })

  test('records a history that cannot be read instead of reporting no pairs', async () => {
    // A broken checkout and a project with no CVE-tagged fixes must not look the
    // same: one is a corpus that lost rows, the other is a corpus with none.
    const result = await buildCorpus({
      sources,
      deps: {
        runGit: () => {
          throw new Error('not a git repository')
        },
        parseCallables: async () => [],
      },
    })

    expect(result.pairSet.pairs).toHaveLength(0)
    expect(result.drops[0]!.reason).toContain('could not read the commit history')
    expect(result.drops[0]!.reason).toContain('not a git repository')
  })
})
