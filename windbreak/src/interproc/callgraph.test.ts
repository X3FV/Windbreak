import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'
import { buildCallGraph, enclosingCallable, readProgramModel } from './callgraph'

import type { CallGraphDefinition, CallReference } from './callgraph'

const definition = (
  name: string,
  startLine: number,
  endLine: number,
  filePath = 'src/main.c',
): CallGraphDefinition => ({ name, filePath, startLine, endLine })

const reference = (name: string, line: number, filePath = 'src/main.c'): CallReference => ({
  name,
  filePath,
  line,
})

const graph = (
  definitions: readonly CallGraphDefinition[],
  references: readonly CallReference[],
) => buildCallGraph({ definitions, references })

describe('enclosingCallable', () => {
  test('resolves the region whose body spans the line', () => {
    const defs = [definition('first', 1, 10), definition('second', 20, 30)]

    expect(enclosingCallable(defs, 5)?.name).toBe('first')
    expect(enclosingCallable(defs, 25)?.name).toBe('second')
  })

  test('a line no region covers has no enclosing callable', () => {
    expect(enclosingCallable([definition('first', 1, 10)], 11)).toBeNull()
  })

  test('a nested region wins over its parent, because it is the closer caller', () => {
    const defs = [definition('outer', 1, 40), definition('inner', 10, 20)]

    expect(enclosingCallable(defs, 15)?.name).toBe('inner')
    expect(enclosingCallable(defs, 30)?.name).toBe('outer')
  })
})

describe('buildCallGraph', () => {
  test('attributes a call to its enclosing function and resolves the callee', () => {
    const built = graph(
      [definition('main', 1, 10), definition('helper', 20, 30)],
      [reference('helper', 5)],
    )

    expect(built.edges).toEqual([
      {
        fromFile: 'src/main.c',
        fromFunction: 'main',
        toFile: 'src/main.c',
        toFunction: 'helper',
        line: 5,
      },
    ])
    expect(built.referencesSeen).toBe(1)
  })

  test('a same-file definition wins over another file defining the same name', () => {
    const built = graph(
      [
        definition('main', 1, 10),
        definition('parse', 20, 30, 'src/a.c'),
        definition('parse', 20, 30, 'src/b.c'),
        definition('main', 1, 10, 'src/b.c'),
      ],
      [reference('parse', 5, 'src/b.c')],
    )

    expect(built.edges).toHaveLength(1)
    expect(built.edges[0]).toMatchObject({ fromFile: 'src/b.c', toFile: 'src/b.c' })
    expect(built.ambiguous).toEqual([])
  })

  test('a name defined in several files with no same-file match is dropped and reported', () => {
    const built = graph(
      [
        definition('main', 1, 10, 'src/c.c'),
        definition('parse', 20, 30, 'src/a.c'),
        definition('parse', 20, 30, 'src/b.c'),
      ],
      [reference('parse', 5, 'src/c.c')],
    )

    expect(built.edges).toEqual([])
    expect(built.ambiguous).toHaveLength(1)
    expect(built.ambiguous[0]).toContain('defined in 2 files')
  })

  test('an unknown callee is unresolved rather than dropped silently', () => {
    const built = graph([definition('main', 1, 10)], [reference('printf', 5)])

    expect(built.edges).toEqual([])
    expect(built.unresolved).toHaveLength(1)
    expect(built.unresolved[0]).toContain('printf (called from src/main.c:5)')
  })

  test('a call site no callable covers is counted, not attributed to something', () => {
    // A call in a global initialiser is a missing *input*, not an absent caller.
    const built = graph([definition('main', 10, 20)], [reference('helper', 3)])

    expect(built.edges).toEqual([])
    expect(built.unattributed).toBe(1)
    expect(built.unresolved).toEqual([])
  })

  test('callsOf returns every reference written in a function, resolved or not', () => {
    // The difference between `edgesFrom` and this is the whole of `unresolved`: a libc call
    // has no definition in the target and so no edge, and `reach/entries.ts` asks precisely
    // that question of a name rather than of a resolved definition.
    const built = graph(
      [definition('main', 1, 10), definition('helper', 20, 30)],
      [reference('helper', 5), reference('printf', 6), reference('helper', 25)],
    )

    expect(built.edgesFrom('src/main.c', 'main').map((edge) => edge.toFunction)).toEqual(['helper'])
    expect(built.callsOf('src/main.c', 'main').map((ref) => ref.name)).toEqual([
      'helper',
      'printf',
    ])
    expect(built.callsOf('src/main.c', 'nothing')).toEqual([])
  })

  test('unresolvedNames is the deduplicated, sorted form of the resolved-out names', () => {
    const built = graph(
      [definition('main', 1, 10)],
      [
        reference('printf', 5),
        reference('zlibVersion', 6),
        reference('printf', 7),
        reference('Q::poll', 8),
      ],
    )

    expect(built.unresolved).toHaveLength(4)
    expect(built.unresolvedNames).toEqual(['Q::poll', 'printf', 'zlibVersion'])
  })

  test('a qualified call is captured as written, which is why it never resolves', () => {
    // The index holds `poll` with `Q` in a separate column, so `Q::poll` matches nothing — no
    // edge, no ambiguity, and no `droppedCallersOf` entry either, because a reference that
    // never resolved was never dropped. `reach/graph.ts` reads the tail off this list instead.
    const built = graph(
      [definition('main', 1, 10), definition('poll', 20, 30, 'src/q.c')],
      [reference('Q::poll', 5)],
    )

    expect(built.edges).toEqual([])
    expect(built.callersOf('src/q.c', 'poll')).toEqual([])
    expect(built.droppedCallersOf('poll')).toEqual({ ambiguous: 0, unattributed: 0 })
    expect(built.unresolvedNames).toContain('Q::poll')
  })

  test('a recursive call is an edge from a function to itself', () => {
    const built = graph([definition('walk', 1, 10)], [reference('walk', 5)])

    expect(built.edges).toHaveLength(1)
    expect(built.edges[0]).toMatchObject({ fromFunction: 'walk', toFunction: 'walk' })
  })

  test('callersOf returns the incoming edges for one definition', () => {
    const built = graph(
      [definition('main', 1, 10), definition('other', 11, 20), definition('helper', 30, 40)],
      [reference('helper', 5), reference('helper', 15), reference('nothing', 6)],
    )

    expect(built.callersOf('src/main.c', 'helper').map((edge) => edge.fromFunction)).toEqual([
      'main',
      'other',
    ])
  })

  test('a definition nothing calls has no callers, which is not the same as unattributed', () => {
    const built = graph([definition('main', 1, 10), definition('orphan', 20, 30)], [])

    expect(built.callersOf('src/main.c', 'orphan')).toEqual([])
    expect(built.unattributed).toBe(0)
  })

  test('a complete caller set reports no dropped callers', () => {
    const built = graph(
      [definition('main', 1, 10), definition('helper', 20, 30)],
      [reference('helper', 5)],
    )

    expect(built.droppedCallersOf('helper')).toEqual({ ambiguous: 0, unattributed: 0 })
  })

  test('an ambiguous callee name makes that name\'s caller set partial', () => {
    const built = graph(
      [
        definition('main', 1, 10, 'src/c.c'),
        definition('parse', 20, 30, 'src/a.c'),
        definition('parse', 20, 30, 'src/b.c'),
      ],
      [reference('parse', 5, 'src/c.c')],
    )

    expect(built.droppedCallersOf('parse')).toEqual({ ambiguous: 1, unattributed: 0 })
  })

  test('an unattributed call site makes that name\'s caller set partial', () => {
    const built = graph([definition('main', 10, 20)], [reference('helper', 3)])

    expect(built.droppedCallersOf('helper')).toEqual({ ambiguous: 0, unattributed: 1 })
    // Counted per name: a drop about another function says nothing about this one.
    expect(built.droppedCallersOf('main')).toEqual({ ambiguous: 0, unattributed: 0 })
  })
})

describe('buildCallGraph against the program model', () => {
  let db: Database

  const seedSymbol = (name: string, startLine: number, endLine: number, filePath = 'src/main.c') => {
    db.prepare(
      `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
       VALUES (?, 'target-1', ?, ?, NULL, 'function', ?, ?, 'c')`,
    ).run(`target-1:${filePath}:${name}:${startLine}`, filePath, name, startLine, endLine)
  }

  const seedRef = (name: string, line: number, kind = 'call', filePath = 'src/main.c') => {
    db.prepare(
      `INSERT INTO symbol_refs (id, target_id, file_path, name, kind, line, language)
       VALUES (?, 'target-1', ?, ?, ?, ?, 'c')`,
    ).run(`target-1:${filePath}:${line}:${name}:${kind}`, filePath, name, kind, line)
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('target-1', '/tmp/target')
  })

  test('reads symbols and call references out of the model', () => {
    seedSymbol('main', 1, 10)
    seedSymbol('helper', 20, 30)
    seedRef('helper', 5)

    const built = buildCallGraph(readProgramModel(db, 'target-1'))

    expect(built.edges).toHaveLength(1)
    expect(built.edges[0]).toMatchObject({ fromFunction: 'main', toFunction: 'helper' })
  })

  test('a non-call reference is not a call edge', () => {
    seedSymbol('main', 1, 10)
    seedSymbol('value', 20, 30)
    seedRef('value', 5, 'identifier')

    const built = buildCallGraph(readProgramModel(db, 'target-1'))

    expect(built.edges).toEqual([])
    expect(built.referencesSeen).toBe(0)
  })

  test('a non-callable symbol is not a callee definition', () => {
    seedSymbol('main', 1, 10)
    db.prepare(
      `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
       VALUES ('t:struct', 'target-1', 'src/main.c', 'config', NULL, 'struct', 20, 30, 'c')`,
    ).run()
    seedRef('config', 5)

    const built = buildCallGraph(readProgramModel(db, 'target-1'))

    expect(built.edges).toEqual([])
    expect(built.unresolved).toHaveLength(1)
  })
})
