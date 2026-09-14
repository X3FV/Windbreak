import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'
import { buildProgramModel } from './program-model'

import type { FileEntry } from './inventory'

const file = (relativePath: string, contents: string): FileEntry => ({
  path: relativePath,
  absolutePath: `/virtual/${relativePath}`,
  bytes: Buffer.byteLength(contents),
  language: relativePath.endsWith('.c') ? 'c' : null,
  binary: false,
})

const SOURCES: Record<string, string> = {
  'src/main.c': 'int helper(int x) { return x; }\nint main(void) { return helper(1); }\n',
  'src/util.c': 'struct point { int x; };\n',
}

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  // Match production: `openStateDatabase` turns foreign keys on, so the child
  // rows written here must genuinely satisfy the target foreign key.
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    'target-1',
    '/virtual',
  )
})

const run = () =>
  buildProgramModel({
    db,
    targetId: 'target-1',
    files: [file('src/main.c', SOURCES['src/main.c']!), file('src/util.c', SOURCES['src/util.c']!)],
    readSource: (absolutePath) =>
      SOURCES[absolutePath.replace('/virtual/', '')] ?? '',
  })

const count = (table: string): number =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n

describe('buildProgramModel', () => {
  test('indexes every file in the inventory table', async () => {
    await run()

    expect(count('recon_files')).toBe(2)
  })

  test('extracts symbols and references', async () => {
    const result = await run()

    expect(result.filesParsed).toBe(2)
    expect(result.symbols).toBe(3) // helper, main, point
    expect(result.references).toBe(1) // helper(1)
    expect(result.parseFailures).toBe(0)
  })

  test('persists symbol rows with kind, scope, and location', async () => {
    await run()

    const helper = db
      .query<{ kind: string; file_path: string; start_line: number }, []>(
        `SELECT kind, file_path, start_line FROM symbols WHERE name = 'helper'`,
      )
      .get()

    expect(helper).toEqual({ kind: 'function', file_path: 'src/main.c', start_line: 1 })
  })

  test('persists reference rows', async () => {
    await run()

    const ref = db
      .query<{ name: string; kind: string; line: number }, []>(
        `SELECT name, kind, line FROM symbol_refs`,
      )
      .get()

    expect(ref).toEqual({ name: 'helper', kind: 'call', line: 2 })
  })

  test('is idempotent: re-running replaces rows rather than duplicating', async () => {
    await run()
    const first = { symbols: count('symbols'), refs: count('symbol_refs') }

    await run()

    expect(count('symbols')).toBe(first.symbols)
    expect(count('symbol_refs')).toBe(first.refs)
  })

  test('skips files over the size cap and reports the count', async () => {
    const result = await buildProgramModel({
      db,
      targetId: 'target-1',
      files: [file('src/big.c', 'x'.repeat(100))],
      maxFileBytes: 10,
      readSource: () => 'int main(void){}',
    })

    expect(result.tooLarge).toBe(1)
    expect(result.filesParsed).toBe(0)
  })

  test('stops at the parse cap and warns that the index is partial', async () => {
    const result = await buildProgramModel({
      db,
      targetId: 'target-1',
      files: Object.keys(SOURCES).map((key) => file(key, SOURCES[key]!)),
      maxFilesToParse: 1,
      readSource: (absolutePath) => SOURCES[absolutePath.replace('/virtual/', '')] ?? '',
    })

    expect(result.filesParsed).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/partial/)
  })

  test('counts an unreadable file instead of aborting the target', async () => {
    const result = await buildProgramModel({
      db,
      targetId: 'target-1',
      files: [file('src/main.c', '')],
      readSource: () => {
        throw new Error('EACCES')
      },
    })

    expect(result.parseFailures).toBe(1)
    expect(result.filesParsed).toBe(0)
  })

  test('counts unsupported languages so they are visible, not silent', async () => {
    const result = await buildProgramModel({
      db,
      targetId: 'target-1',
      files: [
        { ...file('src/legacy.php', ''), language: 'php' },
        { ...file('build.sh', ''), language: 'shell' },
        file('src/main.c', SOURCES['src/main.c']!),
      ],
      readSource: (absolutePath) => SOURCES[absolutePath.replace('/virtual/', '')] ?? '',
    })

    expect(result.unsupportedFiles).toBe(2)
    // Named, not just counted: "2 files unsupported" is not actionable and
    // "php, shell" is. Rust and TypeScript used to be in this list and are not
    // any more, which is the whole point of deriving it rather than pinning it.
    expect(result.unsupportedLanguages).toEqual(['php', 'shell'])
    expect(result.warnings.some((w) => w.includes('php, shell'))).toBe(true)
  })

  test('a supported multi-language tree indexes methods, not just functions', async () => {
    const result = await buildProgramModel({
      db,
      targetId: 'target-1',
      files: [
        { ...file('src/greeter.py', ''), language: 'python' },
        { ...file('src/greeter.ts', ''), language: 'typescript' },
      ],
      readSource: (absolutePath) =>
        absolutePath.endsWith('.py')
          ? 'class G:\n    def hello(self):\n        return 1\n'
          : 'class G { hello(): number { return 1 } }\n',
    })

    const kinds = db
      .query<{ kind: string }, [string]>(
        `SELECT kind FROM symbols WHERE target_id = ? ORDER BY kind`,
      )
      .all('target-1')
      .map((row) => row.kind)

    // The claim under test is that a Python `def` inside a class and a
    // TypeScript class method are both `method` — not `function`. A literal
    // `kind = 'function'` in any of the four region sweeps would find neither.
    expect(kinds).toEqual(['class', 'class', 'method', 'method'])
    expect(kinds).not.toContain('function')
    expect(result.unsupportedLanguages).toEqual([])
  })
})
