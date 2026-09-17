/**
 * Transitive reachability (spec §4.4.4).
 *
 * `interproc/callgraph.ts` answers "who calls this" for one hop. This module walks
 * the closure: from each entry point, which definitions can an attacker's input
 * actually arrive at, and how far away is it.
 *
 * ## The one rule this module refuses to break
 *
 * **"No path found" is not "unreachable".** A site is `unreachable` only when the
 * search is complete for it — every caller set on the way in is accounted for. Four
 * things can make it incomplete, and each one downgrades the answer to `unknown` with
 * a sentence saying which:
 *
 * 1. **No entry point was identified.** If the inventory is empty the honest answer is
 *    unknown for everything, because "this target has no entry point" is a claim about
 *    the parse, not about the program.
 * 2. **A call site outside every indexed callable.** A call in a global initialiser, or
 *    in a file recon could not parse, names a callee but has no caller to attribute it
 *    to. That callee may be called from anywhere, so it and everything downstream of it
 *    are unknown — this is what `graph.droppedCallersOf()` exists for, and here it is
 *    finally read for a positive conclusion.
 * 3. **An ambiguous callee name**, folded into 2: several files define it and no
 *    same-file match resolved the call, so the dropped edge may have belonged to *this*
 *    definition.
 * 4. **A qualified call reference** — `Q::f`, which a name index cannot resolve because it
 *    holds `f` with `Q` in a separate column. It makes no edge *and* is never dropped, so
 *    nothing else in this analysis sees it; `qualifiedReferences` reads the tail off
 *    `graph.unresolvedNames` and taints whatever definition it could name. This is the one
 *    case a real target found for us rather than a fixture: a recursive method called only
 *    through `gzfilestream_common::attach` came back `unreachable` (§20.39.8).
 *
 * Anything downstream of 2, 3 or 4 is tainted too: an unknown caller of F makes F possibly
 * reachable, and therefore everything F calls possibly reachable. Tainting stops at
 * anything a real entry point already reached, because a real path settles the question.
 *
 * Not in that list, and worth stating because it is invisible to this analysis: a call
 * through a **function pointer** whose target is not named at the call site. The
 * address-taken function has no incoming edge by name, so it appears as `unrooted` — an
 * entry of its own — and a site reachable only through it is `exposed-api`, not
 * unreachable. The narrow hole left over is a function called by name only from
 * unreachable code *and* reached through a pointer from reachable code; the coverage
 * record carries the count of callee names with no definition, which is where such a
 * call shows up.
 *
 * ## Why the classification is four values and not a boolean
 *
 * | class | what it means | how it may be used |
 * |---|---|---|
 * | `attacker-input` | a path exists from `main`, a fuzz entry, or a call that reads input | the claim a triager asks for |
 * | `exposed-api` | reached only from a function nothing in the index calls: an exported symbol, a callback registered by address, or dead code | weaker: for a library the caller is the attacker |
 * | `unreachable` | called by name, but no entry reaches it and the caller sets are complete | not reportable — a defect here is not an attack on this program |
 * | `unknown` | the search could not be completed | reportable with the reason stated: absence of evidence |
 *
 * BFS rather than a fixpoint over summaries, because the graph is finite and walked per
 * target, and a summary would need invalidating on every edit to the program model.
 */

import { definitionKey, enclosingCallable } from '../interproc'

import { ATTACKER_INPUT_KINDS, ENTRY_KINDS } from './entries'

import type { CallEdge, CallGraph, CallGraphDefinition } from '../interproc'
import type { EntryKind, EntryPoint } from './entries'

export const REACHABILITY_CLASSES = [
  'attacker-input',
  'exposed-api',
  'unreachable',
  'unknown',
] as const
export type ReachabilityClass = (typeof REACHABILITY_CLASSES)[number]

/**
 * The classes that are a *claim of reachability*, strongest first.
 *
 * Ordered rather than spelled as a set so a surface that has to pick one — the scan
 * summary, the evidence bundle — takes the strongest rather than whichever it happened
 * to see first. `unreachable` and `unknown` are not in it: neither is a claim that
 * anything is reachable.
 */
export const REACHABLE_CLASSES: readonly ReachabilityClass[] = ['attacker-input', 'exposed-api']

/** One hop on the path from an entry point to a site. */
export interface ReachStep {
  filePath: string
  name: string
  /** The call site's line, or null for the entry point itself. */
  line: number | null
}

/** The entry a path starts at, as plain data, so it survives into the record. */
export interface ReachEntryRef {
  filePath: string
  name: string
  kind: EntryKind
  reason: string
}

export interface ReachabilityRecord {
  filePath: string
  name: string
  klass: ReachabilityClass
  /** Hops from the entry that reached it. Null unless reached. */
  distance: number | null
  entry: ReachEntryRef | null
  /**
   * Why this is `unknown` rather than `unreachable`, in the reader's terms. Empty for
   * every other class: a reached definition needs no excuse, and an `unreachable` one
   * has none to make.
   */
  incomplete: readonly string[]
}

/**
 * What is known about one candidate's location.
 *
 * `definition` is null when the site sits outside every indexed callable — a
 * declaration, a preprocessor block, a file recon never parsed. That is `unknown`,
 * never `unreachable`: nothing is being claimed about a function that was not found.
 */
export interface SiteReachability {
  definition: CallGraphDefinition | null
  klass: ReachabilityClass
  distance: number | null
  entry: ReachEntryRef | null
  incomplete: readonly string[]
}

export interface ReachCounts {
  /** Callable definitions the model holds — the denominator for the four classes. */
  definitions: number
  entries: number
  attackerInput: number
  exposedApi: number
  unreachable: number
  unknown: number
}

/**
 * The numbers that say how much of the graph the classification rests on.
 *
 * Carried beside the counts for the reason `callSitesUnattributed` is: an empty
 * `unreachable` count and a graph that could not be built must not read the same.
 */
export interface ReachCoverage {
  entries: number
  entryKinds: Record<EntryKind, number>
  callEdges: number
  callSitesSeen: number
  callSitesUnattributed: number
  /** Callee names with no indexed definition: a libc call, or a call through a pointer. */
  externalCallees: number
  /**
   * The subset of `externalCallees` written with a class or namespace qualifier.
   *
   * `Q::f` cannot resolve against an index that holds `f` with `Q` in a separate column, so
   * each one is not only an unresolved call but an *unattributable* one: the reference never
   * became an edge and was never dropped, so `taintRoots` is the only place it shows up. A
   * zlib scan where this count was invisible produced a false `unreachable` (§20.39.8), and
   * the number is printed beside the others so the next reader can see the window.
   */
  qualifiedCallees: number
  ambiguousCallees: number
  /** Definitions whose caller set is incomplete, so nothing downstream is settled. */
  taintRoots: number
  /** True when no path may be called complete because the inventory is empty. */
  noEntries: boolean
}

export interface ReachabilityAnalysis {
  entries: readonly EntryPoint[]
  records: readonly ReachabilityRecord[]
  /** The record for one definition, or null when the model has no such callable. */
  recordFor: (filePath: string, name: string) => ReachabilityRecord | null
  /**
   * The shortest path from an entry to one definition, entry first, target last.
   *
   * Reconstructed on demand from the BFS parent links rather than stored per
   * definition: a path per node is `O(V × depth)` memory, which on a target with tens
   * of thousands of callables is the difference between a table of numbers and a
   * second copy of the graph.
   */
  pathFor: (filePath: string, name: string) => readonly ReachStep[]
  /** Everything known about one file/line site. */
  site: (filePath: string, line: number) => SiteReachability
  counts: ReachCounts
  coverage: ReachCoverage
}

/** Where a node was reached from, for path reconstruction. */
interface Parent {
  filePath: string
  name: string
  line: number | null
}

interface Search {
  /** Distance per node key. Roots are 0. */
  distances: Map<string, number>
  /** The entry a node was reached from; null for taint roots, which are not entries. */
  entries: Map<string, EntryPoint | null>
  /** Why a taint-reached node is unknown. */
  reasons: Map<string, string>
  /** The edge a node was reached through, for `pathFor`. */
  parents: Map<string, Parent>
  /** Root keys, so a reason can tell a root from a node below one. */
  roots: Set<string>
}

interface Root {
  filePath: string
  name: string
  /** The entry this root *is*, when it is one. Null for a taint root. */
  entry: EntryPoint | null
  /** Why this root is unknown, when it is a taint root. */
  reason?: string
}

/**
 * Breadth-first spread from a set of roots.
 *
 * `skip` nodes are neither entered nor traversed through, which is what keeps a later
 * pass from relabelling something an earlier one already settled — the classification
 * is a priority, not a vote. Roots are seeded in the order given, so two runs over the
 * same model reach a node through the same entry: a finding whose path is a different
 * chain each run is not an artifact anyone can review.
 */
const spread = (
  roots: readonly Root[],
  edgesFrom: ReadonlyMap<string, readonly CallEdge[]>,
  skip: ReadonlySet<string>,
): Search => {
  const search: Search = {
    distances: new Map(),
    entries: new Map(),
    reasons: new Map(),
    parents: new Map(),
    roots: new Set(),
  }
  const queue: string[] = []

  for (const root of roots) {
    const key = definitionKey(root.filePath, root.name)
    if (skip.has(key) || search.distances.has(key)) continue
    search.distances.set(key, 0)
    search.entries.set(key, root.entry)
    search.roots.add(key)
    if (root.reason !== undefined) search.reasons.set(key, root.reason)
    queue.push(key)
  }

  for (let head = 0; head < queue.length; head += 1) {
    const from = queue[head]!
    const distance = search.distances.get(from)!
    const entry = search.entries.get(from) ?? null
    const reason = search.reasons.get(from)

    for (const edge of edgesFrom.get(from) ?? []) {
      const key = definitionKey(edge.toFile, edge.toFunction)
      if (skip.has(key) || search.distances.has(key)) continue

      search.distances.set(key, distance + 1)
      search.entries.set(key, entry)
      search.parents.set(key, { filePath: edge.fromFile, name: edge.fromFunction, line: edge.line })
      // The reason is inherited rather than recomputed, so it names the incomplete
      // caller set that actually makes this branch unsettled instead of the node's own
      // — which is complete, and would read as a contradiction.
      if (reason !== undefined) search.reasons.set(key, reason)
      queue.push(key)
    }
  }

  return search
}

/**
 * The unresolved references whose written name carries a qualifier, indexed by their tail.
 *
 * `Q::f` is captured as a call reference exactly as written, and resolution compares that
 * whole string against a definition index that holds `f` with `Q` in a separate column — so
 * it resolves to nothing. No edge results, and because the reference never resolved it was
 * never *dropped* either, which is why `droppedCallersOf` cannot see it. On a real zlib scan
 * that turned a method called only through `Q::f` into a false `unreachable` (§20.39.8).
 *
 * Matching on the tail is deliberately coarse: it says "some qualified reference ends in this
 * name", not "this definition is the one that reference names". A definition with a common
 * method name — `size`, `reset`, `init` — can be tainted by a qualified call to a different
 * type's method of the same name. That is the safe direction: the cost is `unknown` where the
 * graph was in fact complete, and the alternative is `unreachable` where it was not.
 */
const qualifiedReferences = (unresolvedNames: readonly string[]): {
  byTail: Map<string, string[]>
  total: number
} => {
  const byTail = new Map<string, string[]>()
  let total = 0

  for (const name of unresolvedNames) {
    const separator = name.lastIndexOf('::')
    // A leading `::` or a trailing one is not a qualified call with a nameable tail.
    if (separator <= 0 || separator + 2 >= name.length) continue
    total += 1
    const tail = name.slice(separator + 2)
    const list = byTail.get(tail)
    if (list) list.push(name)
    else byTail.set(tail, [name])
  }

  return { byTail, total }
}

/**
 * The sentence a reader gets when a definition's own callers are incomplete.
 *
 * Three ways a caller can be missed, and they are named separately because the reader's next
 * step differs: an unattributed call site needs a better parse, an ambiguous name needs the
 * qualifier, and a qualified reference needs the resolved definition this name graph does not
 * keep.
 */
export const droppedCallersReason = (input: {
  unattributed: number
  ambiguous: number
  /** Qualified references (`Q::f`) whose tail is this definition's name. */
  qualified?: readonly string[]
}): string => {
  const parts: string[] = []
  if (input.unattributed > 0) {
    parts.push(
      `${input.unattributed} call site(s) naming it sit outside every indexed callable ` +
        '(a global initialiser, or a file recon could not parse)',
    )
  }
  if (input.ambiguous > 0) {
    parts.push(
      `${input.ambiguous} call site(s) naming it were dropped because several files define ` +
        'that name, so one of them may belong to this definition',
    )
  }
  const qualified = input.qualified ?? []
  if (qualified.length > 0) {
    const shown = qualified.slice(0, 3).join(', ')
    parts.push(
      `${qualified.length} call reference(s) naming it were written with a class or namespace ` +
        `qualifier (${shown}${qualified.length > 3 ? ', …' : ''}), which a name-only index ` +
        'cannot resolve to a definition of its own',
    )
  }
  return `${parts.join(', and ')} — it may be called from a caller this analysis cannot see`
}

const taintReasonBelow = (parent: Parent): string =>
  `nothing reaches it from an entry point, but it is called by ${parent.name} ` +
  `(${parent.filePath}:${parent.line ?? '?'}), whose own caller set is incomplete`

const klassCountKey = (klass: ReachabilityClass): keyof ReachCounts =>
  klass === 'attacker-input'
    ? 'attackerInput'
    : klass === 'exposed-api'
      ? 'exposedApi'
      : klass === 'unreachable'
        ? 'unreachable'
        : 'unknown'

const entryRef = (entry: EntryPoint | null): ReachEntryRef | null =>
  entry === null
    ? null
    : { filePath: entry.filePath, name: entry.name, kind: entry.kind, reason: entry.reason }

export const analyzeReachability = (input: {
  graph: CallGraph
  definitions: readonly CallGraphDefinition[]
  entries: readonly EntryPoint[]
}): ReachabilityAnalysis => {
  const { graph, definitions, entries } = input

  const edgesFrom = new Map<string, CallEdge[]>()
  for (const edge of graph.edges) {
    const key = definitionKey(edge.fromFile, edge.fromFunction)
    const list = edgesFrom.get(key)
    if (list) list.push(edge)
    else edgesFrom.set(key, [edge])
  }

  const byFile = new Map<string, CallGraphDefinition[]>()
  for (const definition of definitions) {
    const list = byFile.get(definition.filePath)
    if (list) list.push(definition)
    else byFile.set(definition.filePath, [definition])
  }

  // Three spreads, in priority order. Each skips what the previous settled.
  const fromAttackerInput = spread(
    entries
      .filter((entry) => ATTACKER_INPUT_KINDS.includes(entry.kind))
      .map((entry) => ({ filePath: entry.filePath, name: entry.name, entry })),
    edgesFrom,
    new Set(),
  )
  const settledByInput = new Set(fromAttackerInput.distances.keys())

  const fromUnrooted = spread(
    entries
      .filter((entry) => entry.kind === 'unrooted')
      .map((entry) => ({ filePath: entry.filePath, name: entry.name, entry })),
    edgesFrom,
    settledByInput,
  )

  const settled = new Set([...settledByInput, ...fromUnrooted.distances.keys()])

  // Definitions whose caller set is incomplete: whatever they are, nothing they reach
  // can be called unreachable. The only place `droppedCallersOf` and the qualified-tail
  // index are read for a *positive* conclusion rather than as a veto.
  const qualified = qualifiedReferences(graph.unresolvedNames)
  const taintRoots: Root[] = []
  for (const definition of definitions) {
    const key = definitionKey(definition.filePath, definition.name)
    if (settled.has(key)) continue
    const dropped = graph.droppedCallersOf(definition.name)
    const qualifiedNames = qualified.byTail.get(definition.name) ?? []
    if (dropped.unattributed === 0 && dropped.ambiguous === 0 && qualifiedNames.length === 0) {
      continue
    }
    taintRoots.push({
      filePath: definition.filePath,
      name: definition.name,
      entry: null,
      reason: droppedCallersReason({ ...dropped, qualified: qualifiedNames }),
    })
  }

  const tainted = spread(taintRoots, edgesFrom, settled)

  // An empty inventory makes every answer unknown. Applied here rather than instead of
  // the spreads so the reason can say why: the spreads found nothing because there was
  // nowhere to start.
  const noEntries = entries.length === 0

  const counts: ReachCounts = {
    definitions: definitions.length,
    entries: entries.length,
    attackerInput: 0,
    exposedApi: 0,
    unreachable: 0,
    unknown: 0,
  }

  const records: ReachabilityRecord[] = []
  const byKey = new Map<string, ReachabilityRecord>()

  for (const definition of definitions) {
    const key = definitionKey(definition.filePath, definition.name)
    const base = { filePath: definition.filePath, name: definition.name }

    let record: ReachabilityRecord
    if (noEntries) {
      record = {
        ...base,
        klass: 'unknown',
        distance: null,
        entry: null,
        incomplete: [
          'no entry point was identified in this target, so nothing can be said about what ' +
            'reaches this code — an empty inventory is a statement about the parse, not the program',
        ],
      }
    } else if (fromAttackerInput.distances.has(key)) {
      record = {
        ...base,
        klass: 'attacker-input',
        distance: fromAttackerInput.distances.get(key)!,
        entry: entryRef(fromAttackerInput.entries.get(key) ?? null),
        incomplete: [],
      }
    } else if (fromUnrooted.distances.has(key)) {
      record = {
        ...base,
        klass: 'exposed-api',
        distance: fromUnrooted.distances.get(key)!,
        entry: entryRef(fromUnrooted.entries.get(key) ?? null),
        incomplete: [],
      }
    } else if (tainted.distances.has(key)) {
      const root = tainted.roots.has(key)
      const parent = tainted.parents.get(key) ?? null
      record = {
        ...base,
        klass: 'unknown',
        distance: null,
        entry: null,
        incomplete: [
          root || parent === null
            ? (tainted.reasons.get(key) ?? 'the caller set of this definition is incomplete')
            : taintReasonBelow(parent),
        ],
      }
    } else {
      record = { ...base, klass: 'unreachable', distance: null, entry: null, incomplete: [] }
    }

    counts[klassCountKey(record.klass)] += 1
    records.push(record)
    byKey.set(key, record)
  }

  const pathFor = (filePath: string, name: string): readonly ReachStep[] => {
    const key = definitionKey(filePath, name)
    const search = fromAttackerInput.distances.has(key)
      ? fromAttackerInput
      : fromUnrooted.distances.has(key)
        ? fromUnrooted
        : null
    if (!search) return []

    const steps: ReachStep[] = []
    let cursor = { filePath, name }
    for (;;) {
      const parent = search.parents.get(definitionKey(cursor.filePath, cursor.name))
      if (!parent) break
      steps.unshift({ filePath: cursor.filePath, name: cursor.name, line: parent.line })
      cursor = { filePath: parent.filePath, name: parent.name }
    }
    steps.unshift({ filePath: cursor.filePath, name: cursor.name, line: null })
    return steps
  }

  const site = (filePath: string, line: number): SiteReachability => {
    const definition = enclosingCallable(byFile.get(filePath) ?? [], line)
    if (!definition) {
      return {
        definition: null,
        klass: 'unknown',
        distance: null,
        entry: null,
        incomplete: [
          `the site is not inside any indexed callable in ${filePath}, so nothing can be said ` +
            'about how it is reached',
        ],
      }
    }

    const record = byKey.get(definitionKey(definition.filePath, definition.name))
    if (!record) {
      // Unreachable in practice: `records` covers every definition passed in. Kept so a
      // caller that passed a different definition set gets `unknown` rather than a crash.
      return {
        definition,
        klass: 'unknown',
        distance: null,
        entry: null,
        incomplete: [`${definition.name} has no reachability record`],
      }
    }

    return {
      definition,
      klass: record.klass,
      distance: record.distance,
      entry: record.entry,
      incomplete: record.incomplete,
    }
  }

  const entryKinds = Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, 0])) as Record<
    EntryKind,
    number
  >
  for (const entry of entries) entryKinds[entry.kind] += 1

  const coverage: ReachCoverage = {
    entries: entries.length,
    entryKinds,
    callEdges: graph.edges.length,
    callSitesSeen: graph.referencesSeen,
    callSitesUnattributed: graph.unattributed,
    externalCallees: graph.unresolved.length,
    qualifiedCallees: qualified.total,
    ambiguousCallees: graph.ambiguous.length,
    taintRoots: taintRoots.length,
    noEntries,
  }

  return {
    entries,
    records,
    recordFor: (filePath, name) => byKey.get(definitionKey(filePath, name)) ?? null,
    pathFor,
    site,
    counts,
    coverage,
  }
}
