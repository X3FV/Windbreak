/**
 * Where a program can be entered from (spec §4.4.4).
 *
 * Reachability is only as honest as this list, so an entry is a *claim with a reason*
 * rather than a boolean a heuristic produced. Four kinds, and they are deliberately not
 * equal — the difference between them is the difference between "an attacker's bytes
 * arrive here" and "something outside the index calls this":
 *
 * - **`main`** — the definition named `main`. Certain, and nothing about it is inferred:
 *   a program has one or has none. What it *means* is the reader's call, and the reason
 *   says which: argv, environment and standard input are the input surface of a
 *   process-level target, which is not the same claim as attacker control for a setuid
 *   helper whose argv the attacker does not choose.
 * - **`fuzz-entry`** — libFuzzer's `LLVMFuzzerTestOneInput`. The strongest kind available
 *   and the only one where the input is arbitrary *by construction*: the fuzzer hands the
 *   function bytes and nothing else. A project that ships a harness has told you this
 *   function is its attack surface.
 * - **`input-source`** — a callable that calls one of the curated readers below. It says
 *   "input arrives here", not "an attacker chooses it"; the reason names the call so the
 *   reader can tell a socket from a config file.
 * - **`unrooted`** — nothing in the indexed program calls it **and no call site naming it
 *   was dropped**, so it is reached from outside the index. That is one of four things and
 *   this module cannot tell which: an exported API (the target is a library and the
 *   attacker is its caller), a callback registered by address, a function only reachable
 *   through a function pointer, or dead code. It is *not* an attacker-input kind, and
 *   treating it as one would make almost everything reachable and the whole feature
 *   decorative.
 *
 *   The distinction between "nothing calls it" and "nothing *resolvable* calls it" is
 *   load-bearing rather than pedantic. A definition with a call site naming it that the
 *   graph could not attribute — a call from a global initialiser, or a name several files
 *   define — is called by *someone*, and calling it an unrooted entry would launder an
 *   unresolvable call into an `exposed-api` conclusion, which is a class the report treats
 *   as reachable. Such a definition is left out of the inventory instead, and
 *   `graph.ts` marks it and everything downstream of it `unknown`.
 *
 * ## Why `unrooted` is not simply dropped
 *
 * For a library target — the shape most memory-safety bounty programs actually have — the
 * caller *is* the attacker, and its entry point is the exported function. Excluding
 * `unrooted` would make every finding in a library unreachable and the tool useless
 * exactly where it applies. So it is kept and classified separately: a site reached only
 * from `unrooted` is `exposed-api`, which is a weaker statement than `attacker-input` and
 * is reported as such.
 *
 * ## The reader list is data, and it is short on purpose
 *
 * `INPUT_SOURCE_CALLS` is a map from the callee name as written to the reason it counts.
 * Adding to it is a decision with a consequence — every function that calls the new name
 * becomes an entry, and every function reachable from it becomes reachable — so it is a
 * reviewed list rather than a pattern. The names are matched exactly, because
 * `read`-prefixed guessing would make `read_config` an input source and a false entry is
 * worse than a missing one: a missing entry costs recall in a stage that reports
 * `unknown`, and a false one launders an unreachable site into a reachable-looking one.
 */

import type { CallGraph, CallGraphDefinition } from '../interproc'

/** Ordered strongest first: the order is the precedence when a definition qualifies twice. */
export const ENTRY_KINDS = ['fuzz-entry', 'main', 'input-source', 'unrooted'] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

/**
 * The kinds whose input is an attacker's by the target's own design.
 *
 * `unrooted` is absent deliberately: a site reached only from an exported function is
 * `exposed-api`, not `attacker-input`, and a union that quietly included it would make
 * the distinction this module exists to draw unrepresentable.
 */
export const ATTACKER_INPUT_KINDS: readonly EntryKind[] = ['fuzz-entry', 'main', 'input-source']

/** libFuzzer's entry point, plus the RunFF-compatible spelling some projects use. */
export const FUZZ_ENTRY_NAMES = ['LLVMFuzzerTestOneInput', 'FuzzerTestOneInput'] as const

/**
 * Calls that mean "input is being read here", with the sentence a reader gets.
 *
 * Deliberately a map rather than a set: the reason is rendered on the finding, and a
 * reader who is told *why* a function counted can disagree with the classification
 * instead of having to trust it.
 */
export const INPUT_SOURCE_CALLS: Readonly<Record<string, string>> = {
  recv: 'reads from a socket',
  recvfrom: 'reads from a socket',
  recvmsg: 'reads from a socket',
  accept: 'accepts a connection',
  read: 'reads from a file descriptor',
  pread: 'reads from a file descriptor',
  readv: 'reads from a file descriptor',
  fread: 'reads from a stream',
  fgets: 'reads from a stream',
  getline: 'reads from a stream',
  scanf: 'parses formatted input',
  fscanf: 'parses formatted input',
  sscanf: 'parses formatted input',
  getenv: 'reads the environment',
  fopen: 'opens a named file',
  open: 'opens a named file',
  openat: 'opens a named file',
  opendir: 'opens a named directory',
}

export interface EntryPoint {
  filePath: string
  name: string
  kind: EntryKind
  /** Why it is an entry, in the reader's terms. Rendered on the finding. */
  reason: string
  /** The input-source calls that qualified it, for `input-source`. Sorted. */
  sources: readonly string[]
}

/** The sentence a reader gets for a kind with no calls behind it. */
const reasonFor = (kind: EntryKind, sources: readonly string[]): string => {
  switch (kind) {
    case 'fuzz-entry':
      return (
        'the project’s own fuzz entry point: the harness hands this function arbitrary ' +
        'bytes, so its input is attacker-controlled by construction'
      )
    case 'main':
      return (
        'the program’s entry point: argv, the environment and standard input arrive here ' +
        'unless the program is invoked in a way that fixes them'
      )
    case 'input-source':
      return `reads input here (${sources
        .map((name) => `${name}: ${INPUT_SOURCE_CALLS[name]}`)
        .join('; ')})`
    case 'unrooted':
      return (
        'nothing in the indexed program calls it and no call site naming it was dropped, so ' +
        'it is reached from outside the index: an exported API, a function taken by address, ' +
        'or dead code — this module cannot tell which'
      )
  }
}

/**
 * Every entry point the program model supports, in definition order.
 *
 * One entry per definition, at its strongest qualifying kind: a `main` that also reads a
 * socket is `main`, and its `sources` still record the socket. Traversal starts once per
 * definition either way, and two entries for one function would only make the depth
 * numbers disagree with each other.
 *
 * An entry is claimed even when the function's *callers* are unresolved — `main` is
 * `main` whatever else calls it — so the dropped-caller check above applies to `unrooted`
 * alone, which is the one kind whose whole claim is about absence of callers.
 *
 * `unrooted` is computed from incoming edges, so a function that is called *only* from a
 * file recon could not parse looks unrooted here. That is the same partiality the graph's
 * `unattributed` counter reports, and `reach/graph.ts` refuses to call anything
 * unreachable while that counter is non-zero for its name.
 */
export const findEntryPoints = (
  graph: CallGraph,
  definitions: readonly CallGraphDefinition[],
): EntryPoint[] => {
  const entries: EntryPoint[] = []

  for (const definition of definitions) {
    const callers = graph.callersOf(definition.filePath, definition.name)

    // From the call *references*, not the resolved edges: every name in
    // `INPUT_SOURCE_CALLS` is a libc function — `recv`, `getenv`, `fopen` — which by
    // definition has no definition in the target and therefore no edge. Asking this of
    // `edgesFrom` would find nothing on any real target and the whole kind would be dead.
    const called = graph.callsOf(definition.filePath, definition.name)
    const sources = [...new Set(called.map((call) => call.name))]
      .filter((name) => name in INPUT_SOURCE_CALLS)
      .sort()
    const dropped = graph.droppedCallersOf(definition.name)
    const isCalled = callers.length > 0 || dropped.unattributed > 0 || dropped.ambiguous > 0

    const kind: EntryKind | null = FUZZ_ENTRY_NAMES.includes(
      definition.name as (typeof FUZZ_ENTRY_NAMES)[number],
    )
      ? 'fuzz-entry'
      : definition.name === 'main'
        ? 'main'
        : sources.length > 0
          ? 'input-source'
          : isCalled
            ? null
            : 'unrooted'

    if (kind === null) continue

    entries.push({
      filePath: definition.filePath,
      name: definition.name,
      kind,
      reason: reasonFor(kind, sources),
      sources,
    })
  }

  return entries
}
