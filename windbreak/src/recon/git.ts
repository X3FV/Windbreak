import fs from 'fs'
import path from 'path'

/**
 * Git state for a target.
 *
 * The commit SHA is read **from git's files**, not by running `git`. That is a
 * security decision, not an optimisation: `git status` honours
 * `core.fsmonitor` from an untrusted `.git/config`, which is arbitrary command
 * execution in the checkout before any sandbox exists. Reading `HEAD` and
 * `refs/` cannot execute anything.
 *
 * The working-tree dirty check still needs git, so it runs in the sandbox
 * (`checkDirty`), and degrades to `null` ("unknown") rather than guessing.
 */

export interface GitState {
  isRepository: boolean
  commitSha: string | null
  branch: string | null
  /** True when HEAD points at a raw SHA rather than a branch. */
  detached: boolean
  /** null when it could not be determined. */
  dirty: boolean | null
  warnings: string[]
}

export interface ReadGitRefsResult {
  isRepository: boolean
  commitSha: string | null
  branch: string | null
  detached: boolean
  warnings: string[]
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i

/** Look up a ref in `packed-refs`, which git writes for packed repositories. */
const readPackedRef = (gitDir: string, ref: string): string | null => {
  const packedRefsPath = path.join(gitDir, 'packed-refs')
  if (!fs.existsSync(packedRefsPath)) return null

  try {
    for (const line of fs.readFileSync(packedRefsPath, 'utf8').split('\n')) {
      // `^<sha>` lines peel annotated tags; skip them.
      if (line.startsWith('#') || line.startsWith('^') || line.length === 0) {
        continue
      }
      const [sha, name] = line.split(' ')
      if (name === ref && sha && SHA_PATTERN.test(sha)) return sha
    }
  } catch {
    return null
  }

  return null
}

/**
 * Resolve the checked-out commit without executing anything.
 *
 * Handles `.git` being a file (worktrees and submodules) as well as a
 * directory.
 */
export const readGitRefs = (rootDir: string): ReadGitRefsResult => {
  const warnings: string[] = []
  const dotGit = path.join(rootDir, '.git')

  if (!fs.existsSync(dotGit)) {
    return {
      isRepository: false,
      commitSha: null,
      branch: null,
      detached: false,
      warnings,
    }
  }

  let gitDir = dotGit
  if (fs.statSync(dotGit).isFile()) {
    // `gitdir: ../.git/worktrees/<name>`
    try {
      const pointer = fs.readFileSync(dotGit, 'utf8').trim()
      const match = pointer.match(/^gitdir:\s*(.+)$/)
      if (match?.[1]) {
        gitDir = path.resolve(rootDir, match[1])
      }
    } catch {
      warnings.push('Could not read the .git pointer file.')
      return {
        isRepository: true,
        commitSha: null,
        branch: null,
        detached: true,
        warnings,
      }
    }
  }

  const headPath = path.join(gitDir, 'HEAD')
  if (!fs.existsSync(headPath)) {
    warnings.push('No HEAD file found; the repository has no commits yet.')
    return {
      isRepository: true,
      commitSha: null,
      branch: null,
      detached: true,
      warnings,
    }
  }

  let head: string
  try {
    head = fs.readFileSync(headPath, 'utf8').trim()
  } catch {
    warnings.push('Could not read HEAD.')
    return {
      isRepository: true,
      commitSha: null,
      branch: null,
      detached: true,
      warnings,
    }
  }

  // Detached HEAD: HEAD is the commit itself.
  if (SHA_PATTERN.test(head)) {
    return {
      isRepository: true,
      commitSha: head,
      branch: null,
      detached: true,
      warnings,
    }
  }

  const refMatch = head.match(/^ref:\s*(.+)$/)
  if (!refMatch?.[1]) {
    warnings.push(`Unrecognised HEAD contents: ${head.slice(0, 80)}`)
    return {
      isRepository: true,
      commitSha: null,
      branch: null,
      detached: true,
      warnings,
    }
  }

  const ref = refMatch[1]
  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : null

  const looseRefPath = path.join(gitDir, ref)
  if (fs.existsSync(looseRefPath)) {
    const sha = fs.readFileSync(looseRefPath, 'utf8').trim()
    if (SHA_PATTERN.test(sha)) {
      return {
        isRepository: true,
        commitSha: sha,
        branch,
        detached: false,
        warnings,
      }
    }
  }

  const packed = readPackedRef(gitDir, ref)
  if (packed) {
    return {
      isRepository: true,
      commitSha: packed,
      branch,
      detached: false,
      warnings,
    }
  }

  warnings.push(`Could not resolve ${ref} to a commit.`)
  return {
    isRepository: true,
    commitSha: null,
    branch,
    detached: false,
    warnings,
  }
}

/**
 * Working-tree dirtiness, via a caller-supplied sandboxed git runner.
 *
 * Returns null when the check could not run, so "could not determine" is never
 * reported as "clean" — a false clean would make a scan look reproducible when
 * it is not.
 */
export const checkDirty = async (
  runGit: (args: string[]) => Promise<{ exitCode: number; stdout: string }>,
): Promise<{ dirty: boolean | null; warning: string | null }> => {
  try {
    const result = await runGit([
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain',
    ])

    if (result.exitCode !== 0) {
      return {
        dirty: null,
        warning: 'Could not determine working-tree state with git.',
      }
    }

    return { dirty: result.stdout.trim().length > 0, warning: null }
  } catch {
    return {
      dirty: null,
      warning: 'Could not determine working-tree state with git.',
    }
  }
}
