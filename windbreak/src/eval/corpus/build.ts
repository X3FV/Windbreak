/**
 * Building a recall corpus out of fix commits (spec §11.1).
 *
 * The project has had a fixture format since §11.2 and no populated list, which
 * means the only recall figure it could produce was against hand-seeded sites —
 * and a site seeded by the person who wrote the rule confirms that rule's own
 * assumptions. This builds the other kind: every pair here is two revisions of a
 * function that a real project fixed a real CVE in, and the only human decision
 * involved is *which upstream projects to read*.
 *
 * Four things about it are deliberate, and each is a limit a reader has to know
 * before treating the resulting number as a score:
 *
 * 1. **The index is the commit message.** A fix enters the corpus only if the
 *    commit that made it names a `CVE-` id. Projects that never tag their fixes
 *    — or tag them only in release notes — contribute nothing, and neither do
 *    the many real security fixes that never got an id at all. The corpus is
 *    therefore *not* a sample of a project's vulnerabilities; it is the subset
 *    someone chose to name, which over-represents findings that were disclosed
 *    loudly.
 * 2. **The vulnerable revision is the fix's parent.** Not a release tag, not the
 *    last tag before the fix: the commit immediately before, so the code is as
 *    close to the defect as the history allows and no unrelated change is
 *    folded in.
 * 3. **The unit is the function the diff touched**, not the function a human
 *    says is guilty. A fix that changes two functions contributes two pairs,
 *    which is the right denominator for "would a detector have fired here" and
 *    the wrong one for "how many bugs were in this commit".
 * 4. **Pairs whose only change is prose are dropped.** See `source.ts`: seeding a
 *    comment edit as a bug makes a rule that never fires look like a rule that
 *    missed, and nothing in the output would show it.
 *
 * Nothing here decides whether a pair's defect is the *kind* a detector could
 * catch. A null-pointer dereference, an authorization error and an out-of-bounds
 * write are all pairs, so a low recall figure on this corpus means "few of these
 * fixes were the shape the rules test" as much as it means "the rules are weak".
 * The report says so rather than letting the number stand alone.
 */

import {
  cvesInMessage,
  isCSourcePath,
  parseChangedFiles,
  type ChangedRange,
} from './diff'
import { onlyCommentsChanged } from './source'

import type { FunctionPair, PairSet } from '../types'
import type { SymbolKind } from '../../recon/symbol-kinds'

/** What the builder needs from a parsed file. A subset of `ParsedSymbol`. */
export interface ParsedCallable {
  name: string
  qualifier: string | null
  kind: SymbolKind
  startLine: number
  endLine: number
}

/** Injected so the builder can be driven without a checkout or a parser. */
export interface CorpusBuilderDeps {
  /** Run git in a repository and return stdout. Throws on a non-zero exit. */
  runGit: (repoDir: string, args: readonly string[]) => string
  /** Parse one C source file into its callables. */
  parseCallables: (source: string) => Promise<readonly ParsedCallable[]>
}

export interface CorpusSource {
  /** The name candidates and the project registry know this repository by. */
  project: string
  /** A checkout containing the commits the corpus is built from. */
  repoDir: string
}

export interface BuildCorpusOptions {
  sources: readonly CorpusSource[]
  deps: CorpusBuilderDeps
  /** Stop after this many commits per project. Absent means all of them. */
  maxCommitsPerProject?: number
  /**
   * Skip a function longer than this. Recorded as a drop rather than silently
   * omitted, because the cap is a bias: long parsers are exactly where these
   * defects live, so the pairs it removes are not a random sample.
   */
  maxFunctionLines?: number
  log?: (line: string) => void
}

/** Why a fix commit produced no pair, or fewer than it might have. */
export interface CorpusDrop {
  project: string
  commit: string
  filePath: string | null
  functionName: string | null
  reason: string
}

export interface CorpusStats {
  commitsRead: number
  commitsWithPairs: number
  filesConsidered: number
  pairsFound: number
  pairsDeduplicated: number
  dropsByReason: Array<{ reason: string; count: number }>
}

export interface BuildCorpusResult {
  pairSet: PairSet
  stats: CorpusStats
  drops: CorpusDrop[]
}

export const DEFAULT_MAX_FUNCTION_LINES = 2_000
export const CORPUS_NAME = 'cve-fixes'

const CALLABLE_KINDS: readonly SymbolKind[] = ['function', 'method']

const isCallable = (symbol: ParsedCallable): boolean => CALLABLE_KINDS.includes(symbol.kind)

const intersects = (symbol: ParsedCallable, ranges: readonly ChangedRange[]): boolean =>
  ranges.some((range) => symbol.startLine <= range.end && range.start <= symbol.endLine)

/**
 * The same callable in the other revision.
 *
 * Matched on name *and* qualifier first, then on name alone. The two-step order
 * matters for C++: a fix can replace a member function with a free one of the
 * same name, and pairing across that would compare two different functions and
 * call the difference a fix. Falling back to the bare name keeps C — where the
 * qualifier is always null — working.
 */
const counterpart = (
  target: ParsedCallable,
  candidates: readonly ParsedCallable[],
): ParsedCallable | null => {
  const callables = candidates.filter(isCallable)
  return (
    callables.find(
      (candidate) => candidate.name === target.name && candidate.qualifier === target.qualifier,
    ) ??
    callables.find((candidate) => candidate.name === target.name) ??
    null
  )
}

const slice = (lines: readonly string[], startLine: number, endLine: number): string =>
  lines.slice(startLine - 1, endLine).join('\n')

interface CommitRecord {
  sha: string
  committedAt: number
  subject: string
  cves: string[]
}

const LOG_FORMAT = '%H%x1f%ct%x1f%s%x1f%B%x1e'
const FIELD = '\x1f'
const RECORD = '\x1e'

/** Commits whose message names a CVE, newest first, as git reports them. */
const readFixCommits = (
  source: CorpusSource,
  deps: CorpusBuilderDeps,
): CommitRecord[] => {
  const raw = deps.runGit(source.repoDir, [
    'log',
    `--format=${LOG_FORMAT}`,
    '--grep=CVE-',
    '-i',
  ])

  const records: CommitRecord[] = []
  for (const chunk of raw.split(RECORD)) {
    const parts = chunk.split(FIELD)
    const sha = parts[0]?.trim()
    if (!sha) continue
    const committedAt = Number(parts[1] ?? '0')
    const subject = (parts[2] ?? '').trim()
    const body = parts.slice(3).join(FIELD)
    const cves = cvesInMessage(`${subject}\n${body}`)
    if (cves.length === 0) continue
    records.push({ sha, committedAt: Number.isFinite(committedAt) ? committedAt : 0, subject, cves })
  }
  return records
}

const tryGit = (
  repoDir: string,
  args: readonly string[],
  deps: CorpusBuilderDeps,
): string | null => {
  try {
    return deps.runGit(repoDir, args)
  } catch {
    return null
  }
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`

/**
 * Turn a set of checkouts into a pair set.
 *
 * Deterministic: pairs are sorted and deduplicated by a key derived from the
 * fix, so re-running the builder against the same history produces a byte-identical
 * file. A corpus that reshuffled between runs would make a recall figure
 * incomparable with itself.
 */
export const buildCorpus = async (
  options: BuildCorpusOptions,
): Promise<BuildCorpusResult> => {
  const deps = options.deps
  const log = options.log ?? (() => {})
  const maxLines = options.maxFunctionLines ?? DEFAULT_MAX_FUNCTION_LINES

  interface Candidate {
    pair: FunctionPair
    key: string
    committedAt: number
  }

  const candidates: Candidate[] = []
  const drops: CorpusDrop[] = []
  let commitsRead = 0
  let filesConsidered = 0
  let pairsFound = 0

  const drop = (
    project: string,
    commit: string,
    filePath: string | null,
    functionName: string | null,
    reason: string,
  ): void => {
    drops.push({ project, commit, filePath, functionName, reason })
  }

  for (const source of options.sources) {
    let commits: CommitRecord[]
    try {
      commits = readFixCommits(source, deps)
    } catch (error) {
      drop(
        source.project,
        '(history)',
        null,
        null,
        `could not read the commit history: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }

    if (options.maxCommitsPerProject !== undefined) {
      commits = commits.slice(0, options.maxCommitsPerProject)
    }

    log(`[corpus] ${source.project}: ${commits.length} commit(s) naming a CVE`)

    for (const commit of commits) {
      commitsRead += 1

      const parent = tryGit(source.repoDir, ['rev-parse', `${commit.sha}^`], deps)?.trim()
      if (!parent) {
        drop(source.project, commit.sha, null, null, 'the commit has no parent (root commit)')
        continue
      }

      const diff = tryGit(
        source.repoDir,
        ['diff', '--unified=0', '--no-color', parent, commit.sha],
        deps,
      )
      if (diff === null) {
        drop(source.project, commit.sha, null, null, 'git diff failed for this commit')
        continue
      }

      const files = parseChangedFiles(diff).filter((file) => isCSourcePath(file.filePath))
      if (files.length === 0) {
        drop(
          source.project,
          commit.sha,
          null,
          null,
          'the commit changes no C or C++ source file',
        )
        continue
      }

      let fromThisCommit = 0

      for (const file of files) {
        filesConsidered += 1

        const before = tryGit(source.repoDir, ['show', `${parent}:${file.filePath}`], deps)
        const after = tryGit(source.repoDir, ['show', `${commit.sha}:${file.filePath}`], deps)
        if (before === null || after === null) {
          drop(
            source.project,
            commit.sha,
            file.filePath,
            null,
            'the file is not present at both revisions (added, deleted, or renamed)',
          )
          continue
        }

        const beforeCallables = (await deps.parseCallables(before)).filter(isCallable)
        const afterCallables = (await deps.parseCallables(after)).filter(isCallable)
        const beforeLines = before.split('\n')
        const afterLines = after.split('\n')

        const touched = beforeCallables.filter((symbol) => intersects(symbol, file.ranges))
        if (touched.length === 0) {
          drop(
            source.project,
            commit.sha,
            file.filePath,
            null,
            'no callable overlaps the changed line range',
          )
          continue
        }

        for (const target of touched) {
          const twin = counterpart(target, afterCallables)
          if (twin === null) {
            drop(
              source.project,
              commit.sha,
              file.filePath,
              target.name,
              'the callable has no counterpart after the fix',
            )
            continue
          }

          if (target.endLine - target.startLine + 1 > maxLines) {
            drop(
              source.project,
              commit.sha,
              file.filePath,
              target.name,
              `the callable is longer than ${maxLines} lines`,
            )
            continue
          }

          const vulnerable = slice(beforeLines, target.startLine, target.endLine)
          const patched = slice(afterLines, twin.startLine, twin.endLine)

          if (vulnerable.trim().length === 0 || patched.trim().length === 0) {
            drop(source.project, commit.sha, file.filePath, target.name, 'one half is empty')
            continue
          }

          if (onlyCommentsChanged(vulnerable, patched)) {
            drop(
              source.project,
              commit.sha,
              file.filePath,
              target.name,
              'the two halves differ only in comments and whitespace',
            )
            continue
          }

          pairsFound += 1
          fromThisCommit += 1

          for (const cve of commit.cves) {
            const id = `${source.project}-${cve.toLowerCase()}-${target.name}`
            candidates.push({
              committedAt: commit.committedAt,
              // One pair per CVE per function; the key drops the CVE so a fix
              // that names two ids for one change is stored once, against the
              // oldest commit that made it.
              key: `${source.project}\u0000${cve}\u0000${file.filePath}\u0000${target.name}`,
              pair: {
                id: `${id}-${commit.sha.slice(0, 12)}`,
                project: source.project,
                cwe: null,
                cve,
                commitSha: parent,
                fixCommit: commit.sha,
                vulnerable,
                patched,
                filePath: file.filePath,
                note: truncate(
                  `fix ${commit.sha.slice(0, 12)} (parent ${parent.slice(0, 12)}); ` +
                    `${target.name} touched by ${file.ranges.length} changed region(s); ` +
                    `${truncate(commit.subject, 160)}`,
                  500,
                ),
              },
            })
          }
        }
      }

      if (fromThisCommit > 0) {
        log(`[corpus]   ${commit.sha.slice(0, 12)} -> ${fromThisCommit} pair(s)`)
      }
    }
  }

  // Oldest commit wins for a key, so a fix is recorded at the revision that
  // first contained it rather than at a later refinement of the same code.
  const byKey = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.key)
    if (existing === undefined || candidate.committedAt < existing.committedAt) {
      byKey.set(candidate.key, candidate)
    }
  }

  const pairs = [...byKey.values()]
    .map((candidate) => candidate.pair)
    .sort(
      (left, right) =>
        left.project.localeCompare(right.project) ||
        (left.cve ?? '').localeCompare(right.cve ?? '') ||
        (left.filePath ?? '').localeCompare(right.filePath ?? '') ||
        left.id.localeCompare(right.id),
    )

  const withPairs = new Set(
    [...byKey.values()].map((candidate) => candidate.pair.fixCommit ?? ''),
  )

  const reasons = new Map<string, number>()
  for (const entry of drops) {
    reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1)
  }

  const pairSet: PairSet = {
    kind: 'function-pairs',
    version: 1,
    corpus: CORPUS_NAME,
    description: truncate(
      'Vulnerable/patched function pairs mined from upstream fix commits that name a ' +
        'CVE id. Each pair is one function at the commit before the fix and the same ' +
        'function at the fix. Built by `windbreak corpus build`; see its report for ' +
        'what was dropped and why.',
      500,
    ),
    pairs,
  }

  return {
    pairSet,
    drops,
    stats: {
      commitsRead,
      commitsWithPairs: withPairs.size,
      filesConsidered,
      pairsFound,
      pairsDeduplicated: candidates.length - byKey.size,
      dropsByReason: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    },
  }
}
