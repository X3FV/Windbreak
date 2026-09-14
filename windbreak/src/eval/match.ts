/**
 * Ground truth (spec §11.2).
 *
 * This is the module that decides what counts as *found*, so it is written to be
 * conservative in one direction and generous in the other, deliberately:
 *
 * - **Conservative about false positives.** A candidate is only ever reported as
 *   a false positive when something could be said about it and that something
 *   was "no". A hit with no file path is *unscored*, not wrong — counting it as
 *   noise would let a broken recon masquerade as a noisy detector.
 * - **Generous about recall.** D11 makes the MVP bar recall, so a candidate
 *   whose site cannot be pinned to lines still matches a bug in that file. The
 *   match is labelled `file` rather than `range` so the weaker claim is visible
 *   in the report instead of being indistinguishable from a precise one.
 *
 * Paths are the fiddly part. A fixture list is written relative to a snapshot
 * root, while the engines report paths from inside the sandbox, which may be
 * absolute and rooted anywhere — so paths are compared by trailing segments, and
 * narrowed to the most specific correspondence, because that relation is
 * ambiguous on its own (see `candidateSites`).
 */

import type { Fixture, FixtureBug, FixtureSite, GroundTruth, MatchBasis } from './types'

/** The part of a candidate that can be matched. */
export interface CandidateLocation {
  filePath: string | null
  startLine: number | null
  endLine: number | null
}

/**
 * Flatten a path to the form both sides are compared in.
 *
 * Backslashes are normalized rather than escaped, because a Windows checkout of
 * the same snapshot is the same snapshot.
 */
export const normalizeRepoPath = (value: string): string => {
  let path = value.replace(/\\/g, '/').trim()
  while (path.startsWith('./')) path = path.slice(2)
  path = path.replace(/\/{2,}/g, '/')
  return path
}

/** True when one path ends at the other on a segment boundary. */
export const pathsCorrespond = (a: string, b: string): boolean => {
  const left = normalizeRepoPath(a)
  const right = normalizeRepoPath(b)
  if (left === right) return true
  if (left.length === 0 || right.length === 0) return false
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

interface Range {
  start: number
  end: number
}

const rangeOf = (start: number | null, end: number | null): Range | null => {
  if (start === null) return null
  return { start, end: end === null ? start : end }
}

export const rangesOverlap = (a: Range, b: Range): boolean =>
  a.start <= b.end && b.start <= a.end

interface SiteMatch {
  bug: FixtureBug
  site: FixtureSite
}

const siteMatches = (candidate: CandidateLocation, entry: SiteMatch): MatchBasis | null => {
  const candidateRange = rangeOf(candidate.startLine, candidate.endLine)
  const siteRange = rangeOf(entry.site.startLine, entry.site.endLine)

  if (candidateRange === null || siteRange === null) return 'file'
  return rangesOverlap(candidateRange, siteRange) ? 'range' : null
}

/** Segments in a path, for ranking correspondences. */
const depth = (value: string): number =>
  normalizeRepoPath(value).split('/').filter((segment) => segment.length > 0).length

/**
 * The sites a candidate could be about, narrowed to the most specific match.
 *
 * The two sides arrive from different roots — a fixture list is relative to a
 * snapshot, an engine reports from inside the sandbox — so correspondence is
 * decided by trailing segments. That alone is ambiguous: `lib/a.c` and `a.c` both
 * end the path `/sbx/lib/a.c`, and crediting the candidate to both would report a
 * bug in the parent directory as found.
 *
 * So the sites sharing the **most** segments with the candidate win. A tie is
 * kept rather than broken, because two sites at equal depth are genuinely
 * ambiguous and picking one would be a coin flip recorded as a fact.
 */
const candidateSites = (candidate: CandidateLocation, fixture: Fixture): SiteMatch[] => {
  const path = normalizeRepoPath(candidate.filePath ?? '')
  const all: SiteMatch[] = fixture.bugs.flatMap((bug) =>
    bug.files.map((site) => ({ bug, site })),
  )

  const corresponding = all.filter((entry) => pathsCorrespond(path, entry.site.filePath))
  if (corresponding.length === 0) return []

  const deepest = Math.max(...corresponding.map((entry) => depth(entry.site.filePath)))
  return corresponding.filter((entry) => depth(entry.site.filePath) === deepest)
}

/**
 * What the fixture list says about one candidate.
 *
 * A candidate may match several bugs (a bug and its copy, or a range spanning
 * two seeded sites), so the result carries all of them; the funnel counts
 * distinct bug ids, not matches.
 */
export const matchCandidate = (
  candidate: CandidateLocation,
  fixture: Fixture,
): GroundTruth => {
  const path = normalizeRepoPath(candidate.filePath ?? '')
  if (path.length === 0) {
    return {
      kind: 'unscorable',
      reason:
        'the candidate records no file path, so it cannot be tied to a seeded site',
    }
  }

  const matched = candidateSites(candidate, fixture)
    .map((entry) => ({ entry, basis: siteMatches(candidate, entry) }))
    .filter((hit): hit is { entry: SiteMatch; basis: MatchBasis } => hit.basis !== null)

  if (matched.length === 0) return { kind: 'unmatched' }

  // Preserve fixture order so the report is stable, and dedupe by bug id: two
  // sites of the same bug are one finding.
  const byId = new Map<string, FixtureBug>()
  for (const hit of matched) byId.set(hit.entry.bug.id, hit.entry.bug)

  return {
    kind: 'matched',
    bugs: [...byId.values()],
    basis: matched.some((hit) => hit.basis === 'range') ? 'range' : 'file',
  }
}
