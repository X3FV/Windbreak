/**
 * Reading the target's own commit history (spec §4.4.1).
 *
 * This is the only part of patch mining that touches target code, and it does so
 * the way `recon`'s dirty check does: through a caller-supplied runner that
 * executes git **inside the sandbox**, with the checkout bound read-only. The
 * reasoning is `recon/git.ts`'s and is repeated rather than inherited by accident,
 * because it is the security-relevant decision in this module:
 *
 *   `git status` honours `core.fsmonitor` from an untrusted `.git/config`, which
 *   is arbitrary command execution in the checkout. Reading `HEAD` and `refs/`
 *   cannot execute anything, which is why recon reads refs directly — but a
 *   history walk has to run git, so it runs it jailed.
 *
 * `-c core.fsmonitor=false` and `--no-optional-locks` are therefore passed by
 * this module rather than assumed to be the runner's defaults: the runner is
 * generic (see `recon/run.ts`), and the flags are this command's requirement.
 *
 * ## One spawn, not one per commit
 *
 * The log is read with a single `git log -p` and parsed, rather than a `git show`
 * per commit. Every spawn is a fresh nsjail/bwrap launch, so a per-commit read
 * would make mining cost scale with history size in the most expensive unit
 * available. The volume is instead bounded three ways: `--max-count` caps commits,
 * the pathspecs restrict the walk to C-family sources (the only languages the
 * shape detectors understand), and the sandbox's own time limit caps the whole
 * read.
 */

import { LOG_FORMAT, parseCommitPatches } from './diff'

import type { CommitPatch } from './types'

/** Run git in the sandbox. Same shape as recon's `createSandboxGitRunner`. */
export type GitRunner = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string }>

/**
 * The extensions the shape detectors can read.
 *
 * Restricting the walk here rather than filtering afterwards is what keeps the
 * spawn's output bounded: on a target with a large non-C tree, `git log -p` over
 * the whole history can run to hundreds of megabytes, and none of it would be
 * usable.
 */
export const PROGRAM_MODEL_PATHSPECS = [
  '*.c',
  '*.h',
  '*.cc',
  '*.cpp',
  '*.cxx',
  '*.hpp',
  '*.hh',
] as const

export const DEFAULT_MAX_COMMITS = 300

export interface ReadHistoryOptions {
  runGit: GitRunner
  /** Cap on commits walked. See the module note on volume. */
  maxCommits?: number
  pathspecs?: readonly string[]
}

export interface ReadHistoryResult {
  commits: CommitPatch[]
  warnings: string[]
}

export const readCommitHistory = async (
  options: ReadHistoryOptions,
): Promise<ReadHistoryResult> => {
  const warnings: string[] = []
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS
  const pathspecs = options.pathspecs ?? PROGRAM_MODEL_PATHSPECS

  const argv = [
    '--no-optional-locks',
    '-c',
    'core.fsmonitor=false',
    'log',
    '-p',
    '--unified=3',
    '--no-color',
    '--no-merges',
    // Rename detection is a per-commit cost that buys nothing here: a pattern is
    // mined from the shape of a change, not from the name of the file it landed in.
    '--no-renames',
    `--max-count=${maxCommits}`,
    `--format=${LOG_FORMAT}`,
    '--',
    ...pathspecs,
  ]

  let result: { exitCode: number; stdout: string }
  try {
    result = await options.runGit(argv)
  } catch (error) {
    return {
      commits: [],
      warnings: [
        `Could not read the target's history: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }

  if (result.exitCode !== 0) {
    // A target that is not a repository, or one with no commits, is not an error
    // for this stage: patch mining is one discovery path among several and the
    // engines stage still runs. It is a warning so an empty result is not read as
    // "a clean history".
    return {
      commits: [],
      warnings: [
        'The history walk failed (git exited ' +
          `${result.exitCode}); patch-mined discovery produced nothing. The target may not be a ` +
          'repository, or the sandbox may not have run git.',
      ],
    }
  }

  const commits = parseCommitPatches(result.stdout)
  if (commits.length === 0) {
    warnings.push(
      'The history walk returned no commits touching C-family sources; nothing to mine.',
    )
  }

  return { commits, warnings }
}
