/**
 * The reachability pass (spec §4.4.4).
 *
 * Reads the program model once, builds the call graph, inventories the entry points,
 * walks the closure, and records one conclusion per candidate. No sandbox and no model:
 * like §4.1's recon it is a query over rows the pipeline already has, which is why it
 * costs a fraction of the sweeps it qualifies.
 *
 * ## Where it sits, and why
 *
 * At the end of `static-core`, after every discovery producer has persisted its
 * candidates. It has to run after them — the thing being annotated is a candidate row —
 * and it belongs in the static core rather than in triage because §4.4.4 is a static
 * question whose answer changes *which* candidates are worth a model call. A run whose
 * budget dies before it is still correct, just narrower, and the stage says so.
 *
 * ## What it refuses to do
 *
 * It never deletes a candidate, never changes a candidate's state, and never writes a
 * conclusion it cannot justify. `unreachable` is recorded only for a site the caller
 * graph covers completely; everything else is `unknown` **with the reason**, which is
 * the difference between a run that found no path and a run that could not look.
 */

import { buildCallGraph, readProgramModel } from '../interproc'

import { findEntryPoints } from './entries'
import { analyzeReachability } from './graph'
import { persistCandidateReachability, persistEntryPoints } from './persist'

import type { Database } from 'bun:sqlite'
import type { CallGraphSource } from '../interproc'
import type { EntryPoint } from './entries'
import type { ReachCounts, ReachCoverage } from './graph'

export interface ReachabilityRunOptions {
  db: Database
  targetId: string
  runId: string
  /**
   * The program model, when the caller already read it.
   *
   * The toctou sweep has the callable regions in hand and the graph is built from the
   * same two queries; passing them in is what keeps this from being a second full read
   * of `symbols` and `symbol_refs` on a large target.
   */
  source?: CallGraphSource
  now?: () => number
}

export interface ReachabilityOutcome {
  entries: readonly EntryPoint[]
  counts: ReachCounts
  coverage: ReachCoverage
  /** Candidates classified — those with both a file and a line. */
  annotated: number
  /** Candidates with no location, so there was nothing to classify. */
  unlocated: number
  warnings: string[]
}

/** The candidates of a run that have a location to classify. */
interface LocatedCandidate {
  id: string
  filePath: string
  startLine: number
}

export const runReachability = (options: ReachabilityRunOptions): ReachabilityOutcome => {
  const source = options.source ?? readProgramModel(options.db, options.targetId)
  const graph = buildCallGraph(source)
  const entries = findEntryPoints(graph, source.definitions)
  const analysis = analyzeReachability({
    graph,
    definitions: source.definitions,
    entries,
  })

  persistEntryPoints({
    db: options.db,
    targetId: options.targetId,
    entries,
    ...(options.now ? { now: options.now } : {}),
  })

  const rows = options.db
    .query<
      { id: string; file_path: string | null; start_line: number | null },
      [string]
    >(
      `SELECT id, file_path, start_line
         FROM candidates
        WHERE run_id = ?
        ORDER BY file_path, start_line`,
    )
    .all(options.runId)

  const located: LocatedCandidate[] = []
  let unlocated = 0
  for (const row of rows) {
    if (row.file_path === null || row.start_line === null) {
      unlocated += 1
      continue
    }
    located.push({ id: row.id, filePath: row.file_path, startLine: row.start_line })
  }

  for (const candidate of located) {
    const site = analysis.site(candidate.filePath, candidate.startLine)
    persistCandidateReachability({
      db: options.db,
      candidateId: candidate.id,
      reachability: {
        klass: site.klass,
        distance: site.distance,
        entry: site.entry,
        incomplete: site.incomplete,
        path:
          site.definition === null
            ? []
            : analysis.pathFor(site.definition.filePath, site.definition.name),
        definition: site.definition,
        coverage: {
          entries: analysis.coverage.entries,
          externalCallees: analysis.coverage.externalCallees,
          noEntries: analysis.coverage.noEntries,
        },
      },
    })
  }

  const warnings: string[] = []
  if (analysis.coverage.noEntries) {
    warnings.push(
      'no entry point was identified in this target, so no candidate could be called ' +
        'reachable *or* unreachable — every reachability conclusion is unknown',
    )
  } else if (located.length === 0 && rows.length > 0) {
    warnings.push(
      `${rows.length} candidate(s) have no file and line, so nothing was classified`,
    )
  }

  return {
    entries,
    counts: analysis.counts,
    coverage: analysis.coverage,
    annotated: located.length,
    unlocated,
    warnings,
  }
}
