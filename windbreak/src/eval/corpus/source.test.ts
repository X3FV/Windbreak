import { describe, expect, test } from 'bun:test'

import { codeSignature, onlyCommentsChanged, stripComments } from './source'

describe('stripComments', () => {
  test('removes a line comment but keeps the code before it', () => {
    expect(stripComments('int x = 1; // note\nint y = 2;')).toContain('int x = 1;')
    expect(stripComments('int x = 1; // note\nint y = 2;')).not.toContain('note')
    expect(stripComments('int x = 1; // note\nint y = 2;')).toContain('int y = 2;')
  })

  test('removes a block comment and leaves a space behind', () => {
    // Removing it outright would turn `int x/*c*/y;` into `int xy;`, a different
    // token that could compare equal to a genuinely changed line.
    expect(stripComments('int x/*c*/y;')).toBe('int x y;')
  })

  test('a // inside a string literal is not a comment', () => {
    // The case that forces a lexer rather than a regex: stripping here would
    // truncate the line and could make a changed URL compare equal to an
    // unchanged one, dropping a real pair silently.
    const source = 'fprintf(f, "http://example/x");'
    expect(stripComments(source)).toBe(source)
  })

  test('a /* inside a string literal is not a comment', () => {
    const source = 'puts("/* not a comment */");'
    expect(stripComments(source)).toBe(source)
  })

  test('an escaped quote does not end the literal', () => {
    const source = 'puts("say \\" then // still in the string");'
    expect(stripComments(source)).toBe(source)
  })

  test('a backslash-spliced line comment swallows the next line too', () => {
    // C splices backslash-newline *before* it removes comments, so `b;` is part
    // of the comment and must vanish with it. Keeping it would leave code in the
    // signature that no compiler sees.
    expect(stripComments('a; // comment \\\nb;')).toBe('a; ')
  })

  test('a block comment spanning lines is removed', () => {
    expect(stripComments('a;\n/* one\n two */\nb;')).toBe('a;\n \nb;')
  })
})

describe('onlyCommentsChanged', () => {
  test('true when the two halves differ only by a comment', () => {
    expect(onlyCommentsChanged('int f(void) { return 1; }', 'int f(void) { /* fixed */ return 1; }')).toBe(
      true,
    )
  })

  test('true when the two halves differ only by layout', () => {
    // The reformat case: adding a space or a line break is not a fix, and a
    // comparison that only collapsed whitespace *runs* would call it one.
    expect(onlyCommentsChanged('int f(void){return 1;}', 'int f(void) {\n  return 1;\n}')).toBe(
      true,
    )
  })

  test('false when only the order of tokens changed', () => {
    expect(onlyCommentsChanged('a + +b;', 'a++ + b;')).toBe(false)
  })

  test('false when any code changed', () => {
    expect(onlyCommentsChanged('strcpy(dst, src);', 'strncpy(dst, src, n);')).toBe(false)
  })

  test('false when only a string literal changed', () => {
    // A fix that changes a URL or a format string is a code change, and the
    // lexer has to preserve literals for this to be visible.
    expect(onlyCommentsChanged('puts("a");', 'puts("b");')).toBe(false)
  })
})

describe('codeSignature', () => {
  test('collapses whitespace so indentation alone is not a change', () => {
    expect(codeSignature('int  f ( void )')).toBe('int f ( void )')
  })
})
