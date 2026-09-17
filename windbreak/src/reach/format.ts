/**
 * The reachability summary line (spec §20.39), and the one-line rendering of a single
 * conclusion for a finding's evidence bundle.
 *
 * Two renderers, one vocabulary. The language-coverage line (§20.24.5) and the
 * interprocedural line (§20.13) both exist because a headline count of *nothing* must not
 * print the same way as a sweep that could not run; this is the same rule applied to
 * reachability, where the stakes are higher — `0 unreachable` reads as "every candidate is
 * reachable", which is the most flattering possible misreading of a graph that has no
 * edges.
 *
 * The single-conclusion renderer lives here rather than in the report because the report
 * is not the only surface that states one: `queue` shows it, the writeup shows it, and the
 * two must not drift into different sentences about the same row.
 */

import type { EntryKind } from './entries'
import type { ReachCounts } from './graph'
import type { CandidateReachability } from './persist'

/**
 * The coverage a summary has to hand, which is not always the whole `ReachCoverage`.
 *
 * The scan's summary reads its numbers back out of the persisted run metrics, where the
 * per-kind breakdown is already printed on the stage line and is not carried again. A
 * structural subset rather than a second renderer: one function owns the wording, and a
 * surface with fewer numbers prints fewer clauses rather than a different sentence.
 */
export interface ReachabilityCoverageLike {
  entries: number
  noEntries: boolean
  taintRoots: number
  externalCallees: number
  /** The subset of `externalCallees` written `Q::f`, which a name-only index cannot resolve. */
  qualifiedCallees?: number
  entryKinds?: Record<EntryKind, number>
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The scan summary's reachability line.
 *
 * The four classes are all printed, including zeros, in the order of the classification's
 * own priority. A zero is a fact here — `0 unreachable` is the only one of the four that
 * has to be *earned*, and seeing it beside `N unknown` is how a reader tells a clean
 * closure from one that never completed.
 */
export const formatReachabilityCoverage = (input: {
  counts: ReachCounts
  coverage: ReachabilityCoverageLike
}): string => {
  const { counts, coverage } = input

  if (counts.definitions === 0) {
    return 'reachability: no indexed callables, so nothing could be reached or ruled out'
  }

  if (coverage.noEntries) {
    return (
      'reachability: no entry point was identified, so no callable could be called ' +
      'reachable or unreachable'
    )
  }

  const kinds = coverage.entryKinds
  const breakdown = kinds
    ? ` (${kinds['fuzz-entry']} fuzz, ${kinds.main} main, ${kinds['input-source']} input source, ` +
      `${kinds.unrooted} unrooted)`
    : ''
  // The qualified subset is named rather than folded in: those calls are not merely
  // unresolved, they are unattributable, and each one leaves a caller set this analysis
  // cannot complete (§20.39.8). `0 unreachable` is worth less when this count is not zero.
  const qualified =
    (coverage.qualifiedCallees ?? 0) > 0
      ? ` (${coverage.qualifiedCallees} written with a class or namespace qualifier)`
      : ''
  return (
    `reachability: ${counts.attackerInput}/${counts.definitions} callable(s) reachable from ` +
    `attacker input, ${counts.exposedApi} exposed-api only, ${counts.unreachable} no path, ` +
    `${counts.unknown} unknown — from ${plural(coverage.entries, 'entry point')}${breakdown}; ` +
    `${coverage.taintRoots} incomplete caller set(s), ` +
    `${coverage.externalCallees} name(s) with no definition${qualified}`
  )
}

/**
 * One candidate's conclusion, as a line for the evidence bundle.
 *
 * Every sentence states what was searched as well as what was found, because "no path"
 * from 3 entry points and "no path" from 300 are different findings and the reader cannot
 * tell them apart otherwise.
 */
export const describeReachability = (reachability: CandidateReachability): string => {
  const { coverage } = reachability
  const entries = `${plural(coverage.entries, 'entry point')}`

  const caveat = (parts: readonly string[]): string => (parts.length > 0 ? ` ${parts.join(' ')}` : '')

  switch (reachability.klass) {
    case 'attacker-input': {
      const via = reachability.entry
        ? `${reachability.entry.name} (${reachability.entry.filePath}) — ${reachability.entry.reason}`
        : 'an entry point'
      const chain =
        reachability.path.length > 0
          ? ` Path: ${reachability.path.map(step).join(' -> ')}`
          : ''
      return (
        `Reachability: an attacker can reach this — a call path exists from ${via}, ` +
        `${plural(reachability.distance ?? 0, 'call')} deep.${chain}`
      )
    }
    case 'exposed-api':
      return (
        'Reachability: reachable from outside the indexed program — nothing here calls the ' +
        `function it sits in, so the caller is whatever links it (an exported API, a ` +
        `callback, or dead code; this analysis cannot tell which), out of ${entries}.`
      )
    case 'unreachable':
      return (
        `Reachability: no path from any of the ${entries} this target was searched from, and ` +
        'every caller set on the way in is complete — a defect here is not reachable in this ' +
        'build.' +
        (coverage.externalCallees > 0
          ? ` Note: ${plural(coverage.externalCallees, 'callee name')} have no indexed ` +
            'definition, so a call through a function pointer is not visible to this analysis.'
          : '')
      )
    case 'unknown':
      return (
        `Reachability: unknown — the search over the ${entries} this target was searched ` +
        `from did not settle it.${caveat(reachability.incomplete)}`
      )
  }
}

const step = (hop: { filePath: string; name: string; line: number | null }): string =>
  hop.line === null ? `${hop.name} (${hop.filePath})` : `${hop.name} (${hop.filePath}:${hop.line})`
