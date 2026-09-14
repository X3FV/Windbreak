import { describe, expect, test } from 'bun:test'

import { parseSource, splitQualifiedName } from './parser'
import type { ParsedSymbol } from './parser'

const C_SOURCE = `#include <stdio.h>
struct point { int x; int y; };
union u { int i; float f; };
enum color { RED, GREEN };
typedef struct point Point;
static int add(int a, int b) { return a + b; }
char *dup(const char *s) { return strdup(s); }
int main(void) {
  struct point p;
  p.x = add(1, 2);
  printf("%d\\n", p.x);
  return 0;
}
`

const CPP_SOURCE = `namespace geo {
class Shape {
 public:
  int area() const { return 0; }
};
struct Rect : public Shape {
  int w_, h_;
};
}
int geo::Shape::helper(int x) { return x; }
int main() {
  geo::Rect r;
  return r.area();
}
`

const find = (
  symbols: readonly ParsedSymbol[],
  name: string,
  kind: ParsedSymbol['kind'],
): ParsedSymbol | undefined =>
  symbols.find((symbol) => symbol.name === name && symbol.kind === kind)

describe('splitQualifiedName', () => {
  test('splits a qualified name into name and scope', () => {
    expect(splitQualifiedName('geo::Shape::helper')).toEqual({
      name: 'helper',
      qualifier: 'geo::Shape',
    })
  })

  test('leaves an unqualified name with a null qualifier', () => {
    expect(splitQualifiedName('main')).toEqual({ name: 'main', qualifier: null })
  })
})

describe('parseSource (C)', () => {
  test('extracts function definitions with line ranges', async () => {
    const parsed = await parseSource('c', C_SOURCE)

    expect(parsed.hasError).toBe(false)

    const main = find(parsed.symbols, 'main', 'function')
    expect(main).toBeDefined()
    expect(main?.startLine).toBe(8)

    const add = find(parsed.symbols, 'add', 'function')
    expect(add?.startLine).toBe(6)
  })

  test('extracts pointer-returning function definitions', async () => {
    const parsed = await parseSource('c', C_SOURCE)

    expect(find(parsed.symbols, 'dup', 'function')).toBeDefined()
  })

  test('spans the whole body, not just the declarator line', async () => {
    // Capturing @definition.function on the identifier alone would make
    // endLine === startLine, leaving the symbol index unable to answer "which
    // function contains line N" (§5.1 rule 3).
    const parsed = await parseSource('c', C_SOURCE)

    expect(find(parsed.symbols, 'main', 'function')).toMatchObject({
      startLine: 8,
      endLine: 13,
    })
  })

  test('spans a multi-line typedef', async () => {
    const parsed = await parseSource(
      'c',
      'typedef struct {\n  int x;\n} point_t;\n',
    )

    const alias = find(parsed.symbols, 'point_t', 'typedef')
    expect(alias?.startLine).toBe(1)
    expect(alias?.endLine).toBe(3)
  })

  test('extracts struct, union, enum, and typedef definitions', async () => {
    const parsed = await parseSource('c', C_SOURCE)

    expect(find(parsed.symbols, 'point', 'struct')).toBeDefined()
    expect(find(parsed.symbols, 'u', 'union')).toBeDefined()
    expect(find(parsed.symbols, 'color', 'enum')).toBeDefined()
    expect(find(parsed.symbols, 'Point', 'typedef')).toBeDefined()
  })

  test('does not treat a struct *use* as a definition', async () => {
    // `struct point p;` is a use. Without the query's body guard it would be
    // captured as a second definition of `point`.
    const parsed = await parseSource('c', C_SOURCE)

    const structDefinitions = parsed.symbols.filter(
      (symbol) => symbol.name === 'point' && symbol.kind === 'struct',
    )
    expect(structDefinitions).toHaveLength(1)
    expect(structDefinitions[0]?.startLine).toBe(2)
  })

  test('extracts call sites with line numbers', async () => {
    const parsed = await parseSource('c', C_SOURCE)
    const calls = parsed.references.map((reference) => reference.name)

    expect(calls).toContain('add')
    expect(calls).toContain('printf')
    expect(calls).toContain('strdup')

    const addCall = parsed.references.find((reference) => reference.name === 'add')
    expect(addCall?.line).toBe(10)
  })

  test('does not mistake declarations for definitions', async () => {
    const parsed = await parseSource('c', 'int declared(int a);\nint proto(void);\n')

    expect(parsed.symbols.filter((symbol) => symbol.kind === 'function')).toEqual([])
  })
})

describe('parseSource (C++)', () => {
  test('extracts classes, namespaces, and functions', async () => {
    const parsed = await parseSource('cpp', CPP_SOURCE)

    expect(parsed.hasError).toBe(false)
    expect(find(parsed.symbols, 'geo', 'namespace')).toBeDefined()
    expect(find(parsed.symbols, 'Shape', 'class')).toBeDefined()
    expect(find(parsed.symbols, 'main', 'function')).toBeDefined()
  })

  test('captures out-of-line methods with their scope', async () => {
    // `int geo::Shape::helper(int x)` nests the qualifier twice, which a
    // single-level query pattern silently misses.
    const parsed = await parseSource('cpp', CPP_SOURCE)

    const helper = find(parsed.symbols, 'helper', 'function')
    expect(helper).toBeDefined()
    expect(helper?.qualifier).toBe('Shape')
  })

  test('extracts method-call sites', async () => {
    const parsed = await parseSource('cpp', CPP_SOURCE)

    expect(parsed.references.map((reference) => reference.name)).toContain('area')
  })

  test('spans multi-line classes, namespaces, and functions', async () => {
    const parsed = await parseSource('cpp', CPP_SOURCE)

    expect(find(parsed.symbols, 'main', 'function')).toMatchObject({
      startLine: 11,
      endLine: 14,
    })
    expect(find(parsed.symbols, 'Shape', 'class')).toMatchObject({
      startLine: 2,
      endLine: 5,
    })
    expect(find(parsed.symbols, 'geo', 'namespace')).toMatchObject({
      startLine: 1,
      endLine: 9,
    })
  })
})

describe('parseSource (robustness)', () => {
  test('flags a file with syntax errors instead of throwing', async () => {
    const parsed = await parseSource('c', 'int main(void) { struct {{{')

    expect(parsed.hasError).toBe(true)
  })

  test('returns empty results for an empty file', async () => {
    const parsed = await parseSource('c', '')

    expect(parsed.symbols).toEqual([])
    expect(parsed.references).toEqual([])
  })

  test('rejects a language with no registered grammar', async () => {
    await expect(parseSource('php', '<?php function main() {}')).rejects.toThrow(
      /No grammar registered/,
    )
  })
})
