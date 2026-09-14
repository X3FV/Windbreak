import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { readSnapshotMarker, SnapshotError, snapshotDirName, snapshotPath } from './snapshot'
import { ensureSnapshot } from './snapshot'

import type { SandboxSpawn, SandboxSpawnResult } from '../sandbox/run'

const FULL_SHA = '6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b'
const SHORT_SHA = '6a7b8c9d'
const REPO = 'https://example.test/project.git'

const temporaryDirs: string[] = []

const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-snapshot-'))
  temporaryDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** The git subcommand in an argv, skipping `-C <dir>`. */
const subcommand = (argv: readonly string[]): string => {
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '-C') {
      index += 1
      continue
    }
    if (!arg.startsWith('-')) return arg
  }
  return ''
}

interface Call {
  argv: readonly string[]
  timeoutMs: number
}

interface FakeGit {
  head?: string
  /**
   * What `rev-parse` answers *after* a clone has happened, when that differs from
   * `head`. A cache sitting at the wrong revision answers `head`; the fresh clone
   * that replaces it answers this.
   */
  headAfterClone?: string
  /** What `git status --porcelain` prints. Non-empty means a modified tree. */
  status?: string
  clone?: { exitCode?: number; stderr?: string; timedOut?: boolean }
  checkout?: { exitCode?: number; stderr?: string }
  /** Gives the fake a chance to create the destination's `.git`, as git would. */
  onCreateClone?: (dest: string) => void
}

const fakeGit = (options: FakeGit = {}): { spawn: SandboxSpawn; calls: Call[] } => {
  const calls: Call[] = []
  let cloned = false

  const spawn: SandboxSpawn = async (argv, timeoutMs) => {
    calls.push({ argv, timeoutMs })
    const command = subcommand(argv)

    const result = (
      exitCode: number,
      stdout = '',
      stderr = '',
      timedOut = false,
    ): SandboxSpawnResult => ({ exitCode, stdout, stderr, timedOut })

    if (command === 'clone') {
      const ok = (options.clone?.exitCode ?? 0) === 0 && options.clone?.timedOut !== true
      if (ok) {
        options.onCreateClone?.(argv[argv.length - 1]!)
        cloned = true
      }
      return result(options.clone?.exitCode ?? 0, '', options.clone?.stderr ?? '', options.clone?.timedOut ?? false)
    }
    if (command === 'checkout') {
      return result(options.checkout?.exitCode ?? 0, '', options.checkout?.stderr ?? '')
    }
    if (command === 'rev-parse') {
      const head = cloned ? (options.headAfterClone ?? options.head ?? '') : (options.head ?? '')
      return result(0, `${head}\n`)
    }
    if (command === 'status') return result(0, options.status ?? '')
    return result(0)
  }

  return { spawn, calls }
}

/** Create a checkout that a previous fetch would have left behind. */
const seedCachedSnapshot = (input: { dir: string; head: string; requestedSha?: string }): void => {
  const gitDir = path.join(input.dir, '.git')
  fs.mkdirSync(gitDir, { recursive: true })
  fs.writeFileSync(
    path.join(gitDir, 'windbreak-snapshot.json'),
    JSON.stringify({
      project: 'project',
      requestedSha: input.requestedSha ?? input.head,
      headSha: input.head,
      repo: REPO,
      filtered: true,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    }),
  )
}

const clone = (input: {
  into: string
  commitSha?: string
  force?: boolean
  timeoutSeconds?: number
  spawn?: SandboxSpawn
}) =>
  ensureSnapshot({
    project: 'project',
    commitSha: input.commitSha ?? FULL_SHA,
    repo: REPO,
    into: input.into,
    ...(input.force === true ? { force: true } : {}),
    ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
    spawn: input.spawn ?? fakeGit({ head: FULL_SHA, onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }) }).spawn,
  })

describe('snapshot naming', () => {
  test('the directory is the project and the lowercased sha', () => {
    expect(snapshotDirName('libarchive', '6A7B8C9D')).toBe('libarchive-6a7b8c9d')
  })

  test('a project name that could climb out of the cache is refused', () => {
    // A fixture list is hand-written input, and `project` becomes a directory name.
    // Sanitising `../../etc` would silently clone a *different* project; refusing is
    // the only answer that cannot be wrong about which code was fetched.
    expect(() => snapshotDirName('../../etc', FULL_SHA)).toThrow(SnapshotError)
    expect(() => snapshotDirName('a/b', FULL_SHA)).toThrow(/not usable as a directory name/)
  })

  test('a non-hex or too-short commit is refused', () => {
    expect(() => snapshotDirName('project', 'not-a-sha')).toThrow(/not a hex commit sha/)
    expect(() => snapshotDirName('project', 'abc')).toThrow(/not a hex commit sha/)
  })

  test('snapshotPath is the cache root plus the directory name', () => {
    expect(snapshotPath({ into: '/cache', project: 'p', commitSha: SHORT_SHA })).toBe(
      path.join('/cache', 'p-6a7b8c9d'),
    )
  })
})

describe('ensureSnapshot — fetching', () => {
  test('a blobless clone is checked out and marked', async () => {
    const into = tempDir()
    const { spawn, calls } = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn })

    expect(result.status).toBe('cloned')
    expect(result.headSha).toBe(FULL_SHA)
    expect(result.path).toBe(path.join(into, `project-${FULL_SHA}`))

    // Blobless is the point: `--depth 1` would leave §4.4.1's patch mining and
    // §4.4.3's atomicity-rule mining with a one-commit history and nothing to mine.
    const cloneCall = calls.find((call) => subcommand(call.argv) === 'clone')
    expect(cloneCall?.argv).toEqual([
      'git',
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      REPO,
      result.path,
    ])

    const marker = readSnapshotMarker(result.path)
    expect(marker?.headSha).toBe(FULL_SHA)
    expect(marker?.repo).toBe(REPO)
    expect(marker?.filtered).toBe(true)
    expect(marker?.fetchedAt).not.toBe('')

    // The marker lives in `.git/`, not the worktree. A marker at the checkout root
    // would show up in `git status`, which would make the cleanliness check fail on
    // every snapshot this module had successfully created.
    expect(fs.existsSync(path.join(result.path, '.git', 'windbreak-snapshot.json'))).toBe(true)
    expect(fs.existsSync(path.join(result.path, 'windbreak-snapshot.json'))).toBe(false)
  })

  test('an abbreviated sha is accepted against the full HEAD', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, commitSha: SHORT_SHA, spawn })
    expect(result.headSha).toBe(FULL_SHA)
  })

  test('a HEAD that does not match the pinned revision is refused and discarded', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({
      head: 'ffffffffffffffffffffffffffffffffffffffff',
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const dir = path.join(into, `project-${FULL_SHA}`)
    await expect(clone({ into, spawn })).rejects.toThrow(/not the pinned revision/)
    // Keeping it would leave a directory that scans as the requested revision while
    // containing a different one.
    expect(fs.existsSync(dir)).toBe(false)
  })

  test('a failed clone is reported with git’s own reason and leaves nothing behind', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({
      clone: { exitCode: 128, stderr: 'fatal: repository not found' },
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    await expect(clone({ into, spawn })).rejects.toThrow(/repository not found/)
    expect(fs.existsSync(path.join(into, `project-${FULL_SHA}`))).toBe(false)
  })

  test('a revision the clone does not contain names the revision in the failure', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({
      checkout: { exitCode: 1, stderr: 'error: pathspec did not match' },
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    await expect(clone({ into, spawn })).rejects.toThrow(
      new RegExp(`could not check out ${FULL_SHA}`),
    )
  })

  test('a timed-out clone says so rather than reporting a git failure', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({ clone: { timedOut: true } })

    await expect(clone({ into, spawn })).rejects.toThrow(/timed out/)
  })

  test('the clone gets the generous default and the knob overrides it', async () => {
    const into = tempDir()
    const first = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })
    await clone({ into, spawn: first.spawn })
    expect(first.calls[0]!.timeoutMs).toBe(900_000)

    const second = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })
    await clone({ into: tempDir(), spawn: second.spawn, timeoutSeconds: 30 })
    expect(second.calls[0]!.timeoutMs).toBe(30_000)
  })

  test('a remote that ignores the filter is reported as a full clone, not a failure', async () => {
    const into = tempDir()
    const { spawn } = fakeGit({
      head: FULL_SHA,
      clone: { stderr: 'warning: filtering not recognized by server, ignoring' },
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn })

    // Still correct — a full clone has the history the miners need — but which fetch
    // happened is worth saying, since it changes how long the next one will take.
    expect(result.status).toBe('cloned')
    expect(result.filtered).toBe(false)

    // And it is *recorded*, because a later cache hit has no way to ask: the fetch
    // that knew the answer is over, so a default here would be a claim nobody checked.
    const cached = await clone({ into, spawn: fakeGit({ head: FULL_SHA }).spawn })
    expect(cached.status).toBe('cached')
    expect(cached.filtered).toBe(false)
  })
})

describe('ensureSnapshot — the cache', () => {
  test('a verified checkout is reused without cloning', async () => {
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    seedCachedSnapshot({ dir, head: FULL_SHA })
    const { spawn, calls } = fakeGit({ head: FULL_SHA })

    const result = await clone({ into, spawn })

    expect(result.status).toBe('cached')
    expect(result.headSha).toBe(FULL_SHA)
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(false)
  })

  test('a directory with no completion marker is refetched', async () => {
    // The marker is what distinguishes a finished fetch from one that was killed
    // halfway: `rev-parse` answers *something* about a partial clone, and that
    // something would be scanned.
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    const { spawn, calls } = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn })

    expect(result.status).toBe('cloned')
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(true)
  })

  test('a cache pinned to another revision is refetched', async () => {
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    seedCachedSnapshot({ dir, head: 'ffffffffffffffffffffffffffffffffffffffff' })
    const { spawn, calls } = fakeGit({
      head: 'ffffffffffffffffffffffffffffffffffffffff',
      headAfterClone: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn })

    expect(result.status).toBe('cloned')
    expect(result.headSha).toBe(FULL_SHA)
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(true)
  })

  test('a modified checkout is refetched, because it is no longer that revision', async () => {
    // A scan records the revision it saw and asserts a clean tree. A snapshot edited
    // in place is still pinned to the right commit and no longer contains its code,
    // so the run's provenance would be wrong in a way `eval` could not show.
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    seedCachedSnapshot({ dir, head: FULL_SHA })
    const { spawn, calls } = fakeGit({
      head: FULL_SHA,
      status: ' M lib/a.c\n',
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn })

    expect(result.status).toBe('cloned')
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(true)
  })

  test('force refetches even a verified mirror-clean checkout', async () => {
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    seedCachedSnapshot({ dir, head: FULL_SHA })
    const { spawn, calls } = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })

    const result = await clone({ into, spawn, force: true })

    expect(result.status).toBe('cloned')
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(true)
  })

  test('a malformed marker is treated as no marker', async () => {
    const into = tempDir()
    const dir = path.join(into, `project-${FULL_SHA}`)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.git', 'windbreak-snapshot.json'), '{"project":42}')

    expect(readSnapshotMarker(dir)).toBeNull()

    const { spawn, calls } = fakeGit({
      head: FULL_SHA,
      onCreateClone: (dest) => fs.mkdirSync(path.join(dest, '.git'), { recursive: true }),
    })
    const result = await clone({ into, spawn })

    expect(result.status).toBe('cloned')
    expect(calls.some((call) => subcommand(call.argv) === 'clone')).toBe(true)
  })
})
