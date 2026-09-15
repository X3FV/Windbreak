/**
 * The interprocedural call graph (spec §4.4.3).
 *
 * §4.4.3 asks for candidate code paths to be validated against the four FSMs "with
 * alias analysis on locks and on the checked/used variables". Everything the module
 * has done so far is *intra*procedural, and the module says so rather than hiding it:
 * the held-lock set is per-function, so a lock held by a caller is invisible
 * (`scan.ts`), and two parameters that point at the same struct are two resources
 * (`alias.ts`). This module is the missing input — which function calls which —
 * needed before either of those can be relaxed.
 *
 * ## It is read out of the program model, not re-derived
 *
 * Recon already persisted the two halves and neither needs parsing again:
 *
 * - `symbol_refs` rows with `kind = 'call'` are call sites, with the callee's name
 *   and the line it was written on (`parser.ts`).
 * - `symbols` rows are the callable regions, with the `start_line`/`end_line` that
 *   say which region a call site falls inside.
 *
 * So attribution is a containment question and resolution is a name question, both
 * answered with plain SQL plus `resolver.ts`. Nothing here reads a source file,
 * which is why this can be built once per sweep rather than per function.
 *
 * ## Three things it deliberately does not claim
 *
 * 1. **It is not a points-to or type analysis.** Names are resolved by the policy in
 *    `resolver.ts`; a C++ overload set is one name here, and a function pointer call
 *    is unattributable because the callee text is a variable rather than a
 *    definition. Both are recall limits, and both are counted below rather than
 *    silently dropped.
 * 2. **It is not transitive.** Edges are one call deep. A closure would need a
 *    fixpoint over summaries that do not exist yet, and every consumer so far wants
 *    one hop. Building the closure here would make the simple question — "who calls
 *    this" — pay for the hard one.
 * 3. **It does not assume the graph is complete.** A call site that no indexed
 *    function covers (`unattributed`) or a callee name the model does not have
 *    (`unresolved`) is *counted*, because a consumer that suppressed a finding on the
 *    strength of "no callers" must be able to tell that from "no callers with a
 *    parsed body". That distinction is the whole reason the counters exist.
 */

import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'
import { buildDefinitionIndex, definitionKey, resolveName } from './resolver'

import type { Database } from 'bun:sqlite'

/** One callable region from the program model. */
export interface CallGraphDefinition {
  filePath: string
  name: string
  /** 1-based inclusive, matching `symbols.start_line`. */
  startLine: number
  /** 1-based inclusive, matching `symbols.end_line`. */
  endLine: number
}

/** One call site from the program model, before attribution. */
export interface CallReference {
  filePath: string
  /** The callee as it was written — a name, not yet a definition. */
  name: string
  /** 1-based, file-relative. */
  line: number
}

/**
 * One resolved call.
 *
 * Both ends carry file *and* function, because the two may be in different files —
 * the same reason `SignalOtherLocation` names its file explicitly rather than
 * relying on the region it came from.
 */
export interface CallEdge {
  fromFile: string
  fromFunction: string
  toFile: string
  toFunction: string
  /** File-relative line of the call site, for evidence. */
  line: number
}

export interface CallGraph {
  /** Every resolved call, in reference order. */
  edges: readonly CallEdge[]
  /** Incoming edges for one definition. Empty when nothing calls it. */
  callersOf: (filePath: string, name: string) => readonly CallEdge[]
  /** Outgoing edges from one definition — the calls it makes, in source order. */
  edgesFrom: (filePath: string, name: string) => readonly CallEdge[]
  /**
   * Call references to a name that could not be placed, so its caller set is
   * partial.
   *
   * This is what stops "no callers hold the lock" from being read off an incomplete
   * graph. A consumer that is about to conclude something from the *absence* of a
   * caller has to ask this first: a call site nobody could attribute, or a callee name
   * several files define, means there may be a caller the edges do not show. Counted
   * per name rather than in total, because a drop about some other function says
   * nothing about this one.
   */
  droppedCallersOf: (name: string) => { ambiguous: number; unattributed: number }
  /** Call sites read from the program model — the funnel's denominator. */
  referencesSeen: number
  /**
   * Call sites no indexed callable covers.
   *
   * A call in a global initialiser, or in a file recon could not parse. It is a
   * missing *input*, not an absent caller, so it must never be read as "nothing
   * calls this".
   */
  unattributed: number
  /** Callee names with no definition. A libc call is the ordinary case. */
  unresolved: string[]
  /** Callee names several files define, with no same-file match to choose from. */
  ambiguous: string[]
}

/**
 * What the graph is built from.
 *
 * Rows rather than a database handle, so building a graph and *reading* the program
 * model are separate steps: `readProgramModel` is the I/O, `buildCallGraph` is the
 * pure part, and a caller that already queried the model — the sweep has the
 * callable regions in hand — can reuse them instead of querying twice.
 */
export interface CallGraphSource {
  definitions: readonly CallGraphDefinition[]
  references: readonly CallReference[]
}

const queryDefinitions = (db: Database, targetId: string): CallGraphDefinition[] =>
  db
    .query<
      { file_path: string; name: string; start_line: number; end_line: number },
      [string]
    >(
      `SELECT file_path, name, start_line, end_line
         FROM symbols
        WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
        ORDER BY file_path, start_line`,
    )
    .all(targetId)
    .map((row) => ({
      filePath: row.file_path,
      name: row.name,
      startLine: row.start_line,
      endLine: row.end_line,
    }))

const queryReferences = (db: Database, targetId: string): CallReference[] =>
  db
    .query<{ file_path: string; name: string; line: number }, [string]>(
      `SELECT file_path, name, line
         FROM symbol_refs
        WHERE target_id = ? AND kind = 'call'
        ORDER BY file_path, line`,
    )
    .all(targetId)
    .map((row) => ({ filePath: row.file_path, name: row.name, line: row.line }))

/**
 * Read the two halves of the program model the graph needs.
 *
 * Only callable definitions are indexed, because a call names a callable: indexing
 * structs and typedefs would let `struct config` shadow a function of the same name
 * and turn a resolvable call into a false ambiguity.
 */
export const readProgramModel = (db: Database, targetId: string): CallGraphSource => ({
  definitions: queryDefinitions(db, targetId),
  references: queryReferences(db, targetId),
})

/**
 * The innermost callable region containing a line, or null.
 *
 * Innermost rather than first: a call inside a nested function literal is inside
 * both its own region and its parent's, and the caller is the closest enclosing
 * one. Ties on span are broken by the later start line, so two regions that share a
 * span resolve to the one that opens last — arbitrary but stable, which is what
 * determinism needs.
 */
export const enclosingCallable = (
  definitions: readonly CallGraphDefinition[],
  line: number,
): CallGraphDefinition | null => {
  let best: CallGraphDefinition | null = null

  for (const definition of definitions) {
    if (line < definition.startLine || line > definition.endLine) continue
    if (best === null) {
      best = definition
      continue
    }
    if (definition.startLine > best.startLine) best = definition
  }

  return best
}

/**
 * Build the call graph for one target.
 *
 * Two passes, because resolution cannot place a name until every definition is
 * indexed — the same shape `handlers.ts` uses for registrations, for the same
 * reason.
 */
export const buildCallGraph = (source: CallGraphSource): CallGraph => {
  const { definitions, references } = source

  const index = buildDefinitionIndex(definitions)
  const byFile = new Map<string, CallGraphDefinition[]>()
  for (const definition of definitions) {
    const list = byFile.get(definition.filePath) ?? []
    list.push(definition)
    byFile.set(definition.filePath, list)
  }

  const edges: CallEdge[] = []
  const incoming = new Map<string, CallEdge[]>()
  const outgoing = new Map<string, CallEdge[]>()
  const unresolved: string[] = []
  const ambiguous: string[] = []
  const droppedAmbiguous = new Map<string, number>()
  const droppedUnattributed = new Map<string, number>()
  const bump = (counts: Map<string, number>, name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let unattributed = 0

  for (const reference of references) {
    const caller = enclosingCallable(byFile.get(reference.filePath) ?? [], reference.line)
    if (caller === null) {
      unattributed += 1
      bump(droppedUnattributed, reference.name)
      continue
    }

    const resolution = resolveName(index, reference.name, reference.filePath)
    if (resolution.kind === 'unresolved') {
      unresolved.push(`${reference.name} (called from ${reference.filePath}:${reference.line})`)
      continue
    }
    if (resolution.kind === 'ambiguous') {
      ambiguous.push(
        `${reference.name} (called from ${reference.filePath}:${reference.line}, defined in ` +
          `${resolution.fileCount} files)`,
      )
      bump(droppedAmbiguous, reference.name)
      continue
    }

    const edge: CallEdge = {
      fromFile: caller.filePath,
      fromFunction: caller.name,
      toFile: resolution.filePath,
      toFunction: reference.name,
      line: reference.line,
    }
    edges.push(edge)

    const key = definitionKey(edge.toFile, edge.toFunction)
    const callers = incoming.get(key) ?? []
    callers.push(edge)
    incoming.set(key, callers)

    const from = definitionKey(edge.fromFile, edge.fromFunction)
    const calls = outgoing.get(from) ?? []
    calls.push(edge)
    outgoing.set(from, calls)
  }

  return {
    edges,
    callersOf: (filePath, name) => incoming.get(definitionKey(filePath, name)) ?? [],
    edgesFrom: (filePath, name) => outgoing.get(definitionKey(filePath, name)) ?? [],
    droppedCallersOf: (name) => ({
      ambiguous: droppedAmbiguous.get(name) ?? 0,
      unattributed: droppedUnattributed.get(name) ?? 0,
    }),
    referencesSeen: references.length,
    unattributed,
    unresolved,
    ambiguous,
  }
}
