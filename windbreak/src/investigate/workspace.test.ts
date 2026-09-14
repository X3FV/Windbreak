import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createWorkingCopy } from './copy'
import { PatchError } from './patch'
import {
  CopyEditError,
  createInvestigatorWorkspace,
  OutsideTargetError,
  resolveInTarget,
} from './workspace'

/**
 * Confinement is the security boundary of §20.29, so it is tested against a real
 * filesystem rather than a mocked one. A guard that is only ever exercised
 * through its own abstraction proves that it calls itself.
 */
const roots: string[] = []

const makeTarget = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-investigate-'))
  roots.push(dir)
  fs.mkdirSync(path.join(dir, 'target', 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'target', 'src', 'copy.c'), 'int main() {}\n')
  fs.mkdirSync(path.join(dir, 'outside'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'not yours\n')
  // The case `path.resolve` cannot see: a link inside the checkout that leaves it.
  fs.symlinkSync(path.join(dir, 'outside'), path.join(dir, 'target', 'escape'))
  return path.join(dir, 'target')
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveInTarget', () => {
  test('resolves a relative path inside the target', () => {
    const root = makeTarget()
    expect(resolveInTarget(root, 'src/copy.c')).toBe(
      path.join(fs.realpathSync(root), 'src', 'copy.c'),
    )
  })

  test('accepts an absolute path that is inside the target', () => {
    const root = makeTarget()
    expect(resolveInTarget(root, path.join(root, 'src', 'copy.c'))).toBe(
      path.join(fs.realpathSync(root), 'src', 'copy.c'),
    )
  })

  test('resolves the root itself without refusing it', () => {
    const root = makeTarget()
    expect(resolveInTarget(root, '.')).toBe(fs.realpathSync(root))
  })

  test('refuses a parent-traversal escape', () => {
    const root = makeTarget()
    expect(() => resolveInTarget(root, '../outside/secret.txt')).toThrow(
      OutsideTargetError,
    )
  })

  test('refuses an absolute path outside the target', () => {
    const root = makeTarget()
    expect(() => resolveInTarget(root, '/etc/passwd')).toThrow(OutsideTargetError)
  })

  test('refuses a symlink that leaves the target', () => {
    // The reason the check is on the real path: this one reads as inside.
    const root = makeTarget()
    expect(() => resolveInTarget(root, 'escape/secret.txt')).toThrow(
      OutsideTargetError,
    )
  })

  test('refuses a nonexistent path under a symlinked ancestor', () => {
    // Nothing exists at the end of it, so a guard that only checked when the
    // path resolved would let this through and the read would decide.
    const root = makeTarget()
    expect(() => resolveInTarget(root, 'escape/nothing-here')).toThrow(
      OutsideTargetError,
    )
  })

  test('resolves a nonexistent path inside the target', () => {
    // A missing file is a normal question from a model; it must fail as a read
    // (null), not as a refusal, or the two conditions become indistinguishable.
    const root = makeTarget()
    expect(resolveInTarget(root, 'src/nothing.c')).toBe(
      path.join(fs.realpathSync(root), 'src', 'nothing.c'),
    )
  })

  test('refuses a sibling directory whose name shares the target prefix', () => {
    // `startsWith(root)` without a separator passes this, which is the bug the
    // separator is for.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-investigate-'))
    roots.push(dir)
    fs.mkdirSync(path.join(dir, 'target'))
    fs.mkdirSync(path.join(dir, 'target-elsewhere'))
    fs.writeFileSync(path.join(dir, 'target-elsewhere', 'secret.txt'), 'no\n')
    const root = path.join(dir, 'target')

    expect(() => resolveInTarget(root, '../target-elsewhere/secret.txt')).toThrow(
      OutsideTargetError,
    )
  })
})

describe('the workspace', () => {
  const workspaceFor = async (root: string) =>
    createInvestigatorWorkspace({
      targetDir: root,
      scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-scratch-')),
    })

  test('reads inside the target and reports a missing file as null', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    expect(workspace.readFile('src/copy.c')).toBe('int main() {}\n')
    expect(workspace.readFile('src/nothing.c')).toBeNull()
    expect(workspace.readFile('src')).toBeNull()
  })

  test('refuses a read outside the target', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    expect(() => workspace.readFile('escape/secret.txt')).toThrow(
      OutsideTargetError,
    )
    expect(() => workspace.readFile('../outside/secret.txt')).toThrow(
      OutsideTargetError,
    )
  })

  test('lists a directory, sorted, marking directories and links', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    // `escape` is a link to a directory, and it is reported as a link: calling it
    // a directory would promise a listing `readdir` then refuses, and calling it
    // a plain file would hide the one entry worth looking at.
    expect(workspace.readdir('.')).toEqual([
      { name: 'escape', directory: false, symlink: true },
      { name: 'src', directory: true, symlink: false },
    ])
    expect(workspace.readdir('src')).toEqual([
      { name: 'copy.c', directory: false, symlink: false },
    ])
    expect(workspace.readdir('src/copy.c')).toEqual([])
    expect(workspace.readdir('nowhere')).toEqual([])
  })

  test('refuses to list a directory reached through an escaping link', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    expect(() => workspace.readdir('escape')).toThrow(OutsideTargetError)
  })

  test('stats inside the target and refuses outside it', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    expect(workspace.statFile('src/copy.c')).toEqual({
      size: 'int main() {}\n'.length,
      directory: false,
    })
    expect(workspace.statFile('src')).toEqual({
      size: expect.any(Number),
      directory: true,
    })
    expect(workspace.statFile('nowhere')).toBeNull()
    expect(() => workspace.statFile('escape/secret.txt')).toThrow(
      OutsideTargetError,
    )
  })

  test('the escape refusal names the target so the model can correct itself', async () => {
    const root = makeTarget()
    const workspace = await workspaceFor(root)

    expect(() => workspace.resolve('/etc/passwd')).toThrow(
      new RegExp(fs.realpathSync(root).replace(/[/\\]/g, '.')),
    )
  })
})

/**
 * The writable copy is a **third root** (§20.30), and the tests below are about the
 * property that makes it safe: the target's confinement and the copy's are separate
 * promises, so a write that escapes the copy is refused *for the copy's reason* and
 * cannot be talked into being a target read.
 */
describe('the working copy (§20.30)', () => {
  const copyWorkspaceFor = async (root: string) => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-scratch-'))
    const copy = createWorkingCopy({ targetDir: root, scratchDir })
    // `createWorkingCopy` recreates the tree, so re-create the fixture files the copy
    // must hold rather than relying on the ones `makeTarget` wrote after it.
    return createInvestigatorWorkspace({ targetDir: root, scratchDir, copy })
  }

  test('with no copy the copy operations say so rather than reading the target', async () => {
    const root = makeTarget()
    const workspace = await createInvestigatorWorkspace({
      targetDir: root,
      scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-scratch-')),
    })

    expect(workspace.copy).toBeNull()
    expect(() => workspace.resolveInCopy('src/copy.c')).toThrow(CopyEditError)
    expect(() => workspace.writeCopyFile('src/copy.c', 'x')).toThrow(CopyEditError)
    // Async, so the refusal is a rejected promise rather than a synchronous throw a
    // caller might not be able to catch around an `await`.
    await expect(workspace.runInCopy(['true'])).rejects.toThrow(CopyEditError)
  })

  test('a write lands in the copy and leaves the target byte-identical', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)

    const result = workspace.writeCopyFile('src/copy.c', 'int main(void) { return 1; }\n')

    expect(result.action).toBe('update')
    expect(result.path).toBe('src/copy.c')
    expect(workspace.readCopyFile('src/copy.c')).toBe('int main(void) { return 1; }\n')
    // The property §20.30 is arranged around.
    expect(fs.readFileSync(path.join(root, 'src', 'copy.c'), 'utf8')).toBe('int main() {}\n')
  })

  test('a new file is created, and the directories on the way are made', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)

    const result = workspace.writeCopyFile('poc/harness/trigger.c', 'int main(void) { return 0; }\n')
    expect(result.action).toBe('create')
    expect(workspace.readCopyFile('poc/harness/trigger.c')).toBe('int main(void) { return 0; }\n')
  })

  test('a write that escapes the copy is refused, and the refusal names the copy', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)

    expect(() => workspace.writeCopyFile('../outside/secret.txt', 'owned')).toThrow(
      CopyEditError,
    )
    expect(() => workspace.writeCopyFile('/etc/passwd', 'owned')).toThrow(CopyEditError)
    // Through the symlink that leaves the checkout, which reads as inside it.
    expect(() => workspace.writeCopyFile('escape/secret.txt', 'owned')).toThrow(CopyEditError)
    expect(fs.readFileSync(path.join(path.dirname(root), 'outside', 'secret.txt'), 'utf8')).toBe(
      'not yours\n',
    )
  })

  test('the copy refusal is worded for the copy, not for the target', async () => {
    // A model told "outside the target" would go looking at the evidence for a path it
    // tried to write in the copy.
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)

    expect(() => workspace.resolveInCopy('../../etc')).toThrow(/working copy/)
  })

  test('writing over a directory is refused rather than turned into a file', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)

    expect(() => workspace.writeCopyFile('src', 'x')).toThrow(CopyEditError)
  })

  test('replace changes a unique occurrence and reports what it did', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'strcpy(dst, src);\nreturn 0;\n')

    const result = workspace.replaceInCopy('a.c', 'strcpy(dst, src);', 'strncpy(dst, src, 8);')
    expect(result.path).toBe('a.c')
    expect(workspace.readCopyFile('a.c')).toBe('strncpy(dst, src, 8);\nreturn 0;\n')
  })

  test('replace refuses text that is absent, and writes nothing', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'int x;\n')

    expect(() => workspace.replaceInCopy('a.c', 'not here', 'x')).toThrow(CopyEditError)
    expect(workspace.readCopyFile('a.c')).toBe('int x;\n')
  })

  test('replace refuses an ambiguous match unless replaceAll says otherwise', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'x;\nx;\n')

    // "Replace the first of two" is not an edit a model can reason about.
    expect(() => workspace.replaceInCopy('a.c', 'x;', 'y;')).toThrow(CopyEditError)
    expect(workspace.readCopyFile('a.c')).toBe('x;\nx;\n')

    workspace.replaceInCopy('a.c', 'x;', 'y;', { replaceAll: true })
    expect(workspace.readCopyFile('a.c')).toBe('y;\ny;\n')
  })

  test('replace on a file that is not there is refused as missing', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    expect(() => workspace.replaceInCopy('nope.c', 'a', 'b')).toThrow(/no file at/)
  })

  test('a patch applies across several files', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'one\ntwo\n')
    workspace.writeCopyFile('b.c', 'three\nfour\n')

    const results = workspace.applyPatchInCopy(
      [
        '--- a/a.c',
        '+++ b/a.c',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+TWO',
        '--- a/b.c',
        '+++ b/b.c',
        '@@ -1,2 +1,2 @@',
        ' three',
        '-four',
        '+FOUR',
      ].join('\n'),
    )

    expect(results.map((result) => result.path)).toEqual(['a.c', 'b.c'])
    expect(results[0]?.inserted).toBe(1)
    expect(results[0]?.removed).toBe(1)
    expect(workspace.readCopyFile('a.c')).toBe('one\nTWO\n')
    expect(workspace.readCopyFile('b.c')).toBe('three\nFOUR\n')
  })

  test('a patch is all-or-nothing: one bad hunk leaves every file untouched', async () => {
    // A half-applied patch leaves the copy in a state that is neither the original nor
    // the model's intent, and the model's next step would reason about it.
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'one\ntwo\n')
    workspace.writeCopyFile('b.c', 'three\nfour\n')

    expect(() =>
      workspace.applyPatchInCopy(
        [
          '--- a/a.c',
          '+++ b/a.c',
          '@@ -1,2 +1,2 @@',
          ' one',
          '-two',
          '+TWO',
          '--- a/b.c',
          '+++ b/b.c',
          '@@ -1,2 +1,2 @@',
          ' NOT IN THIS FILE',
          '-four',
          '+FOUR',
        ].join('\n'),
      ),
    ).toThrow(PatchError)

    // `a.c` was patched in phase 1 and must not have been written.
    expect(workspace.readCopyFile('a.c')).toBe('one\ntwo\n')
    expect(workspace.readCopyFile('b.c')).toBe('three\nfour\n')
  })

  test('a patch that creates a file which already exists is refused', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('a.c', 'here\n')

    expect(() =>
      workspace.applyPatchInCopy(
        ['--- /dev/null', '+++ b/a.c', '@@ -0,0 +1,1 @@', '+other'].join('\n'),
      ),
    ).toThrow(/already exists/)
    expect(workspace.readCopyFile('a.c')).toBe('here\n')
  })

  test('a patch deleting a file that is not there is refused', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    expect(() =>
      workspace.applyPatchInCopy(
        ['--- a/gone.c', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-x'].join('\n'),
      ),
    ).toThrow(/does not exist/)
  })

  test('the copy lists its own entries, separately from the target', async () => {
    const root = makeTarget()
    const workspace = await copyWorkspaceFor(root)
    workspace.writeCopyFile('added.c', 'x\n')

    const copyNames = workspace.readdirCopy('.').map((entry) => entry.name)
    expect(copyNames).toContain('added.c')
    // A file written only to the copy is not in the target's listing.
    expect(workspace.readdir('.').map((entry) => entry.name)).not.toContain('added.c')
  })
})
