/**
 * The symbol kinds the program model records, and which of them are callable.
 *
 * This file exists so the two questions can be asked in one place. "What kinds
 * exist" is a question about the grammars; "which kinds is a region-based sweep
 * allowed to walk" is a question about the *analysis*, and it changed answer when
 * the program model stopped being C/C++-only.
 *
 * ## Why `method` is a kind and not a flavour of `function`
 *
 * C has no methods, so the first version of this index had one callable kind. Every
 * consumer then wrote `WHERE kind = 'function'`, which is correct in a C-only world
 * and silently wrong in every other: a Java or Python or Rust target puts most of its
 * code in methods, and a literal `kind = 'function'` would find the free helpers and
 * miss the bodies. That is the worst possible failure — an empty result that reads as
 * a clean one — and it is why the callable set is a named constant rather than a
 * convention each module restates.
 *
 * So method-ness is stored rather than flattened, and the callable set is named
 * *once*, on the reading side, as `CALLABLE_KINDS`. A consumer that wants
 * function-like regions asks for the set; a report that wants to say "method" can;
 * and a language that has no such distinction (C, where every callable is a
 * `function`) simply never produces the other kind.
 *
 * ## Deliberately dependency-free
 *
 * `parser.ts` imports `web-tree-sitter`, which is a wasm loader. The sweeps that need
 * `CALLABLE_KIND_FILTER` are plain SQL over a `bun:sqlite` handle, and pulling a wasm
 * runtime into the toctou sweep because it wanted a string constant would be a
 * dependency created by accident. Nothing here imports anything.
 */

export const SYMBOL_KINDS = [
  /** A free function, or any callable in a language that has only one form. */
  'function',
  /** A callable that is a member of a type: a class, interface, trait or impl body. */
  'method',
  'class',
  'interface',
  'trait',
  /** Rust's `impl` block, whose `function_item`s are the methods. */
  'impl',
  'module',
  'namespace',
  'struct',
  'union',
  'enum',
  'typedef',
] as const

export type SymbolKind = (typeof SYMBOL_KINDS)[number]

/**
 * The kinds a region-based sweep may walk as if they were functions.
 *
 * Both members are needed for the same reason: the toctou event model, the patch-mined
 * sibling sweep, the pattern-library match, and §5.1 rule 3's enclosing-function
 * lookup all ask "what function contains this line", and in ten of the eleven
 * supported languages the answer is often a method — C is the exception, and only
 * because it has none.
 */
export const CALLABLE_KINDS = ['function', 'method'] as const

/**
 * `kind IN ('function', 'method')`, generated from `CALLABLE_KINDS`.
 *
 * A generated fragment rather than a hand-written literal because four modules embed
 * this predicate in their own SQL, and a hand-written copy is a fifth place to forget.
 * The values are compile-time constants from a closed union, so there is no injection
 * surface — which is worth stating, since a caller interpolating SQL is normally the
 * thing to look twice at.
 */
export const CALLABLE_KIND_FILTER = `kind IN (${CALLABLE_KINDS.map((kind) => `'${kind}'`).join(', ')})`
