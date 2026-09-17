/**
 * Interprocedural structure shared by every consumer (spec §4.4.3, §4.4.4).
 *
 * The call graph started inside `toctou/` because that was the first thing that
 * needed one. It is not a TOCTOU artifact: "which function calls which" is a fact
 * about the program model, and two modules reading it from different code paths is
 * how they end up disagreeing about what a call site resolves to — the same failure
 * `symbol-kinds.ts` documents for `kind = 'function'`.
 *
 * So the builder lives here, on its own, and consumers import it:
 * `toctou` for check-to-use across a call boundary, `reach` for whether an
 * attacker can get to a site at all.
 */

export { buildCallGraph, enclosingCallable, readProgramModel } from './callgraph'
/**
 * The identity of one definition, as the graph's maps key it.
 *
 * Re-exported because a consumer that builds its own adjacency — `reach/graph.ts`
 * does, to walk the closure — must key nodes the same way the graph does. Two key
 * conventions that differ by a separator are a lookup that silently misses.
 */
export { definitionKey } from '../toctou/resolver'
export type {
  CallEdge,
  CallGraph,
  CallGraphDefinition,
  CallGraphSource,
  CallReference,
} from './callgraph'
