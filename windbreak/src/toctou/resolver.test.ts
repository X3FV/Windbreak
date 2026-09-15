import { describe, expect, test } from 'bun:test'

import { buildDefinitionIndex, definitionKey, resolveName } from './resolver'
import { handlerKey } from './types'

describe('buildDefinitionIndex', () => {
  test('records every file a name is defined in', () => {
    const index = buildDefinitionIndex([
      { name: 'cleanup', filePath: 'src/a.c' },
      { name: 'cleanup', filePath: 'src/b.c' },
    ])

    expect(index.filesByName.get('cleanup')).toEqual(new Set(['src/a.c', 'src/b.c']))
  })

  test('a file defining one name twice is still one file, not a false ambiguity', () => {
    const index = buildDefinitionIndex([
      { name: 'dup', filePath: 'src/a.c' },
      { name: 'dup', filePath: 'src/a.c' },
    ])

    expect(index.filesByName.get('dup')?.size).toBe(1)
    expect(resolveName(index, 'dup', 'src/other.c')).toEqual({
      kind: 'resolved',
      filePath: 'src/a.c',
    })
  })
})

describe('resolveName', () => {
  const index = buildDefinitionIndex([
    { name: 'parse', filePath: 'src/a.c' },
    { name: 'parse', filePath: 'src/b.c' },
    { name: 'helper', filePath: 'src/b.c' },
  ])

  test('a same-file definition wins over another file defining the same name', () => {
    // This is what makes a `static` function resolvable when another translation
    // unit happens to use the same name.
    expect(resolveName(index, 'parse', 'src/b.c')).toEqual({
      kind: 'resolved',
      filePath: 'src/b.c',
    })
  })

  test('a name defined in exactly one file resolves from elsewhere', () => {
    expect(resolveName(index, 'helper', 'src/a.c')).toEqual({
      kind: 'resolved',
      filePath: 'src/b.c',
    })
  })

  test('a name defined in several files with no same-file match is ambiguous, not guessed', () => {
    expect(resolveName(index, 'parse', 'src/c.c')).toEqual({
      kind: 'ambiguous',
      fileCount: 2,
    })
  })

  test('a name the index does not have is unresolved, which is a different failure', () => {
    // `unresolved` and `ambiguous` are kept apart deliberately: the first is a
    // missing definition (a libc call), the second is a choice this resolver
    // refused to make. Only one of them suggests the program model is thin.
    expect(resolveName(index, 'printf', 'src/a.c')).toEqual({ kind: 'unresolved' })
  })
})

describe('definitionKey', () => {
  test('is the same shape as the handler key, so the two can be compared', () => {
    expect(definitionKey('src/main.c', 'on_int')).toBe(handlerKey('src/main.c', 'on_int'))
  })
})
