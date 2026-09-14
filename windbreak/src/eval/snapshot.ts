/**
 * Materializing a fixture's snapshot on demand (spec §11.2, D22).
 *
 * D22 says the fixture list ships and the *snapshots* are fetched at run time, so
 * this module is the half that was missing: it turns `{ project, commitSha }` into a
 * checkout on disk at that exact revision, or refuses.
 *
 * ## Blobless, because the history is load-bearing
 *
 * The obvious cheap fetch is `--depth 1`, and it would be a silent disaster here.
 * §4.4.1 patch-mines fix commits out of the target's own `git log`, and §4.4.3 mines
 * atomicity rules out of lock-adding patches in the same history. A depth-1 snapshot
 * has exactly one commit, so both stages would find nothing and report nothing — an
 * empty candidate list that reads as a clean repository, which is the failure §18
 * exists to name. `--filter=blob:none` is the fetch that is actually cheap *here*:
 * it keeps every commit and tree (so both miners work) and defers the file contents
 * to the checkout, which is what makes a snapshot small.
 *
 * A remote that does not support filtering does not fail — git warns and sends
 * everything — so the fallback is detected and reported rather than treated as an
 * error. That direction matters: a full clone is correct, just slower.
 *
 * ## Two ways a cached checkout lies, and both are checked
 *
 * A snapshot directory is only reused when a **marker** says this module created it
 * *and* `HEAD` still matches the requested revision *and* the tree is still clean.
 *
 * - The marker is what distinguishes a finished fetch from an interrupted one. Without
 *   it, `git clone` being killed halfway leaves a directory that `rev-parse` can
 *   answer *something* about, and that something would be scanned.
 * - Cleanliness is checked because a scan records the revision it saw and asserts a
 *   clean tree. A snapshot somebody edited in place is still pinned to the right
 *   commit and no longer contains that commit's code, so the run's provenance would
 *   be wrong in a way `eval` could not show.
 *
 * The marker lives in `.git/`, not in the worktree, so writing it cannot itself make
 * the tree dirty. That is not a tidiness choice: the cleanliness check would
 * otherwise fail on every snapshot this module had successfully created.
 *
 * ## This is the project's third process spawn, and its first with a network
 *
 * `sandbox/run.ts` and `engines/resolve.ts` were the only spawn sites, and both run
 * jailed with no route (§6.3). A fetch cannot: the sandbox has no network by design,
 * so this runs on the host, which makes it the one place WindBreak reaches a remote
 * it was not told about by a config file. It reuses `spawnWithTimeout` rather than
 * spawning for itself, so there is still one place that knows how to run a bounded
 * subprocess — and so tests can inject a fake and never touch the network.
 */

import fs from 'fs'
import path from 'path'

import { spawnWithTimeout } from '../sandbox/run'
import { commitMatches } from './run'

import type { SandboxSpawn, SandboxSpawnResult } from '../sandbox/run'

/** Where snapshots land by default, beside the state database. */
export const DEFAULT_SNAPSHOTS_DIR = path.resolve('.windbreak', 'snapshots')

/** Generous, because a blobless clone of a large repository is still a clone. */
export const DEFAULT_CLONE_TIMEOUT_SECONDS = 900

/** The small verification commands. A checked-out cache answers these instantly. */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 120

const MARKER_FILE = 'windbreak-snapshot.json'
const SHA = /^[0-9a-f]{7,40}$/i
/**
 * Project names become directory names, so this is a security check rather than a
 * formatting one: a fixture list is hand-written input, and a project called
 * `../../etc` must not be able to aim a clone outside the cache.
 */
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

/** Written into `.git/` only after a checkout has been verified. */
export interface SnapshotMarker {
  project: string
  requestedSha: string
  headSha: string
  repo: string
  /**
   * Whether the clone used `--filter=blob:none`, as opposed to the remote ignoring
   * it and sending everything. Recorded here rather than re-derived because a cache
   * hit has no way to ask: the fetch that knew the answer is over, and reporting a
   * default would be claiming a measurement nobody took.
   */
  filtered: boolean
  fetchedAt: string
}

export interface SnapshotOptions {
  project: string
  /** As the fixture wrote it: 7–40 hex characters, possibly abbreviated. */
  commitSha: string
  repo: string
  /** The cache root. The checkout is `<into>/<project>-<sha>`. */
  into: string
  /** Re-clone even when a verified snapshot is already cached. */
  force?: boolean
  timeoutSeconds?: number
  /** Injected by tests; the real one is the sandbox's bounded spawner. */
  spawn?: SandboxSpawn
  log?: (line: string) => void
}

export interface SnapshotResult {
  project: string
  commitSha: string
  /** The full revision the checkout is at, as git reported it. */
  headSha: string
  path: string
  /** `cached` means a verified checkout was reused; `cloned` means this call made it. */
  status: 'cached' | 'cloned'
  /**
   * False when the remote ignored `--filter=blob:none` and sent everything. The
   * snapshot is still correct — this says which fetch actually happened.
   */
  filtered: boolean
  durationMs: number
}

/** `<project>-<sha>`, validated so the name cannot escape the cache root. */
export const snapshotDirName = (project: string, commitSha: string): string => {
  if (!SAFE_PROJECT.test(project)) {
    throw new SnapshotError(
      `Project name "${project}" is not usable as a directory name (expected letters, ` +
        'digits, dot, dash or underscore). A fixture list is written by hand, and a ' +
        'name that could climb out of the snapshot cache is refused rather than ' +
        'sanitised into a different project.',
    )
  }
  if (!SHA.test(commitSha)) {
    throw new SnapshotError(
      `"${commitSha}" is not a hex commit sha (7–40 characters); §11.2 pins a fixture ` +
        'to a revision, and an unpinnable fixture cannot be fetched reproducibly.',
    )
  }
  return `${project}-${commitSha.toLowerCase()}`
}

/** The checkout root for one fixture. Does not create or check anything. */
export const snapshotPath = (input: { into: string; project: string; commitSha: string }): string =>
  path.join(path.resolve(input.into), snapshotDirName(input.project, input.commitSha))

const markerPath = (dir: string): string => path.join(dir, '.git', MARKER_FILE)

/** The marker a previous fetch wrote, or null when this is not a finished snapshot. */
export const readSnapshotMarker = (dir: string): SnapshotMarker | null => {
  let raw: string
  try {
    raw = fs.readFileSync(markerPath(dir), 'utf8')
  } catch {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.project !== 'string' ||
      typeof record.requestedSha !== 'string' ||
      typeof record.headSha !== 'string' ||
      typeof record.repo !== 'string' ||
      typeof record.filtered !== 'boolean'
    ) {
      return null
    }
    return {
      project: record.project,
      requestedSha: record.requestedSha,
      headSha: record.headSha,
      repo: record.repo,
      filtered: record.filtered,
      fetchedAt: typeof record.fetchedAt === 'string' ? record.fetchedAt : '',
    }
  } catch {
    return null
  }
}

/** The subcommand in an argv like `['-C', dir, 'rev-parse', 'HEAD']`, for messages. */
const commandName = (args: readonly string[]): string => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '-C') {
      index += 1
      continue
    }
    if (!arg.startsWith('-')) return arg
  }
  return 'git'
}

/** The last few non-empty stderr lines, which is where git puts the actual reason. */
const reasonFrom = (result: SandboxSpawnResult): string => {
  const lines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const tail = lines.slice(-3).join(' | ')
  return tail.length > 0 ? tail : `exit code ${result.exitCode}`
}

/**
 * A snapshot fetch.
 *
 * `force` and the caller's own decisions aside, the rule is: an unverified directory
 * is removed rather than repaired. `git fetch` into a half-made clone is a repair
 * whose input is unknown, and the only thing this module can say about such a
 * directory is that it is not what was asked for.
 */
export const ensureSnapshot = async (options: SnapshotOptions): Promise<SnapshotResult> => {
  const log = options.log ?? (() => {})
  const spawn = options.spawn ?? spawnWithTimeout
  const dir = snapshotPath(options)
  const startedAt = Date.now()

  // One knob, two defaults: `--timeout-seconds` overrides both, and the checkout is
  // the only step that needs the generous one by default.
  const cloneTimeoutMs = (options.timeoutSeconds ?? DEFAULT_CLONE_TIMEOUT_SECONDS) * 1000
  const gitTimeoutMs = (options.timeoutSeconds ?? DEFAULT_GIT_TIMEOUT_SECONDS) * 1000

  const git = async (
    args: readonly string[],
    timeoutMs: number,
  ): Promise<SandboxSpawnResult> => {
    const result = await spawn(['git', ...args], timeoutMs)
    if (result.timedOut) {
      throw new SnapshotError(
        `git ${commandName(args)} timed out after ${Math.round(timeoutMs / 1000)}s, so no ` +
          'snapshot was materialized. A repository this size on a slow link needs a ' +
          'longer limit.',
      )
    }
    return result
  }

  /** `HEAD` as git reports it, or null when the directory cannot be asked. */
  const headOf = async (target: string): Promise<string | null> => {
    if (!fs.existsSync(markerPath(target))) return null
    const result = await git(['-C', target, 'rev-parse', 'HEAD'], gitTimeoutMs)
    return result.exitCode === 0 ? result.stdout.trim() : null
  }

  const isClean = async (target: string): Promise<boolean> => {
    const result = await git(['-C', target, 'status', '--porcelain'], gitTimeoutMs)
    return result.exitCode === 0 && result.stdout.trim().length === 0
  }

  // --- a verified checkout is reused, and nothing else is ---
  if (!options.force && fs.existsSync(dir)) {
    const marker = readSnapshotMarker(dir)
    const head = await headOf(dir)

    if (marker === null) {
      log(`[fetch] ${options.project}: a directory exists with no completion marker; refetching`)
    } else if (head === null) {
      log(`[fetch] ${options.project}: the cached checkout cannot be read; refetching`)
    } else if (!commitMatches(options.commitSha, head)) {
      log(
        `[fetch] ${options.project}: cached at ${head.slice(0, 12)}, ` +
          `wanted ${options.commitSha.toLowerCase()}; refetching`,
      )
    } else if (!(await isClean(dir))) {
      log(
        `[fetch] ${options.project}: the cached checkout is modified, so it no longer ` +
          'contains the revision it is pinned to; refetching',
      )
    } else {
      return {
        project: options.project,
        commitSha: options.commitSha,
        headSha: head,
        path: dir,
        status: 'cached',
        filtered: marker.filtered,
        durationMs: Date.now() - startedAt,
      }
    }

    fs.rmSync(dir, { recursive: true, force: true })
  } else if (options.force && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }

  // --- fetch ---
  fs.mkdirSync(path.dirname(dir), { recursive: true })

  try {
    const clone = await git(
      ['clone', '--filter=blob:none', '--no-checkout', options.repo, dir],
      cloneTimeoutMs,
    )
    if (clone.exitCode !== 0) {
      throw new SnapshotError(
        `Could not clone ${options.repo}: ${reasonFrom(clone)}`,
      )
    }

    const filterIgnored = /filter(ing)?[^\n]*not[^\n]*(recognized|supported|supported by server)/i.test(
      clone.stderr,
    )
    if (filterIgnored) {
      log(
        `[fetch] ${options.project}: the remote does not support partial clone, so ` +
          'this is a full clone (slower, and the history the miners need is present)',
      )
    }

    // Blobs arrive here, lazily, which is the whole trade the blobless clone made.
    const checkout = await git(['-C', dir, 'checkout', '--detach', options.commitSha], cloneTimeoutMs)
    if (checkout.exitCode !== 0) {
      throw new SnapshotError(
        `Cloned ${options.repo} but could not check out ${options.commitSha}: ` +
          `${reasonFrom(checkout)}. The revision may not exist in that repository — ` +
          'a fixture pinned to a fork or to a fetch commit will do this.',
      )
    }

    const headResult = await git(['-C', dir, 'rev-parse', 'HEAD'], gitTimeoutMs)
    if (headResult.exitCode !== 0) {
      throw new SnapshotError(`Could not read HEAD of the new clone: ${reasonFrom(headResult)}`)
    }
    const headSha = headResult.stdout.trim()

    // The checkout resolved *something*, and it must be what was asked for. An
    // abbreviated sha makes this a prefix match, which is `eval`'s own rule for the
    // same reason: the fixture list may abbreviate, and nothing else may.
    if (!commitMatches(options.commitSha, headSha)) {
      throw new SnapshotError(
        `Checked out ${options.commitSha} but HEAD is ${headSha}. Refusing to keep a ` +
          'snapshot that is not the pinned revision.',
      )
    }

    fs.writeFileSync(
      markerPath(dir),
      `${JSON.stringify(
        {
          project: options.project,
          requestedSha: options.commitSha,
          headSha,
          repo: options.repo,
          filtered: !filterIgnored,
          fetchedAt: new Date().toISOString(),
        } satisfies SnapshotMarker,
        null,
        2,
      )}\n`,
    )

    return {
      project: options.project,
      commitSha: options.commitSha,
      headSha,
      path: dir,
      status: 'cloned',
      filtered: !filterIgnored,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    // A directory this module created and could not verify is removed, so the next
    // invocation starts from nothing rather than trying to reason about a partial
    // clone. The marker is written last precisely so this state is unambiguous.
    fs.rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
