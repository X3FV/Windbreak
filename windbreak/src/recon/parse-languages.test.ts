/**
 * One real snippet per language, asserting what the program model actually
 * indexes.
 *
 * This file exists because the multi-language work is the kind of change whose
 * failure mode is **silence**. A query that names a node type the grammar does
 * not have fails loudly at `new Query(...)`, but a query that names a node type
 * the grammar *does* have and simply never matches produces an empty, clean,
 * entirely plausible symbol index — and every region sweep downstream then
 * reports "no findings". So each language gets a snippet whose expected symbols
 * are written out, rather than a smoke test that only checks it does not throw.
 *
 * The snippets are deliberately tiny and idiomatically ordinary: a class with a
 * method, a free function, and a call between them. Anything the tables here do
 * not cover is a gap in the query, not in the fixture.
 */

import { describe, expect, test } from 'bun:test'

import { parseSource } from './parser'

import type { ParsedFile, SymbolKind } from './parser'

interface ExpectedSymbol {
  name: string
  kind: SymbolKind
  qualifier?: string | null
}

interface Case {
  language: string
  source: string
  symbols: ExpectedSymbol[]
  calls: string[]
}

const CASES: Case[] = [
  {
    language: 'c',
    source: `struct point { int x; int y; };
typedef struct point point_t;
static int area(struct point *p) { return p->x * p->y; }
int main(void) { return area(0); }
`,
    symbols: [
      { name: 'point', kind: 'struct' },
      { name: 'point_t', kind: 'typedef' },
      { name: 'area', kind: 'function' },
      { name: 'main', kind: 'function' },
    ],
    calls: ['area'],
  },
  {
    language: 'cpp',
    // Two C++ shapes that the C-only query set handled differently, and one of
    // them not at all: `area` is defined *inside* the class, so its declarator
    // is a `field_identifier` — a node the C pattern never named, which is why
    // inline methods produced no symbol at all until this test existed.
    source: `namespace geo {
class Shape {
 public:
  int area(int n) { return helper(n); }
  int helper(int n);
};
}
int geo::Shape::helper(int n) { return n; }
`,
    symbols: [
      { name: 'geo', kind: 'namespace' },
      { name: 'Shape', kind: 'class' },
      { name: 'area', kind: 'method', qualifier: 'Shape' },
      // Out-of-line, and **kind `function`** — a deliberate, recorded asymmetry.
      // Its owner is in the name rather than in an enclosing node, so the
      // ancestor walk cannot see the class, and the qualifier it does carry
      // (`Shape`) is indistinguishable from a namespace's in
      // `int geo::helper(int)`. Since both kinds are in `CALLABLE_KINDS`, no
      // consumer is affected; see §20.24.4.
      { name: 'helper', kind: 'function', qualifier: 'Shape' },
    ],
    calls: ['helper'],
  },
  {
    language: 'python',
    source: `class Greeter(Base):
    def hello(self, name):
        return greet(name)

    @staticmethod
    def make():
        def inner():
            return 1
        return inner()

def greet(name):
    return fmt(name)

def fmt(name):
    return name
`,
    symbols: [
      { name: 'Greeter', kind: 'class' },
      // The same node type as `greet` below, promoted by the ancestor walk.
      { name: 'hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'make', kind: 'method', qualifier: 'Greeter' },
      // A `def` inside a method belongs to the method, not the class.
      { name: 'inner', kind: 'function', qualifier: null },
      { name: 'greet', kind: 'function' },
      { name: 'fmt', kind: 'function' },
    ],
    calls: ['greet', 'inner', 'fmt'],
  },
  {
    language: 'ruby',
    // `module` is a method container: `def helper` here is a method of the
    // mixin, not a free function.
    source: `module Util
  class Greeter < Base
    def hello(name)
      greet(name)
    end
  end

  def helper(x)
    puts x
  end
end
`,
    symbols: [
      { name: 'Util', kind: 'module' },
      { name: 'Greeter', kind: 'class', qualifier: 'Util' },
      { name: 'hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'helper', kind: 'method', qualifier: 'Util' },
    ],
    calls: ['greet', 'puts'],
  },
  {
    language: 'go',
    // Method-ness is syntactic here, and the owner is a *sibling* field, so the
    // qualifier comes from the query's `@qualifier` capture, not a walk.
    source: `package main

type Greeter struct{ n int }
type Runner interface{ Run() }

func (g *Greeter) Hello(name string) string {
	return greet(name)
}

func Greet(name string) string {
	return fmt(name)
}
`,
    symbols: [
      { name: 'Greeter', kind: 'struct' },
      { name: 'Runner', kind: 'interface' },
      { name: 'Hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'Greet', kind: 'function' },
    ],
    calls: ['greet', 'fmt'],
  },
  {
    language: 'java',
    source: `package com.example;

public class Greeter extends Base implements Runnable {
  private int n;

  public Greeter(int n) { this.n = n; }

  public String hello(String name) {
    return greet(name);
  }

  public void run() {}
}

interface Runnable { void run(); }
`,
    symbols: [
      { name: 'Greeter', kind: 'class' },
      { name: 'Greeter', kind: 'method', qualifier: 'Greeter' },
      { name: 'hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'run', kind: 'method', qualifier: 'Greeter' },
      { name: 'Runnable', kind: 'interface' },
      { name: 'run', kind: 'method', qualifier: 'Runnable' },
    ],
    calls: ['greet'],
  },
  {
    language: 'javascript',
    // `const fmt = (x) => ...` makes the declarator the symbol, so its range
    // spans the assignment rather than a function node.
    source: `class Greeter extends Base {
  constructor(n) { this.n = n }
  hello(name) {
    return greet(name);
  }
}

function greet(name) {
  return fmt(name);
}

const fmt = (x) => x + 1;
`,
    symbols: [
      { name: 'Greeter', kind: 'class' },
      { name: 'constructor', kind: 'method', qualifier: 'Greeter' },
      { name: 'hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'greet', kind: 'function' },
      { name: 'fmt', kind: 'function' },
    ],
    calls: ['greet', 'fmt'],
  },
  {
    language: 'typescript',
    source: `interface Shape { area(): number }

class Circle implements Shape {
  area(): number { return helper(1) }
}

namespace Geo {
  export function dist(): number { return 0 }
}

enum Color { Red, Green }
type Alias = number
function helper(x: number): number { return x }
const fn = (x: number): number => x
`,
    symbols: [
      { name: 'Shape', kind: 'interface' },
      { name: 'Circle', kind: 'class' },
      { name: 'area', kind: 'method', qualifier: 'Circle' },
      { name: 'Geo', kind: 'module' },
      { name: 'dist', kind: 'function' },
      { name: 'Color', kind: 'enum' },
      { name: 'Alias', kind: 'typedef' },
      { name: 'helper', kind: 'function' },
      { name: 'fn', kind: 'function' },
    ],
    calls: ['helper'],
  },
  {
    language: 'tsx',
    // The reason `.tsx` is a separate grammar: the TypeScript grammar errors on
    // every JSX element, so this file would parse with `hasError: true` and a
    // suspiciously short symbol list.
    source: `export function App() {
  return <div onClick={() => go()}>hi</div>
}

const Comp = () => <span>{x}</span>
`,
    symbols: [
      { name: 'App', kind: 'function' },
      { name: 'Comp', kind: 'function' },
    ],
    calls: ['go'],
  },
  {
    language: 'csharp',
    source: `namespace App {
  public class Greeter : Base {
    public string Hello(string name) {
      return Greet(name);
    }
  }

  interface IRun { void Run(); }
  enum Color { Red, Green }
  struct Point { public int X; }
}
`,
    symbols: [
      { name: 'App', kind: 'namespace' },
      { name: 'Greeter', kind: 'class' },
      { name: 'Hello', kind: 'method', qualifier: 'Greeter' },
      { name: 'IRun', kind: 'interface' },
      { name: 'Run', kind: 'method', qualifier: 'IRun' },
      { name: 'Color', kind: 'enum' },
      { name: 'Point', kind: 'struct' },
    ],
    calls: ['Greet'],
  },
  {
    language: 'rust',
    source: `struct Shape { w: u32 }

trait Area { fn area(&self) -> u32; }

impl Shape {
    fn area(&self) -> u32 {
        measure(self)
    }
}

enum Color { Red, Green }

fn measure(s: &Shape) -> u32 {
    s.w
}
`,
    symbols: [
      { name: 'Shape', kind: 'struct' },
      { name: 'Area', kind: 'trait' },
      { name: 'Shape', kind: 'impl' },
      { name: 'area', kind: 'method', qualifier: 'Shape' },
      { name: 'Color', kind: 'enum' },
      { name: 'measure', kind: 'function' },
    ],
    calls: ['measure'],
  },
]

const assertSymbol = (
  parsed: ParsedFile,
  expected: ExpectedSymbol,
  language: string,
): void => {
  const matches = parsed.symbols.filter(
    (symbol) => symbol.name === expected.name && symbol.kind === expected.kind,
  )
  expect(
    matches.length,
    `${language}: expected a ${expected.kind} named ${expected.name}`,
  ).toBeGreaterThan(0)
  if (expected.qualifier !== undefined) {
    expect(
      matches.map((symbol) => symbol.qualifier),
      `${language}: ${expected.kind} ${expected.name} qualifier`,
    ).toContain(expected.qualifier)
  }
}

describe('parseSource across languages', () => {
  for (const testCase of CASES) {
    test(`${testCase.language}: indexes the definitions and the call sites`, async () => {
      const parsed = await parseSource(testCase.language, testCase.source)

      // A query that silently matches nothing yields a clean, empty index, which
      // is the failure this whole file is aimed at.
      expect(parsed.hasError, `${testCase.language} parsed with errors`).toBe(false)

      for (const expected of testCase.symbols) {
        assertSymbol(parsed, expected, testCase.language)
      }

      const calls = new Set(parsed.references.map((reference) => reference.name))
      for (const call of testCase.calls) {
        expect(
          [...calls],
          `${testCase.language}: missing call site ${call}`,
        ).toContain(call)
      }
    })
  }

  test('no language reports a method as a plain function', async () => {
    // The inverse assertion, and the one that matters most: every consumer of
    // this index asks for `CALLABLE_KINDS`, so a mislabelled method is not a
    // crash — it is a region that four sweeps will never look inside.
    for (const testCase of CASES) {
      const parsed = await parseSource(testCase.language, testCase.source)
      const methods = testCase.symbols.filter((symbol) => symbol.kind === 'method')
      if (methods.length === 0) continue

      const functions = new Set(
        parsed.symbols
          .filter((symbol) => symbol.kind === 'function')
          .map((symbol) => symbol.name),
      )
      for (const method of methods) {
        expect(
          functions.has(method.name),
          `${testCase.language}: ${method.name} is indexed as both a method and a function`,
        ).toBe(false)
      }
    }
  })

  test('every supported language is covered by this file', async () => {
    // A new grammar with no case here would be indexed by nothing and caught by
    // nothing, so the coverage is asserted rather than trusted.
    const { PROGRAM_MODEL_LANGUAGES } = await import('./languages')
    expect(CASES.map((testCase) => testCase.language).sort()).toEqual(
      Object.keys(PROGRAM_MODEL_LANGUAGES).sort(),
    )
  })
})
