/**
 * The sibling sweep (spec §4.4.1).
 *
 * A validated pattern is a statement about a *shape*: "this target used a pointer
 * with no null test", "this target called something with no bound check". The
 * sweep asks where else that shape is true.
 *
 * ## Regions come from the program model, not from a line window
 *
 * A detector for `null-check` needs to know which identifiers are pointers, and
 * that comes from a function's signature. A sliding window over a file would
 * sometimes contain a signature and sometimes not, so it would sometimes fire and
 * sometimes not on identical code — inconsistent rather than merely imprecise.
 * Instead the regions are the functions `recon` already indexed: start line to end
 * line, from tree-sitter, with the signature included. That means one candidate
 * per (pattern, function) at most, which is the right cardinality — a second hit
 * inside the same function would be the same defect reported twice.
 *
 * ## The operation prefilter is what keeps this from being a generic linter
 *
 * `startsWith('null-check')` with no operation would be "find every pointer used
 * without a null test in the codebase" — generic, and precisely the >90%
 * false-positive regime §4.3 warns about. The pattern's `operation` narrows the
 * sweep to functions that call the *same callee the fix was about*, which is what
 * makes the result patch-mined rather than a stock rule: the claim is "elsewhere
 * in this target, `strcpy` is called on a pointer with no null test".
 *
 * When a pattern has no operation there is nothing to narrow with. Those patterns
 * are still swept — dropping them would cost recall on the shapes that rarely
 * yield one — but the per-pattern site cap is what stops a single broad pattern
 * from flooding the candidate set.
 */

import { languageFilterSql, languagesForDetectors } from '../detectors/capability'
import { SourceCache } from '../engines/normalize'
import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'
import { callees, detectShape } from './shapes'

import type { Database } from 'bun:sqlite'
import type { DetectorId } from '../detectors/capability'
import type { MinedPattern, SiblingSite } from './types'

export const DEFAULT_MAX_SITES_PER_PATTERN = 25

/**
 * Which detectors this sweep runs, so its language filter is theirs.
 *
 * Named here rather than inlined at the two queries below because the filter and the
 * warning that explains the skipped callables have to agree: a filter built from one set
 * and a warning about another is how a stage reports coverage it does not have.
 */
const SHAPE_DETECTORS: readonly DetectorId[] = ['patch-shape']

interface FunctionRow {
  file_path: string
  name: string
  start_line: number
  end_line: number
}

export interface SiblingOptions {
  db: Database
  targetId: string
  targetRoot: string
  patterns: readonly MinedPattern[]
  sourceCache?: SourceCache
  /** Cap per pattern, so one broad shape cannot dominate the candidate set. */
  maxSitesPerPattern?: number
  log?: (line: string) => void
}

export interface PatternSweepOutcome {
  patternId: string
  shape: MinedPattern['shape']
  sites: number
  /** True when the cap was reached, so a truncated sweep is not read as complete. */
  capped: boolean
}

export interface SiblingResult {
  sites: SiblingSite[]
  outcomes: PatternSweepOutcome[]
  warnings: string[]
}

export const findSiblingSites = (options: SiblingOptions): SiblingResult => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const maxSites = options.maxSitesPerPattern ?? DEFAULT_MAX_SITES_PER_PATTERN
  const sourceCache = options.sourceCache ?? new SourceCache(options.targetRoot)

  // Callables the shape detectors have no tables for. Counted, not ignored:
  // a sibling sweep over a Python repository finds nothing because its tables
  // are C's, and "nothing found" and "nothing looked at" must not print the
  // same way.
  const languageFilter = languageFilterSql(SHAPE_DETECTORS)
  const skippedCallables =
    options.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM symbols
          WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
            AND NOT (${languageFilter})`,
      )
      .get(options.targetId)?.count ?? 0
  if (skippedCallables > 0) {
    // The languages are named from the same matrix that built the filter, so this
    // sentence cannot outlive a change to which languages the detectors actually
    // cover.
    warnings.push(
      `${skippedCallables} callable(s) were not swept: the shape detectors have ` +
        `tables for ${languagesForDetectors(SHAPE_DETECTORS).join(', ')} only, and ` +
        'the rest of the program model has no tables yet.',
    )
  }

  const functions = options.db
    .query<FunctionRow, [string]>(
      `SELECT file_path, name, start_line, end_line
         FROM symbols
        WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
          AND ${languageFilter}
        ORDER BY file_path, start_line`,
    )
    .all(options.targetId)

  if (functions.length === 0) {
    // Not an error, but it must not read as "no siblings exist": without a
    // program model there is nothing to sweep, which is a different statement.
    warnings.push(
      'No indexed functions for this target, so no sibling sites could be searched. ' +
        'Run recon first; patch-mined patterns were still recorded.',
    )
    return {
      sites: [],
      outcomes: options.patterns.map((pattern) => ({
        patternId: pattern.id,
        shape: pattern.shape,
        sites: 0,
        capped: false,
      })),
      warnings,
    }
  }

  const sites: SiblingSite[] = []
  const outcomes: PatternSweepOutcome[] = []

  for (const pattern of options.patterns) {
    let found = 0
    let capped = false

    for (const fn of functions) {
      if (found >= maxSites) {
        capped = true
        break
      }

      const lines = sourceCache.lines(fn.file_path)
      if (lines === null) continue

      // start_line/end_line are 1-based inclusive, from tree-sitter.
      const from = Math.max(0, fn.start_line - 1)
      const to = Math.min(lines.length, fn.end_line)
      if (to <= from) continue

      const region = lines.slice(from, to)

      // The prefilter. A function that never calls the mined operation cannot be a
      // sibling site for this pattern — see the module note.
      if (pattern.operation !== null && !callees(region).includes(pattern.operation)) {
        continue
      }

      const finding = detectShape(region, pattern.shape, {
        subject: null,
        operation: pattern.operation,
      })
      if (finding === null) continue

      found += 1
      sites.push({
        patternId: pattern.id,
        filePath: fn.file_path,
        startLine: fn.start_line,
        endLine: fn.end_line,
        functionName: fn.name,
        // The detector reports within the region; translate back to file lines.
        matchLine: fn.start_line + finding.line - 1,
        evidence: finding.evidence,
      })
    }

    outcomes.push({ patternId: pattern.id, shape: pattern.shape, sites: found, capped })
    log(
      `[patch-mine] ${pattern.shape}${pattern.operation ? ` (${pattern.operation})` : ''}: ` +
        `${found} sibling site(s)${capped ? ` (capped at ${maxSites})` : ''}`,
    )
    if (capped) {
      warnings.push(
        `Pattern ${pattern.id} (${pattern.shape}) reached the ${maxSites}-site cap; ` +
          'its sweep is partial.',
      )
    }
  }

  return { sites, outcomes, warnings }
}
