import { initTreeSitterForNode } from '@codebuff/code-map/init-node'
import { Language, Parser, Query } from 'web-tree-sitter'

import { PROGRAM_MODEL_LANGUAGES } from './languages'
import { SYMBOL_KINDS, type SymbolKind } from './symbol-kinds'

import type { Node } from 'web-tree-sitter'

import type { LanguageQueryDefinition } from './queries'

export type { SymbolKind }

export interface ParsedSymbol {
  name: string
  /** Owning scope for qualified names, e.g. `geo::Shape` for `geo::Shape::f`. */
  qualifier: string | null
  kind: SymbolKind
  startLine: number
  endLine: number
}

export interface ParsedReference {
  name: string
  kind: 'call'
  line: number
}

export interface ParsedFile {
  symbols: ParsedSymbol[]
  references: ParsedReference[]
  /** True when tree-sitter recovered from a syntax error mid-file. */
  hasError: boolean
}

/**
 * Capture name → symbol kind. Built from `SYMBOL_KINDS` so a capture with no
 * kind, or a kind with no capture, is impossible to add quietly: the `satisfies`
 * clause below is what enforces it.
 */
const KIND_BY_CAPTURE = {
  'definition.function': 'function',
  'definition.method': 'method',
  'definition.struct': 'struct',
  'definition.union': 'union',
  'definition.enum': 'enum',
  'definition.typedef': 'typedef',
  'definition.class': 'class',
  'definition.interface': 'interface',
  'definition.trait': 'trait',
  'definition.impl': 'impl',
  'definition.module': 'module',
  'definition.namespace': 'namespace',
} as const satisfies Record<string, SymbolKind>

/**
 * Every kind in `SYMBOL_KINDS` must be reachable from some capture.
 *
 * A kind that no query produces is dead weight in a union that four consumers
 * match on; a capture that maps to no kind is a silent hole. Neither is a
 * runtime problem, which is exactly why it is worth a compile-time check.
 */
type _KindsCovered = (typeof KIND_BY_CAPTURE)[keyof typeof KIND_BY_CAPTURE]
type _EveryKindIsCaptured = Exclude<
  SymbolKind,
  _KindsCovered
> extends never
  ? true
  : never
const _kindsCovered: _EveryKindIsCaptured = true
void _kindsCovered
void SYMBOL_KINDS

/** The lookup view of the table above, widened so a capture *name* can index it. */
const KIND_FOR: Record<string, SymbolKind | undefined> = KIND_BY_CAPTURE

/**
 * Split a qualified name into its last segment and the scope before it.
 *
 * The query captures the whole qualified text because the qualifier nests
 * arbitrarily (`geo::Shape::helper`); this is where it becomes a symbol name
 * plus a scope.
 */
export const splitQualifiedName = (
  qualified: string,
): { name: string; qualifier: string | null } => {
  const trimmed = qualified.trim()
  const parts = trimmed.split('::').filter((part) => part.length > 0)

  if (parts.length <= 1) return { name: trimmed, qualifier: null }

  return {
    name: parts[parts.length - 1]!,
    qualifier: parts.slice(0, -1).join('::'),
  }
}

interface Grammar {
  language: Language
  parser: Parser
  query: Query
  spec: LanguageQueryDefinition
}

let initPromise: Promise<void> | null = null

const initTreeSitter = async (): Promise<void> => {
  initPromise ??= initTreeSitterForNode()
  return initPromise
}

const grammarCache = new Map<string, Promise<Grammar>>()

/**
 * Load (once) the parser and compiled query for a language.
 *
 * Both are cached per language rather than per file: compiling a tree-sitter
 * query is not cheap, and the model parses thousands of files in one run.
 */
export const loadGrammar = (languageId: string): Promise<Grammar> => {
  const cached = grammarCache.get(languageId)
  if (cached) return cached

  const promise = (async (): Promise<Grammar> => {
    await initTreeSitter()

    const spec = PROGRAM_MODEL_LANGUAGES[languageId]
    if (!spec) {
      throw new Error(
        `No grammar registered for language "${languageId}". ` +
          `Registered: ${Object.keys(PROGRAM_MODEL_LANGUAGES).join(', ')}.`,
      )
    }

    const wasmPath = require.resolve(
      `@vscode/tree-sitter-wasm/wasm/${spec.wasmFile}`,
    )
    const language = await Language.load(wasmPath)

    const parser = new Parser()
    parser.setLanguage(language)

    const query = new Query(language, spec.query)

    return { language, parser, query, spec }
  })()

  grammarCache.set(languageId, promise)
  return promise
}

/**
 * Strip a `@qualifier` capture down to a bare type name.
 *
 * The capture is whatever the grammar's type field held, so a Go receiver can
 * arrive as `*Greeter`, `pkg.Greeter`, `Greeter[T]` or `map[string]int`. Only
 * the last two are shaped like owner names, and the rest are reduced to the
 * identifier a reviewer would recognise — or dropped, which is better than
 * storing `map[string]int` in a column that means "owning scope".
 */
export const cleanQualifier = (raw: string | undefined): string | null => {
  if (!raw) return null
  // Order matters: the type arguments are dropped *before* any bracket
  // stripping, or `Greeter[T]` becomes `GreeterT` — a name that resolves
  // against nothing and reads as a plausible typo rather than a bug.
  const withoutPointer = raw.replace(/[*&\s]/g, '')
  const base = withoutPointer.split(/[<[]/)[0] ?? ''
  const last = base.split(/[.:]/).filter((part) => part.length > 0).pop()
  return last && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(last) ? last : null
}

/**
 * Decide whether a function-like node is a method, and who it belongs to.
 *
 * Some grammars answer "is this a method" syntactically — JavaScript has a
 * `method_definition` node, Go a `method_declaration` — and for those the query
 * has already emitted `@definition.method`. Others cannot: Python has one
 * `function_definition` for `def f()` at module level and `def f(self)` inside a
 * class, and Ruby's `def` inside a `module` is a method of the mixin. This is
 * where that difference is resolved.
 *
 * The walk is over *all* ancestors rather than a fixed number of hops, because
 * the number differs per language and per construct — Python's decorators add a
 * `decorated_definition`, Ruby a `body_statement`, Java a `class_body`. It stops
 * at the nearest **callable** or **container**, and a callable wins: a closure
 * inside a method belongs to the method, not to the class the method is on.
 * That single rule is what makes the walk correct without a per-language
 * allowlist of transparent nodes.
 */
const buildRefiner = (
  spec: LanguageQueryDefinition,
): ((node: Node, kind: SymbolKind) => { kind: SymbolKind; qualifier: string | null }) => {
  if (spec.callableNodes.length === 0 && spec.methodContainers.length === 0) {
    return (_node, kind) => ({ kind, qualifier: null })
  }

  const callables = new Set(spec.callableNodes)
  const containers = new Set(spec.methodContainers)

  return (node, kind) => {
    let current: Node | null = node.parent
    while (current) {
      if (callables.has(current.type)) break
      if (containers.has(current.type)) {
        // `name` is the field in Java, C#, JavaScript, Python and Ruby;
        // Rust's `impl` block names the type in `type` instead, and a container
        // with neither is one whose owner cannot be stated.
        const nameNode =
          current.childForFieldName('name') ?? current.childForFieldName('type')
        return {
          kind: kind === 'function' ? 'method' : kind,
          qualifier: nameNode ? cleanQualifier(nameNode.text) : null,
        }
      }
      current = current.parent
    }
    return { kind, qualifier: null }
  }
}

/**
 * Parse one source string into symbols and references.
 *
 * A file that fails to parse yields empty results with `hasError: true` rather
 * than throwing, because one unparseable file must not abort a whole target.
 */
export const parseSource = async (
  languageId: string,
  source: string,
): Promise<ParsedFile> => {
  const { parser, query, spec } = await loadGrammar(languageId)
  const refine = buildRefiner(spec)

  const tree = parser.parse(source)
  if (!tree) {
    return { symbols: [], references: [], hasError: true }
  }

  try {
    const symbols: ParsedSymbol[] = []
    const references: ParsedReference[] = []
    const seen = new Set<string>()

    // Iterating *matches* rather than captures is what makes the paired
    // `@name` / `@definition.*` captures usable: only a match groups the
    // captures that belong to one pattern occurrence. See queries.ts note 3.
    for (const match of query.matches(tree.rootNode)) {
      const definitionCapture = match.captures.find(
        (capture) => KIND_FOR[capture.name] !== undefined,
      )

      if (!definitionCapture) {
        const referenceCapture = match.captures.find((capture) =>
          capture.name.startsWith('reference.'),
        )
        if (!referenceCapture) continue

        const node = referenceCapture.node
        const key = `ref:${node.text}:${node.startPosition.row}`
        if (seen.has(key)) continue
        seen.add(key)
        references.push({
          name: node.text,
          kind: 'call',
          line: node.startPosition.row + 1,
        })
        continue
      }

      const kind = KIND_FOR[definitionCapture.name]!

      // The name is the identifier; the range must come from the whole node.
      // Falling back to the definition node keeps the parser correct for a
      // pattern that legitimately has no separate name capture.
      const definitionNode = definitionCapture.node
      const nameNode =
        match.captures.find((capture) => capture.name === 'name')?.node ??
        definitionNode

      const split = splitQualifiedName(nameNode.text)
      if (split.name.length === 0) continue

      // Three sources of qualifier, in decreasing order of locality: one that is
      // literally part of the name (C++'s `geo::Shape::helper`, whose `name`
      // field holds `Shape::helper` — the *immediate* owner, and the reason this
      // outranks the next source), a grammar `@qualifier` capture for when the
      // owner is a sibling field rather than an ancestor or a name segment
      // (Go's receiver), and finally the nearest enclosing container node
      // (every method that names its owner nowhere in its own text: Java, C#,
      // JavaScript, Python, Ruby).
      //
      // Name-derived first is not a preference but a correctness point: for
      // `geo::Shape::helper` the `scope` capture is `geo`, an *outer* namespace,
      // while the split qualifier is `Shape`. Preferring the capture there would
      // attribute the method to the namespace instead of the class.
      const explicitQualifier = match.captures.find(
        (capture) => capture.name === 'qualifier',
      )?.node
      const refined = refine(definitionNode, kind)
      const qualifier =
        split.qualifier ?? cleanQualifier(explicitQualifier?.text) ?? refined.qualifier
      const resolvedKind = refined.kind

      const key = `sym:${resolvedKind}:${split.name}:${definitionNode.startPosition.row}`
      if (seen.has(key)) continue
      seen.add(key)

      symbols.push({
        name: split.name,
        qualifier,
        kind: resolvedKind,
        startLine: definitionNode.startPosition.row + 1,
        endLine: definitionNode.endPosition.row + 1,
      })
    }

    return {
      symbols,
      references,
      hasError: tree.rootNode.hasError,
    }
  } finally {
    // Trees hold wasm-side memory that is not garbage collected on its own.
    ;(tree as { delete?: () => void }).delete?.()
  }
}
