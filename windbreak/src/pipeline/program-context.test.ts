import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'
import { createProgramContext } from './program-context'

import type { PipelineProgramContext } from './program-context'

let db: Database
let context: PipelineProgramContext

const seedSymbol = (input: {
  name: string
  startLine: number
  endLine: number
  kind?: string
  filePath?: string
}) => {
  const filePath = input.filePath ?? 'src/handler.c'
  db.prepare(
    `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
     VALUES (?, 'target-1', ?, ?, NULL, ?, ?, ?, 'c')`,
  ).run(
    `target-1:${filePath}:${input.kind ?? 'function'}:${input.name}:${input.startLine}`,
    filePath,
    input.name,
    input.kind ?? 'function',
    input.startLine,
    input.endLine,
  )
}

const seedRef = (input: { name: string; line: number; filePath?: string }) => {
  const filePath = input.filePath ?? 'src/handler.c'
  db.prepare(
    `INSERT INTO symbol_refs (id, target_id, file_path, name, kind, line, language)
     VALUES (?, 'target-1', ?, ?, 'call', ?, 'c')`,
  ).run(
    `target-1:${filePath}:${input.line}:${input.name}`,
    filePath,
    input.name,
    input.line,
  )
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    'target-1',
    '/tmp/target',
  )
  db.prepare(
    `INSERT INTO recon_files (target_id, path, language, bytes, binary)
     VALUES ('target-1', 'src/handler.c', 'c', 10, 0)`,
  ).run()

  context = createProgramContext(db, 'target-1')
})

describe('enclosingFunction', () => {
  test('resolves the function whose body spans the line', () => {
    seedSymbol({ name: 'parse_header', startLine: 10, endLine: 20 })

    expect(context.enclosingFunction('src/handler.c', 15)).toEqual({
      name: 'parse_header',
      startLine: 10,
      endLine: 20,
    })
  })

  test('matches the boundary lines of the range', () => {
    seedSymbol({ name: 'parse_header', startLine: 10, endLine: 20 })

    expect(context.enclosingFunction('src/handler.c', 10)?.name).toBe('parse_header')
    expect(context.enclosingFunction('src/handler.c', 20)?.name).toBe('parse_header')
  })

  test('returns null outside any recorded function', () => {
    seedSymbol({ name: 'parse_header', startLine: 10, endLine: 20 })

    expect(context.enclosingFunction('src/handler.c', 25)).toBeNull()
  })

  test('prefers the innermost function when ranges nest', () => {
    seedSymbol({ name: 'outer', startLine: 1, endLine: 40 })
    seedSymbol({ name: 'inner', startLine: 10, endLine: 20 })

    expect(context.enclosingFunction('src/handler.c', 15)?.name).toBe('inner')
  })

  test('does not match another file', () => {
    seedSymbol({ name: 'parse_header', startLine: 10, endLine: 20 })

    expect(context.enclosingFunction('src/other.c', 15)).toBeNull()
  })
})

describe('symbolsFor', () => {
  test('uses the indexed references inside the enclosing range', () => {
    seedSymbol({ name: 'parse_header', startLine: 10, endLine: 20 })
    seedRef({ name: 'strcpy', line: 12 })
    seedRef({ name: 'memcpy', line: 18 })
    seedRef({ name: 'outside_the_range', line: 30 })

    expect(
      context.symbolsFor({
        filePath: 'src/handler.c',
        range: { startLine: 10, endLine: 20 },
        snippet: null,
      }),
    ).toEqual(['memcpy', 'strcpy'])
  })

  test('falls back to snippet identifiers when the range has no references', () => {
    const symbols = context.symbolsFor({
      filePath: 'src/handler.c',
      range: { startLine: 10, endLine: 20 },
      snippet: 'void f(void) { parse_header(buf, src); }',
    })

    expect(symbols).toContain('parse_header')
    // libc names are excluded by the fallback: an advisory mentioning `strcpy`
    // must not, by itself, mark a candidate a rediscovery.
    expect(symbols).not.toContain('strcpy')
  })
})

describe('languageFor', () => {
  test('reports the language recon recorded', () => {
    expect(context.languageFor('src/handler.c')).toBe('c')
  })

  test('returns null for an unknown or absent file', () => {
    expect(context.languageFor('src/missing.c')).toBeNull()
    expect(context.languageFor(null)).toBeNull()
  })
})
