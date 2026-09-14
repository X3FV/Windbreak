import { describe, expect, test } from 'bun:test'

import {
  detectLanguage,
  detectLanguages,
  extensionOf,
  isProgramModelLanguage,
  unsupportedProgramLanguages,
} from './languages'

describe('extensionOf', () => {
  test('returns a lowercased extension with the dot', () => {
    expect(extensionOf('src/main.CPP')).toBe('.cpp')
    expect(extensionOf('a/b/c.tar.gz')).toBe('.gz')
  })

  test('returns nothing for dotfiles and extensionless paths', () => {
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('src/.gitignore')).toBe('')
  })
})

describe('detectLanguage', () => {
  test('maps C and C++ extensions', () => {
    expect(detectLanguage('kernel/sched.c')).toBe('c')
    expect(detectLanguage('include/linux/sched.h')).toBe('c')
    expect(detectLanguage('src/engine.cc')).toBe('cpp')
    expect(detectLanguage('include/engine.hpp')).toBe('cpp')
  })

  test('maps common other ecosystems', () => {
    expect(detectLanguage('lib.rs')).toBe('rust')
    expect(detectLanguage('main.go')).toBe('go')
    expect(detectLanguage('app.py')).toBe('python')
    expect(detectLanguage('index.ts')).toBe('typescript')
  })

  test('distinguishes .S assembly from .s, since the case carries meaning', () => {
    expect(detectLanguage('boot/head.S')).toBe('assembly')
    expect(detectLanguage('boot/head.s')).toBe('assembly')
  })

  test('returns null for unknown extensions', () => {
    expect(detectLanguage('LICENSE')).toBeNull()
    expect(detectLanguage('data.parquet')).toBeNull()
  })
})

describe('isProgramModelLanguage', () => {
  test('is true for every language with a registered grammar', () => {
    // Every one of these ships a wasm grammar in @vscode/tree-sitter-wasm, so
    // "supported" is a question about queries, not dependencies.
    for (const language of [
      'c',
      'cpp',
      'rust',
      'go',
      'python',
      'javascript',
      'typescript',
      'tsx',
      'java',
      'ruby',
      'csharp',
    ]) {
      expect(isProgramModelLanguage(language)).toBe(true)
    }
  })

  test('is false for detected-but-unsupported and for null', () => {
    expect(isProgramModelLanguage('php')).toBe(false)
    expect(isProgramModelLanguage('shell')).toBe(false)
    expect(isProgramModelLanguage('assembly')).toBe(false)
    expect(isProgramModelLanguage(null)).toBe(false)
  })

  test('.tsx is its own language, not a TypeScript mode', () => {
    // Parsing a `.tsx` file with the TypeScript grammar errors on every
    // component, because the JSX productions change how `<` parses.
    expect(detectLanguage('src/App.tsx')).toBe('tsx')
    expect(detectLanguage('src/app.ts')).toBe('typescript')
  })
})

describe('unsupportedProgramLanguages', () => {
  test('names the programming languages with no query, not just a count', () => {
    expect(
      unsupportedProgramLanguages(['c', 'php', 'shell', 'markdown', null, 'php']),
    ).toEqual(['php', 'shell'])
  })

  test('data and markup files are not "unsupported", they are out of scope', () => {
    expect(unsupportedProgramLanguages(['json', 'yaml', 'markdown'])).toEqual([])
  })
})

describe('detectLanguages', () => {
  test('aggregates counts and bytes, largest first', () => {
    const inventory = detectLanguages([
      { path: 'a.c', bytes: 100 },
      { path: 'b.c', bytes: 50 },
      { path: 'x.hpp', bytes: 10 },
    ])

    expect(inventory[0]).toEqual({ language: 'c', fileCount: 2, bytes: 150 })
    expect(inventory[1]).toEqual({ language: 'cpp', fileCount: 1, bytes: 10 })
  })

  test('buckets unrecognised files as "other" so counts still add up', () => {
    const inventory = detectLanguages([
      { path: 'a.c', bytes: 1 },
      { path: 'LICENSE', bytes: 2 },
      { path: 'data.parquet', bytes: 3 },
    ])

    const other = inventory.find((entry) => entry.language === 'other')
    expect(other).toEqual({ language: 'other', fileCount: 2, bytes: 5 })

    const total = inventory.reduce((sum, entry) => sum + entry.fileCount, 0)
    expect(total).toBe(3)
  })

  test('returns an empty list for an empty inventory', () => {
    expect(detectLanguages([])).toEqual([])
  })
})
