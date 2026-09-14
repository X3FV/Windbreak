import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { checkDirty, readGitRefs } from './git'

const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'

let root: string

const write = (relativePath: string, contents: string): void => {
  const absolutePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, contents)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-git-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readGitRefs', () => {
  test('reports no repository when there is no .git', () => {
    const state = readGitRefs(root)

    expect(state.isRepository).toBe(false)
    expect(state.commitSha).toBeNull()
  })

  test('resolves an attached HEAD through a loose ref', () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write(`.git/refs/heads/main`, `${SHA}\n`)

    const state = readGitRefs(root)

    expect(state.isRepository).toBe(true)
    expect(state.commitSha).toBe(SHA)
    expect(state.branch).toBe('main')
    expect(state.detached).toBe(false)
  })

  test('resolves an attached HEAD through packed-refs', () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write('.git/packed-refs', `# pack-refs with: peeled fully-peeled\n${SHA} refs/heads/main\n`)

    const state = readGitRefs(root)

    expect(state.commitSha).toBe(SHA)
    expect(state.branch).toBe('main')
  })

  test('skips peeled tag lines in packed-refs', () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write(
      '.git/packed-refs',
      `1111111111111111111111111111111111111111 refs/tags/v1\n^${SHA}\n${SHA} refs/heads/main\n`,
    )

    expect(readGitRefs(root).commitSha).toBe(SHA)
  })

  test('handles a detached HEAD', () => {
    write('.git/HEAD', `${SHA}\n`)

    const state = readGitRefs(root)

    expect(state.commitSha).toBe(SHA)
    expect(state.branch).toBeNull()
    expect(state.detached).toBe(true)
  })

  test('follows a .git file pointer, as worktrees use', () => {
    // A real worktree keeps its gitdir outside the tree, so the pointer target
    // cannot live under `.git` (which is a file here).
    write('.git', 'gitdir: gitstore/wb\n')
    write('gitstore/wb/HEAD', 'ref: refs/heads/topic\n')
    write('gitstore/wb/refs/heads/topic', `${SHA}\n`)

    const state = readGitRefs(root)

    expect(state.commitSha).toBe(SHA)
    expect(state.branch).toBe('topic')
  })

  test('warns instead of guessing when HEAD holds no commit', () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')

    const state = readGitRefs(root)

    expect(state.commitSha).toBeNull()
    expect(state.warnings.join(' ')).toMatch(/Could not resolve/)
  })

  test('never runs git, so an untrusted .git/config cannot execute anything', () => {
    // A repo whose config would run a command via fsmonitor. Resolution reads
    // files only, so it must still succeed without touching the hook.
    write('.git/config', '[core]\n\tfsmonitor = /bin/false\n')
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write('.git/refs/heads/main', `${SHA}\n`)

    const state = readGitRefs(root)

    expect(state.commitSha).toBe(SHA)
    expect(state.warnings).toEqual([])
  })
})

describe('checkDirty', () => {
  test('reports dirty when git lists changes', async () => {
    const result = await checkDirty(async () => ({
      exitCode: 0,
      stdout: ' M src/main.c\n',
    }))

    expect(result.dirty).toBe(true)
    expect(result.warning).toBeNull()
  })

  test('reports clean on empty output', async () => {
    const result = await checkDirty(async () => ({ exitCode: 0, stdout: '' }))

    expect(result.dirty).toBe(false)
  })

  test('passes hardening flags that stop fsmonitor executing', async () => {
    let seen: string[] = []
    await checkDirty(async (args) => {
      seen = args
      return { exitCode: 0, stdout: '' }
    })

    expect(seen).toContain('--no-optional-locks')
    expect(seen.join(' ')).toContain('core.fsmonitor=false')
  })

  test('returns unknown, never clean, when git cannot run', async () => {
    const failed = await checkDirty(async () => {
      throw new Error('no sandbox')
    })

    expect(failed.dirty).toBeNull()
    expect(failed.warning).toMatch(/Could not determine/)
  })

  test('returns unknown when git exits non-zero', async () => {
    const result = await checkDirty(async () => ({ exitCode: 128, stdout: '' }))

    expect(result.dirty).toBeNull()
  })
})
