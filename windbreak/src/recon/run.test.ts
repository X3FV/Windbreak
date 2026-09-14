import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'
import { createTargetId, inferScopeClass, runRecon } from './run'

let root: string

const write = (relativePath: string, contents: string): void => {
  const absolutePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, contents)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-recon-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('createTargetId', () => {
  test('is stable for the same location and commit', () => {
    expect(createTargetId('/src/a', 'abc')).toBe(createTargetId('/src/a', 'abc'))
  })

  test('differs across commits and across locations', () => {
    expect(createTargetId('/src/a', 'abc')).not.toBe(createTargetId('/src/a', 'def'))
    expect(createTargetId('/src/a', 'abc')).not.toBe(createTargetId('/src/b', 'abc'))
  })

  test('handles a null commit', () => {
    expect(createTargetId('/src/a', null)).toHaveLength(16)
  })
})

describe('inferScopeClass', () => {
  const languages = (ids: string[]) =>
    ids.map((language) => ({ language, fileCount: 1, bytes: 1 }))

  test('detects a kernel tree from Kconfig', () => {
    expect(
      inferScopeClass([{ path: 'Kconfig' }, { path: 'init/main.c' }], languages(['c'])),
    ).toBe('kernel')
  })

  test('detects a kernel tree from its directory layout', () => {
    expect(
      inferScopeClass([{ path: 'drivers/net/foo.c' }], languages(['c'])),
    ).toBe('kernel')
  })

  test('classifies C/C++ code outside a kernel tree as userspace-c', () => {
    expect(inferScopeClass([{ path: 'src/main.c' }], languages(['c']))).toBe(
      'userspace-c',
    )
  })

  test('classifies a non-C target as an app', () => {
    expect(
      inferScopeClass([{ path: 'src/index.ts' }], languages(['typescript'])),
    ).toBe('app')
  })
})

describe('runRecon', () => {
  const reconOptions = { build: false, checkWorkingTree: false } as const

  test('produces a Target record with pinned commit, languages, and scope', async () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write('.git/refs/heads/main', `${'a'.repeat(40)}\n`)
    write('Kconfig', 'config FOO\n')
    write('drivers/net/foo.c', 'int foo(void) { return 0; }\n')

    const result = await runRecon({ target: root, ...reconOptions })

    expect(result.target.commitSha).toBe('a'.repeat(40))
    expect(result.target.scopeClass).toBe('kernel')
    expect(result.target.buildModel).toBe('best-effort')
    expect(result.target.languages.map((entry) => entry.language)).toContain('c')
    expect(result.inventory.fileCount).toBeGreaterThan(0)
  })

  test('flags a requested commit that does not match HEAD', async () => {
    write('.git/HEAD', 'ref: refs/heads/main\n')
    write('.git/refs/heads/main', `${'a'.repeat(40)}\n`)
    write('main.c', 'int main(void){return 0;}\n')

    const result = await runRecon({
      target: root,
      commit: 'b'.repeat(40),
      ...reconOptions,
    })

    expect(result.target.commitSha).toBe('b'.repeat(40))
    expect(result.warnings.join(' ')).toMatch(/does not|is at/)
  })

  test('warns when the target cannot be pinned to a commit', async () => {
    write('main.c', 'int main(void){return 0;}\n')

    const result = await runRecon({ target: root, ...reconOptions })

    expect(result.target.commitSha).toBe('unknown')
    expect(result.warnings.join(' ')).toMatch(/not pinned/)
  })

  test('persists the target and program model when a database is given', async () => {
    const db = new Database(':memory:')
    applySchema(db)
    write('main.c', 'int helper(int x){return x;}\nint main(void){return helper(1);}\n')
    write('deps/requirements.txt', 'requests==1.0.0\n')

    const result = await runRecon({ target: root, ...reconOptions, db })

    const targetRow = db
      .query<{ id: string; scope_class: string; build_model: string }, []>(
        'SELECT id, scope_class, build_model FROM targets',
      )
      .get()

    expect(targetRow?.id).toBe(result.target.id)
    expect(targetRow?.scope_class).toBe('userspace-c')

    const symbols = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM symbols')
      .get()!.n
    expect(symbols).toBe(2)

    expect(result.dependencyManifests.map((entry) => entry.path)).toEqual([
      'deps/requirements.txt',
    ])

    db.close()
  })

  test('re-running recon keeps the OSV correlation rows attached to the target', async () => {
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    write('deps/requirements.txt', 'requests==1.0.0\n')

    const first = await runRecon({ target: root, ...reconOptions, db })

    // Simulate the §4.2 stage having run for this target.
    db.prepare(
      `INSERT INTO dependencies (id, target_id, ecosystem, name, version, exact, queryable, manifest_path)
       VALUES ('dep-1', ?, 'PyPI', 'requests', '1.0.0', 1, 1, 'deps/requirements.txt')`,
    ).run(first.target.id)
    db.prepare('UPDATE targets SET osv_status = ? WHERE id = ?').run(
      'complete',
      first.target.id,
    )

    await runRecon({ target: root, ...reconOptions, db })

    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM dependencies').get()!.n,
    ).toBe(1)
    expect(
      db
        .query<{ osv_status: string | null }, []>('SELECT osv_status FROM targets')
        .get()!.osv_status,
    ).toBe('complete')

    db.close()
  })

  test('reports an unresolvable target rather than scanning nothing', async () => {
    await expect(
      runRecon({ target: path.join(root, 'missing'), ...reconOptions }),
    ).rejects.toThrow(/not a directory/)
  })
})
