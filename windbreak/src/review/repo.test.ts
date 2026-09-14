import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { readRepoCodebase, resolveRepoRoot } from './repo'

/**
 * §20.31's two answers, tested without a database.
 *
 * Both functions are pure filesystem work, which is the reason they are separate from
 * `session.ts`: the fallback listing is checkable without a queue, an engine, or a
 * renderer, and neither of these decides anything about a finding.
 */

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wb-root-'))

describe('resolveRepoRoot (§20.31)', () => {
  test('walks up to the git root from a subdirectory', () => {
    const root = makeTempDir()
    fs.mkdirSync(path.join(root, '.git'), { recursive: true })
    const nested = path.join(root, 'src', 'deep', 'deeper')
    fs.mkdirSync(nested, { recursive: true })

    // The whole reason this exists: the screen opened from `src/deep/deeper` must list
    // the repository, not the three files under the cursor.
    expect(resolveRepoRoot(nested)).toBe(fs.realpathSync(root))

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('treats a .git file as a root, so a worktree and a submodule resolve too', () => {
    // `.git` is a file in both cases, and checking its *presence* rather than its type
    // is what keeps this from silently walking past the checkout to its parent.
    const root = makeTempDir()
    const nested = path.join(root, 'vendor', 'lib')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/worktrees/thing\n')

    expect(resolveRepoRoot(nested)).toBe(fs.realpathSync(root))

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('with no repository anywhere, the directory it was pointed at is the answer', () => {
    // A vendored tarball or an exported tree: §20.21 already records that both history
    // miners degrade to nothing on these, and treating "no repository" as "no codebase"
    // would be the same mistake in the pane. What it must *not* be is the walk's last
    // stop — looping to `/` would list the whole filesystem in a pane pointed at one
    // checkout, which is the failure this test exists for.
    const root = makeTempDir()
    const src = path.join(root, 'src')
    fs.mkdirSync(src, { recursive: true })

    expect(resolveRepoRoot(src)).toBe(fs.realpathSync(src))

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('the nearest root wins, not the outermost', () => {
    const outer = makeTempDir()
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true })
    const inner = path.join(outer, 'nested-checkout')
    fs.mkdirSync(path.join(inner, '.git'), { recursive: true })
    const deep = path.join(inner, 'src')
    fs.mkdirSync(deep, { recursive: true })

    expect(resolveRepoRoot(deep)).toBe(fs.realpathSync(inner))

    fs.rmSync(outer, { recursive: true, force: true })
  })

  test('a path that does not exist resolves rather than throwing', () => {
    // The walk is also used before anything is read, and a throw here would be a crash
    // on the way to drawing the queue — which is exactly what §20.28 undid.
    const root = makeTempDir()
    const missing = path.join(root, 'not', 'there')

    expect(resolveRepoRoot(missing)).toBe(missing)

    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('readRepoCodebase (§20.31)', () => {
  test('it is a filesystem walk, labelled as one', () => {
    const root = makeTempDir()
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'handler.c'), 'int main(void) { return 0; }\n')
    fs.writeFileSync(path.join(root, 'README.md'), '# hi\n')

    const codebase = readRepoCodebase(root)

    expect(codebase.source).toBe('filesystem')
    expect(codebase.location).toBe(root)
    expect(codebase.commitSha).toBeNull()
    expect(codebase.truncated).toBe(false)
    // Forward-slash relative paths, because that is how every stage names a file and how
    // a candidate's `filePath` reads — a walk that named them differently would make the
    // two listings look like two different repositories.
    expect(codebase.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'src/handler.c',
    ])

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('the ignore rules are recon’s, so both sources agree on what a source file is', () => {
    const root = makeTempDir()
    fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true })
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
    fs.writeFileSync(path.join(root, '.git', 'objects', 'blob'), 'x\n')
    fs.writeFileSync(path.join(root, 'src', 'handler.c'), 'int x;\n')

    const paths = readRepoCodebase(root).files.map((file) => file.path)

    expect(paths).toEqual(['src/handler.c'])

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a binary is marked and carries no language', () => {
    const root = makeTempDir()
    // A NUL byte in the first kilobyte is recon's own heuristic, and this source reuses
    // it rather than inventing a second one.
    fs.writeFileSync(path.join(root, 'blob'), Buffer.from([0x00, 0x01, 0x02, 0x00]))
    fs.writeFileSync(path.join(root, 'app.c'), 'int x;\n')

    const files = readRepoCodebase(root).files

    expect(files.find((file) => file.path === 'blob')!.binary).toBe(true)
    expect(files.find((file) => file.path === 'blob')!.language).toBeNull()
    expect(files.find((file) => file.path === 'app.c')!.binary).toBe(false)
    expect(files.find((file) => file.path === 'app.c')!.language).toBe('c')

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('the walk is capped, and says so', () => {
    // A partial listing that reads as complete is the failure the pane's row cap guards
    // against one level down; this is the same rule for the walk itself.
    const root = makeTempDir()
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(root, `file-${index}.c`), `int v${index};\n`)
    }

    const codebase = readRepoCodebase(root, { maxFiles: 3 })

    expect(codebase.source).toBe('filesystem')
    expect(codebase.files).toHaveLength(3)
    expect(codebase.truncated).toBe(true)

    fs.rmSync(root, { recursive: true, force: true })
  })
})
