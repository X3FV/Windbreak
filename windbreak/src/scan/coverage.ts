/**
 * How much of the program model the static core actually swept (spec §20.24.5).
 *
 * §20.24.5 records the pin: the shape detectors and the check-to-use FSMs are tables of
 * C idioms, so the sweeps are restricted to the languages those tables are, and the
 * callables they therefore skip are "counted and reported". That count lived in two
 * places — `noDetectorTables` buried in the toctou coverage, and a line in the warning
 * list — and neither is where a reader looks first. A warning is easy to scroll past, and
 * the candidate block that follows an unswept repository reads `0 candidates`, which is
 * the exact sentence §18 exists to prevent: a near-empty result that reads as a clean one.
 *
 * So this module moves the number into the summary proper. It is a query rather than a
 * plumbed-through value on purpose — both sweeps already count the same rows for their own
 * warnings, and a third copy of "which callables are in a language with no tables" is a
 * third place for the language lists to drift out of agreement with themselves.
 *
 * ## Why the line is computed from `symbols`, not from the sweeps
 *
 * The two C-shaped stages report their own skipped counts, and those diverge for
 * legitimate reasons — the sibling sweep only walks when a patch-mined pattern exists,
 * and the signal producer is off under `--no-signal`. The summary's job is the different
 * question "how much of the model did the C-shaped net reach at all", so it asks the
 * program model directly and the two warnings stay free to describe their own stage's
 * narrower situation. For the same reason it classifies against the *whole* matrix rather
 * than against what a particular run enabled: a detector switched off for one run is not a
 * language the tool cannot read.
 *
 * ## Partial coverage is the case the matrix introduced
 *
 * A language is no longer swept or unswept — it is swept by *some* detectors. With the
 * per-detector matrix in `detectors/capability.ts`, adding Python tables to the shape
 * family and not to the FSMs makes Python **partly swept**, and rounding that to either
 * side is a lie in one direction: `swept` would say its callables were checked when only
 * some detectors read them, `unswept` would hide the detectors that did. So the entry
 * names both sets and the line prints the partial bucket with the detectors that are
 * missing from it.
 */

import {
  detectorsForLanguage,
  detectorsMissingFor,
} from '../detectors/capability'
import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'

import type { Database } from 'bun:sqlite'
import type { DetectorCapability, DetectorId } from '../detectors/capability'

export interface LanguageCoverageEntry {
  /** The language id `recon` recorded, e.g. `c`, `cpp`, `python`. */
  language: string
  /** Callables in that language, as the sweep would count regions to walk. */
  callables: number
  /** Detectors with tables for this language, in matrix order. */
  detectors: DetectorId[]
  /** Detectors without them, in the same order — what the partial bucket names. */
  missingDetectors: DetectorId[]
  /** True when `missingDetectors` is empty: every detector reads this language. */
  swept: boolean
}

export interface LanguageCoverage {
  /** Callables in a language every detector covers. */
  sweptCallables: number
  /** Callables in a language some detectors cover and others do not. */
  partiallySweptCallables: number
  /** Callables no detector table reaches — the pin's cost, named. */
  unsweptCallables: number
  /** Every language present in the program model, most-populous first. */
  languages: LanguageCoverageEntry[]
}

/**
 * Count the program model's callables, grouped by language.
 *
 * `symbols.language` is `TEXT NOT NULL`, so a null is not expected; it is still folded
 * into `unknown` rather than dropped, because a count that silently disappears would make
 * the buckets disagree with the model.
 *
 * `capabilities` is a seam for the tests, which need a matrix whose detectors *diverge* to
 * exercise the partial bucket — the shipped matrix has no such language yet, and a branch
 * that only becomes reachable when someone adds a language is a branch nobody has run.
 */
export const readLanguageCoverage = (
  db: Database,
  targetId: string,
  capabilities?: readonly DetectorCapability[],
): LanguageCoverage => {
  const rows = db
    .query<{ language: string | null; count: number }, [string]>(
      `SELECT language, COUNT(*) AS count
         FROM symbols
        WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
        GROUP BY language
        ORDER BY count DESC, language`,
    )
    .all(targetId)

  const languages: LanguageCoverageEntry[] = []
  let sweptCallables = 0
  let partiallySweptCallables = 0
  let unsweptCallables = 0

  for (const row of rows) {
    const language = row.language ?? 'unknown'
    const detectors = detectorsForLanguage(language, capabilities)
    const missingDetectors = detectorsMissingFor(language, capabilities)
    const swept = missingDetectors.length === 0

    if (swept) sweptCallables += row.count
    else if (detectors.length > 0) partiallySweptCallables += row.count
    else unsweptCallables += row.count

    languages.push({
      language,
      callables: row.count,
      detectors,
      missingDetectors,
      swept,
    })
  }

  return { sweptCallables, partiallySweptCallables, unsweptCallables, languages }
}

/**
 * `python 56, rust 14` — count included, because 56 and 1 mean different things.
 *
 * `note` appends a per-language clause, which is how the partial bucket says *which*
 * detectors did not read it rather than only that some did not.
 */
const describe = (
  entries: readonly LanguageCoverageEntry[],
  note?: (entry: LanguageCoverageEntry) => string,
): string =>
  entries
    .map(
      (entry) =>
        `${entry.language} ${entry.callables}` +
        (note ? ` (${note(entry)})` : ''),
    )
    .join(', ')

/**
 * The one summary line (spec §20.24.5).
 *
 * The swept and not-swept sides are always printed, including a zero, so `0 not swept` is
 * a statement the reader can verify against the matrix rather than the absence of a line
 * they have to interpret. The no-callables case is worded as a fact about the model rather
 * than as `0 swept`, since "recon indexed nothing" and "the detectors are perfect" must not
 * print the same way.
 *
 * The **partial** side is printed only when it is non-empty, unlike the other two. Zero
 * partial is not an ambiguous fact the way zero unswept is: it means every detector's
 * language lists agree, which the shipped matrix makes true for every language it covers.
 * Printing it unconditionally would lengthen every ordinary line to report a case that
 * cannot arise until one detector's list diverges from the rest.
 *
 * Its segment is colon-separated rather than parenthesised, because each entry carries a
 * parenthesised note of its own and nesting the two would read as one clause.
 */
/**
 * What §4.4.3's interprocedural pass had to work with.
 *
 * A view of the toctou stage's coverage rather than a type of its own, so the summary
 * and the stage report the same numbers from the same fields.
 */
export interface InterproceduralCoverage {
  /** Call edges the pass resolved. */
  callEdges: number
  /** Call sites read from the program model — the graph's denominator. */
  callSitesSeen: number
  /** Call sites no indexed callable covers, so they belong to no known caller. */
  callSitesUnattributed: number
  /** Call sites dropped because several files define the callee name. */
  callSitesAmbiguous: number
  /** Atomicity sites whose every recorded caller holds the rule's lock. */
  callerGuardedSites: number
}

/**
 * The interprocedural summary line.
 *
 * It exists for the same reason `formatLanguageCoverage` does, applied to the call
 * graph: the pass's headline result is a count of *nothing* when it finds nothing, and
 * "no cross-function check-to-use pair" and "no call graph to look for one in" print
 * identically. Printing the denominator beside the count is what separates them.
 *
 * The two drop reasons are named separately because they have different causes — an
 * unattributed site is a parsing gap (a call outside any indexed callable), an
 * ambiguous one is a name-resolution gap (two files, one name, no same-file match) —
 * and a reader deciding whether to trust an empty result needs to know which they have.
 *
 * An empty program model is worded as a fact about the model rather than as `0 edges`,
 * because "recon indexed no call sites" and "the call graph is complete and empty" are
 * different statements about the target.
 */
export const formatInterproceduralCoverage = (
  coverage: InterproceduralCoverage,
): string => {
  if (coverage.callSitesSeen === 0) {
    return 'interprocedural: no call sites in the program model, so no call graph could be built'
  }

  return (
    `interprocedural: ${coverage.callEdges} call edge(s) over ` +
    `${coverage.callSitesSeen} call site(s) ` +
    `(${coverage.callSitesUnattributed} unattributed, ` +
    `${coverage.callSitesAmbiguous} ambiguous); ` +
    `${coverage.callerGuardedSites} caller-guarded site(s)`
  )
}

export const formatLanguageCoverage = (coverage: LanguageCoverage): string => {
  const total =
    coverage.sweptCallables + coverage.partiallySweptCallables + coverage.unsweptCallables
  if (total === 0) return 'language coverage: no indexed callables to sweep'

  const swept = describe(coverage.languages.filter((entry) => entry.swept))
  const partial = describe(
    coverage.languages.filter((entry) => !entry.swept && entry.detectors.length > 0),
    (entry) => `missing ${entry.missingDetectors.join(', ')}`,
  )
  const unswept = describe(
    coverage.languages.filter((entry) => entry.detectors.length === 0),
  )

  return (
    `language coverage: ${coverage.sweptCallables} callable(s) swept` +
    (swept === '' ? '' : ` (${swept})`) +
    (coverage.partiallySweptCallables === 0
      ? ''
      : `; ${coverage.partiallySweptCallables} partly swept: ${partial}`) +
    `; ${coverage.unsweptCallables} not swept` +
    (unswept === '' ? '' : ` (${unswept})`)
  )
}
