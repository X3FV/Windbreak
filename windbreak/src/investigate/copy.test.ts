import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createWorkingCopy, workingCopyId, WorkingCopyError } from './copy'

/**
 * The copy is the thing §20.30 allows a model to write to, so these tests are about
 * two properties rather than about copying: the copy holds the tree, and **the target
 * is not touched** — not its files and, because the rejected strategy was a `git
 * worktree`, not its metadata either.
 */
const roots: string[] = []

const makeTarget = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-copy-'))
  roots.push(dir)

  const target = path.join(dir, 'target')
  fs.mkdirSync(path.join(target, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(target, 'src', 'copy.c'), 'int main(void) { return 0; }\n')
  fs.writeFileSync(path.join(target, 'src', 'deep', 'util.c'), 'void util(void) {}\n')
  fs.writeFileSync(path.join(target, 'README.md'), '# target\n')

  // Excluded by recon's own list, and by the `.windbreak` rule.
  fs.mkdirSync(path.join(target, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(target, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  fs.mkdirSync(path.join(target, '.git'), { recursive: true })
  fs.writeFileSync(path.join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.mkdirSync(path.join(target, '.windbreak'), { recursive: true })
  fs.writeFileSync(path.join(target, '.windbreak', 'state.db'), 'not a copy\n')

  // A link that leaves the checkout: it must be copied *as a link*.
  fs.mkdirSync(path.join(dir, 'outside'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'outside', 'secret.txt'), 'not yours\n')
  fs.symlinkSync(path.join(dir, 'outside'), path.join(target, 'escape'))

  return target
}

const scratchFor = (target: string): string => path.join(target, '.windbreak', 'scratch', 'inv')

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('createWorkingCopy', () => {
  test('the copy holds the tree, including files in nested directories', () => {
    const target = makeTarget()
    const copy = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    expect(fs.readFileSync(path.join(copy.root, 'src', 'copy.c'), 'utf8')).toBe(
      'int main(void) { return 0; }\n',
    )
    expect(fs.readFileSync(path.join(copy.root, 'src', 'deep', 'util.c'), 'utf8')).toBe(
      'void util(void) {}\n',
    )
    expect(copy.root).not.toBe(fs.realpathSync(target))
  })

  test('the target is not written to — no file changes, and no new directory', () => {
    const target = makeTarget()
    const before = fs.readdirSync(target).sort()
    const headBefore = fs.readFileSync(path.join(target, '.git', 'HEAD'), 'utf8')

    createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    // `.windbreak/scratch` inside the target is new, which is the scratch convention
    // rather than the copy: the copy itself lives under it. No new *top-level* entry
    // appears, and the repository's own metadata is byte-identical — which is the test
    // a `git worktree` strategy would fail.
    expect(fs.readdirSync(target).sort()).toEqual(before)
    expect(fs.readFileSync(path.join(target, '.git', 'HEAD'), 'utf8')).toBe(headBefore)
    expect(fs.existsSync(path.join(target, '.git', 'worktrees'))).toBe(false)
  })

  test('directories recon ignores are skipped, and named', () => {
    const target = makeTarget()
    const copy = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    expect(fs.existsSync(path.join(copy.root, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(copy.root, '.git'))).toBe(false)
    expect(fs.existsSync(path.join(copy.root, '.windbreak'))).toBe(false)
    // Reported rather than silent: a copy missing a directory must not read as a copy
    // of a tree that had no such directory.
    expect(copy.excluded).toEqual(['.git', '.windbreak', 'node_modules'])
  })

  test('a symlink is copied as a link, never followed', () => {
    const target = makeTarget()
    const copy = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    const link = path.join(copy.root, 'escape')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    // And it still points where it pointed, which is why the workspace's containment
    // guard is what refuses a read *through* it.
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(path.join(path.dirname(target), 'outside')),
    )
  })

  test('files and bytes are counted, ignoring the excluded trees', () => {
    const target = makeTarget()
    const copy = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    // copy.c, util.c, README.md, and the escape symlink is not a file.
    expect(copy.files).toBe(3)
    expect(copy.bytes).toBe(
      'int main(void) { return 0; }\n'.length + 'void util(void) {}\n'.length + '# target\n'.length,
    )
  })

  test('the base commit and the strategy are recorded, and a non-repository has none', () => {
    const target = makeTarget()
    const pinned = createWorkingCopy({
      targetDir: target,
      scratchDir: scratchFor(target),
      commitSha: 'abc123',
    })
    expect(pinned.baseCommit).toBe('abc123')
    expect(pinned.strategy).toBe('filtered-copy')

    // NULL rather than a guess, which is §18 in the copy's own header.
    const unpinned = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })
    expect(unpinned.baseCommit).toBeNull()
  })

  test('an existing copy is replaced rather than edited in place', () => {
    const target = makeTarget()
    const first = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    // A model's edit, of the kind the copy exists to hold.
    fs.writeFileSync(path.join(first.root, 'src', 'copy.c'), 'PATCHED\n')
    // And a file the target does not have, to prove the directory was not reused.
    fs.writeFileSync(path.join(first.root, 'stale.txt'), 'stale\n')

    const second = createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) })

    expect(fs.readFileSync(path.join(second.root, 'src', 'copy.c'), 'utf8')).toBe(
      'int main(void) { return 0; }\n',
    )
    expect(fs.existsSync(path.join(second.root, 'stale.txt'))).toBe(false)
  })

  test('a copy root inside the target is fine, and an ancestor of it is refused', () => {
    const target = makeTarget()

    // The normal case: the copy sits under the target's own `.windbreak`, so the root
    // contains no part of the target. It must not be refused.
    expect(() =>
      createWorkingCopy({ targetDir: target, scratchDir: scratchFor(target) }),
    ).not.toThrow()

    // The catastrophic case: a target that already lives under a `working-copy`
    // directory, so the copy's root is an *ancestor* of the evidence and removing it
    // would remove the target. Refused before any rm runs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-copy-'))
    roots.push(dir)
    const nested = path.join(dir, 'scratch', 'working-copy', 'target')
    fs.mkdirSync(nested, { recursive: true })

    expect(() =>
      createWorkingCopy({ targetDir: nested, scratchDir: path.join(dir, 'scratch') }),
    ).toThrow(WorkingCopyError)
    // And it is still there, which is the point of refusing rather than cleaning up.
    expect(fs.existsSync(nested)).toBe(true)
  })

  test('the id is a function of the root, the revision and the time', () => {
    const input = { root: '/repo/copy', baseCommit: 'abc', createdAt: '2026-09-13T00:00:00.000Z' }
    expect(workingCopyId(input)).toBe(workingCopyId(input))
    expect(workingCopyId(input)).not.toBe(
      workingCopyId({ ...input, createdAt: '2026-09-13T00:00:01.000Z' }),
    )
    expect(workingCopyId(input)).not.toBe(workingCopyId({ ...input, baseCommit: 'def' }))
  })
})
