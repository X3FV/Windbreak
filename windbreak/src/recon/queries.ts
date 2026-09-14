/**
 * Tree-sitter queries for the program model, one per supported language.
 *
 * Why WindBreak owns these rather than reusing `@codebuff/code-map`'s tags
 * queries: code-map captures a flat `@identifier`, which loses the symbol
 * *kind*. The program model needs to distinguish a function from a struct from
 * a typedef, so the captures are namespaced (`definition.function`,
 * `reference.call`) and mapped to kinds in `parser.ts`.
 *
 * ## What changed when this stopped being C/C++-only
 *
 * Three things, and only the first is about node names:
 *
 * 1. **A query per language.** Node types differ (`func_declaration`, `def`,
 *    `function_item`), and so does what counts as a definition.
 *
 * 2. **Method-ness is contextual in some languages and syntactic in others.**
 *    JavaScript has a `method_definition` node; Python has one
 *    `function_definition` used for both `def f()` at a module level and
 *    `def f(self)` inside a class. A query cannot see the difference for the
 *    second kind, so `parser.ts` refines it: it walks ancestors from the
 *    definition node and returns method/product based on the nearest **callable
 *    or container** it finds. `callableNodes` and `methodContainers` below are
 *    the data that walk needs — see the comment on `LanguageQueryDefinition`.
 *
 * 3. **Two languages here are *queries over identities*, not just names.**  Not
 *    really; that is `handlers.ts`'s problem. Kept out on purpose.
 *
 * ## The two C/C++-specific compromises are still C/C++-specific
 *
 * A. **`.c` files are parsed with the C++ grammar.** `@vscode/tree-sitter-wasm`
 *    ships no `tree-sitter-c.wasm` at all (only cpp, c-sharp, go, java,
 *    javascript, python, ruby, rust, tsx, typescript). C++ is a superset of C,
 *    so the cpp grammar parses C cleanly — `hasError` is false on real C — and
 *    the C query only names nodes that exist in both grammars. This is a real
 *    compromise and is recorded in the spec (§20.7).
 *
 * B. **`struct`/`union`/`enum`/`class` patterns require a `body`.** Without the
 *    `body: (_)` guard, `struct point p;` — a *use* — is captured as a
 *    definition. That guard is what keeps ordinary locals out of the symbol
 *    index. The guard is applied everywhere, not just C: `struct Foo {` in C#
 *    and `class A` in Java both need it for the same reason.
 *
 * ## Every definition pattern captures its node *twice*
 *
 * `@name` is the identifier, and `@definition.<kind>` is the whole definition
 * node. This is load-bearing, not cosmetic: capturing only `@definition.*` *on
 * the identifier* makes `endLine` equal `startLine`, so the symbol index cannot
 * answer "which function contains line N" (§5.1 rule 3). The two captures are
 * paired by iterating `Query.matches()` rather than `Query.captures()`, since
 * only a match groups the captures of one pattern occurrence.
 *
 * ## `@qualifier`
 *
 * An optional third capture. Where a method's owner is *in the name* (C++'s
 * `geo::Shape::helper`) `parser.ts` splits it; where the owner is a **sibling
 * field** rather than an enclosing node — Go's `func (g *Greeter) Hello`, whose
 * receiver is a sibling of the body — the query has to say so, and this capture
 * is how. If a language sets both, the explicit capture wins.
 */

/**
 * One language's grammar file, query text, and the two node-type lists the
 * method/product refinement in `parser.ts` needs.
 */
export interface LanguageQueryDefinition {
  /** Wasm grammar filename under `@vscode/tree-sitter-wasm/wasm/`. */
  wasmFile: string
  /**
   * Node types that are themselves callables. The ancestor walk stops at the
   * nearest of these and returns "free function": a `def` inside a `def` is a
   * nested function, not a method of whatever class encloses both.
   */
  callableNodes: readonly string[]
  /**
   * Node types that make a nested callable a **method**, and whose `name` field
   * supplies its qualifier. Nearest-wins, and a callable found first suppresses
   * them — which is what keeps a closure inside a method from being attributed
   * to the class.
   */
  methodContainers: readonly string[]
  query: string
}

/** Definitions and call sites common to C and C++. */
export const C_QUERY = `
; --- function definitions ---
(function_definition
  declarator: (function_declarator
    declarator: (identifier) @name)) @definition.function

; pointer-returning and pointer-to-function definitions
(function_definition
  declarator: (pointer_declarator
    declarator: (function_declarator
      declarator: (identifier) @name))) @definition.function

; --- composite type definitions (body required: see note B) ---
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(union_specifier name: (type_identifier) @name body: (_)) @definition.union
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.typedef

; --- call sites ---
(call_expression function: (identifier) @reference.call)

; The capture goes ON the field identifier. Attaching it to the enclosing
; field_expression captures the whole "r.area" text instead of just "area",
; which could never resolve against a symbol named "area".
(call_expression
  function: (field_expression field: (field_identifier) @reference.call))
`

/**
 * C++ adds classes, namespaces, out-of-line method definitions, and
 * scope-qualified calls.
 */
export const CPP_QUERY =
  C_QUERY +
  `
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(namespace_definition name: (namespace_identifier) @name) @definition.namespace

; Inline methods. This pattern did not exist until the program model stopped
; being C/C++-only, and its absence was a **recall hole rather than a
; mislabel**: a method defined inside a class body declares its name as a
; \`field_identifier\`, which the C query's \`(identifier)\` pattern never matched.
; So \`int area(int n) { return helper(n); }\` inside a class produced *no*
; symbol at all, and every region sweep built on this index — patch-mined
; siblings, the toctou sweep, the pattern-library match — was blind to every
; bug inside an inline method. It surfaced here only because promoting inline
; methods to kind \`method\` required them to be indexed first.
(function_definition
  declarator: (function_declarator
    declarator: (field_identifier) @name)) @definition.function

; Out-of-line methods, e.g. \`int geo::Shape::helper(int x)\`. The name field
; holds only the last segment (\`helper\`), so the owner is captured from the
; \`scope\` field — enough for \`Shape::helper\` and for \`a::b::c\`, where scope is
; itself a qualified_identifier whose last segment is the owner.
(function_definition
  declarator: (function_declarator
    declarator: (qualified_identifier
      scope: (_) @qualifier
      name: (_) @name))) @definition.function

(call_expression
  function: (qualified_identifier name: (_)) @reference.call)
`

/**
 * Python's second-hardest case after Ruby.
 *
 * `function_definition` is used for both a module-level `def` and a method, so
 * the query emits `@definition.function` and `methodContainers:
 * ['class_definition']` lets the parser promote the nested ones. Decorated
 * definitions need no separate pattern — the plain one matches the inner node at
 * any depth — but they do mean `decorated_definition` must be transparent to the
 * ancestor walk, which is why the walk has no wrapper allowlist and instead
 * stops only at callables and containers (see `LanguageQueryDefinition`).
 */
export const PYTHON_QUERY = `
; --- definitions ---
(class_definition name: (identifier) @name body: (_)) @definition.class
(function_definition name: (identifier) @name) @definition.function

; --- call sites ---
(call function: (identifier) @reference.call)
(call function: (attribute attribute: (identifier) @reference.call))
`

/**
 * Ruby.
 *
 * `def helper` inside a `module` is a method of the mixin, not a free function,
 * so `module` is a `methodContainers` entry alongside `class`. `def self.build`
 * is a `singleton_method` — a distinct node type — and is captured as a callable
 * so a `def` nested inside it stays a free function.
 */
export const RUBY_QUERY = `
; --- definitions ---
(class name: (constant) @name body: (_)) @definition.class
(module name: (constant) @name body: (_)) @definition.module
(method name: (identifier) @name) @definition.function
(singleton_method name: (identifier) @name) @definition.function

; --- call sites ---
(call method: (identifier) @reference.call)
`

/**
 * Go.
 *
 * Method-ness *is* syntactic here (`method_declaration`), so no container
 * refinement is needed and `methodContainers` is empty. The owner is not an
 * ancestor, though — the receiver is a sibling — so the `@qualifier` capture is
 * how `(*Greeter).Hello` learns it belongs to `Greeter`. The `(_)` in the
 * receiver position matches both `(parameter_list (parameter_declaration type:
 * (type_identifier)))` and the pointer form, and `parser.ts` strips the `*`.
 */
export const GO_QUERY = `
; --- definitions ---
(function_declaration name: (identifier) @name body: (_)) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration type: (_) @qualifier))
  name: (field_identifier) @name
  body: (_)) @definition.method

(type_declaration (type_spec
  name: (type_identifier) @name
  type: (struct_type))) @definition.struct
(type_declaration (type_spec
  name: (type_identifier) @name
  type: (interface_type))) @definition.interface

; --- call sites ---
(call_expression function: (identifier) @reference.call)
(call_expression
  function: (selector_expression field: (field_identifier) @reference.call))
`

/**
 * Java.
 *
 * Unlike Python, `method_declaration` is already distinct, and it appears in
 * both `class_body` and `interface_body` — an interface method has no body and
 * is still a method, so no `body` guard is used. `constructor_declaration` is
 * the other callable. Containers exist only for the qualifier: a Java method
 * names its class nowhere in its own text.
 */
export const JAVA_QUERY = `
; --- definitions ---
(class_declaration name: (identifier) @name body: (_)) @definition.class
(interface_declaration name: (identifier) @name body: (_)) @definition.interface
(enum_declaration name: (identifier) @name body: (_)) @definition.enum
(record_declaration name: (identifier) @name body: (_)) @definition.class
(annotation_type_declaration name: (identifier) @name) @definition.interface

(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method

; --- call sites ---
(method_invocation name: (identifier) @reference.call)
(object_creation_expression type: (type_identifier) @reference.call)
`

/**
 * The half of the JavaScript query that TypeScript also accepts verbatim.
 *
 * Split out because it is not factored for tidiness: the TypeScript grammar
 * **renames `class_declaration`'s name field** from `identifier` to
 * `type_identifier`, and its query compiler rejects the JavaScript spelling
 * outright ("Bad pattern structure") rather than simply never matching it. So
 * the class pattern *cannot* be shared, and a composed query that assumes it can
 * fails to compile at all — which is a better failure than a silent one, but
 * still one that has to be designed around. Each language supplies its own
 * `class_declaration` pattern.
 */
export const JS_SHARED_QUERY = `
; --- definitions ---
(function_declaration name: (identifier) @name body: (_)) @definition.function
(generator_function_declaration name: (identifier) @name body: (_)) @definition.function
(method_definition name: (property_identifier) @name body: (_)) @definition.method
(variable_declarator
  name: (identifier) @name
  value: (arrow_function)) @definition.function
(variable_declarator
  name: (identifier) @name
  value: (function_expression)) @definition.function

; --- call sites ---
(call_expression function: (identifier) @reference.call)
(call_expression
  function: (member_expression property: (property_identifier) @reference.call))
(new_expression constructor: (identifier) @reference.call)
`

/**
 * JavaScript.
 *
 * The arrow-function patterns are why a symbol can have a definition node that
 * is not a function node: `const f = () => x` makes the *declarator* the
 * symbol, so `startLine`/`endLine` span the whole assignment. That is the useful
 * answer — the region a reviewer would look at — and it is consistent with how
 * C's pointer-to-function definitions were already handled.
 */
export const JAVASCRIPT_QUERY =
  JS_SHARED_QUERY +
  `(class_declaration name: (identifier) @name body: (_)) @definition.class
`

/**
 * TypeScript = JavaScript + the type-level declarations.
 *
 * `internal_module` is this grammar's node type for `namespace Geo {}`; the
 * ambient `module "foo"` form is deliberately omitted, since its name is a
 * string literal and there is nothing to resolve it against.
 *
 * Built from `JS_SHARED_QUERY` plus TypeScript's own `class_declaration`
 * pattern, not from `JAVASCRIPT_QUERY` — see the comment on `JS_SHARED_QUERY`
 * for why the class pattern in particular cannot be inherited.
 */
export const TYPESCRIPT_QUERY =
  JS_SHARED_QUERY +
  `
(class_declaration name: (type_identifier) @name body: (_)) @definition.class
(abstract_class_declaration name: (type_identifier) @name body: (_)) @definition.class
(interface_declaration name: (type_identifier) @name body: (_)) @definition.interface
(enum_declaration name: (identifier) @name body: (_)) @definition.enum
(type_alias_declaration name: (type_identifier) @name) @definition.typedef
(internal_module name: (identifier) @name body: (_)) @definition.module
`

/**
 * C#.
 *
 * `namespace_declaration` is captured but is *not* a method container: a method
 * cannot be declared directly in a namespace, so treating it as one would only
 * add noise. `local_function_statement` is a callable so a local function inside
 * a method is not attributed to the class.
 */
export const CSHARP_QUERY = `
; --- definitions ---
(namespace_declaration name: (identifier) @name body: (_)) @definition.namespace
(class_declaration name: (identifier) @name body: (_)) @definition.class
(interface_declaration name: (identifier) @name body: (_)) @definition.interface
(struct_declaration name: (identifier) @name body: (_)) @definition.struct
(record_declaration name: (identifier) @name body: (_)) @definition.class
(enum_declaration name: (identifier) @name body: (_)) @definition.enum
(delegate_declaration name: (identifier) @name) @definition.typedef

(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function

; --- call sites ---
(invocation_expression function: (identifier) @reference.call)
(invocation_expression
  function: (member_access_expression name: (identifier) @reference.call))
(object_creation_expression type: (identifier) @reference.call)
`

const CALLABLES_C = ['function_definition']
const CALLABLES_JS = [
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'arrow_function',
  'method_definition',
]

/**
 * Language id → grammar, query, and refinement data.
 *
 * `rust`, `go`, `python`, `javascript`, `typescript`, `tsx`, `java`, `ruby` and
 * `csharp` all ship a wasm grammar in `@vscode/tree-sitter-wasm`, which is
 * already a dependency — so nine of these ten languages cost no new package.
 */
export const LANGUAGE_QUERIES: Record<string, LanguageQueryDefinition> = {
  c: {
    wasmFile: 'tree-sitter-cpp.wasm',
    callableNodes: CALLABLES_C,
    methodContainers: [],
    query: C_QUERY,
  },
  cpp: {
    wasmFile: 'tree-sitter-cpp.wasm',
    callableNodes: CALLABLES_C,
    // An inline `void f() {}` in a class body is a method, and until this list
    // existed the index called it a function. Both are callable, so no consumer
    // depended on the distinction — which is precisely why it went unnoticed.
    methodContainers: ['class_specifier', 'struct_specifier'],
    query: CPP_QUERY,
  },
  python: {
    wasmFile: 'tree-sitter-python.wasm',
    callableNodes: ['function_definition'],
    methodContainers: ['class_definition'],
    query: PYTHON_QUERY,
  },
  ruby: {
    wasmFile: 'tree-sitter-ruby.wasm',
    callableNodes: ['method', 'singleton_method'],
    methodContainers: ['class', 'module', 'singleton_class'],
    query: RUBY_QUERY,
  },
  go: {
    wasmFile: 'tree-sitter-go.wasm',
    callableNodes: ['function_declaration', 'method_declaration', 'func_literal'],
    methodContainers: [],
    query: GO_QUERY,
  },
  java: {
    wasmFile: 'tree-sitter-java.wasm',
    callableNodes: ['method_declaration', 'constructor_declaration', 'lambda_expression'],
    methodContainers: [
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'annotation_type_declaration',
    ],
    query: JAVA_QUERY,
  },
  javascript: {
    wasmFile: 'tree-sitter-javascript.wasm',
    callableNodes: CALLABLES_JS,
    methodContainers: ['class_declaration'],
    query: JAVASCRIPT_QUERY,
  },
  typescript: {
    wasmFile: 'tree-sitter-typescript.wasm',
    callableNodes: CALLABLES_JS,
    methodContainers: ['class_declaration', 'abstract_class_declaration'],
    query: TYPESCRIPT_QUERY,
  },
  tsx: {
    // TSX is a separate grammar, not a mode of the TypeScript one: the JSX
    // productions change how `<` is parsed, so a `.tsx` file parsed with
    // `tree-sitter-typescript.wasm` produces errors on every component.
    wasmFile: 'tree-sitter-tsx.wasm',
    callableNodes: CALLABLES_JS,
    methodContainers: ['class_declaration', 'abstract_class_declaration'],
    query: TYPESCRIPT_QUERY,
  },
  csharp: {
    wasmFile: 'tree-sitter-c-sharp.wasm',
    callableNodes: [
      'method_declaration',
      'constructor_declaration',
      'local_function_statement',
      'lambda_expression',
    ],
    methodContainers: [
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'record_declaration',
    ],
    query: CSHARP_QUERY,
  },
  rust: {
    // Rust was listed in `PROGRAM_MODEL_LANGUAGES`'s unsupported set before this
    // query existed. It is included here so a Rust target indexes; the region
    // *sweeps* over Rust still see C-shaped tables, which is the second half of
    // the multi-language work and is recorded as such in the spec.
    wasmFile: 'tree-sitter-rust.wasm',
    callableNodes: ['function_item', 'closure_expression'],
    methodContainers: ['impl_item', 'trait_item'],
    query: `
; --- definitions ---
(function_item name: (identifier) @name body: (_)) @definition.function
(struct_item name: (type_identifier) @name body: (_)) @definition.struct
(enum_item name: (type_identifier) @name body: (_)) @definition.enum
(union_item name: (type_identifier) @name body: (_)) @definition.union
(trait_item name: (type_identifier) @name body: (_)) @definition.trait
(type_item name: (type_identifier) @name) @definition.typedef
(mod_item name: (identifier) @name body: (_)) @definition.module

; "impl Geo for Shape { fn area(&self) -> f64 { .. } }". Captured without a
; body requirement because a declaration-only trait impl is still a container.
(impl_item type: (type_identifier) @name) @definition.impl

; --- call sites ---
(call_expression function: (identifier) @reference.call)
(call_expression
  function: (field_expression field: (field_identifier) @reference.call))
(call_expression
  function: (scoped_identifier name: (identifier) @reference.call))
`,
  },
}
