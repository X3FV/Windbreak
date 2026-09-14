/**
 * The fixture list (spec §11.2, D22).
 *
 * A fixture list is ground truth, so a malformed one is worse than a missing
 * one: it silently changes the denominator of the only recall number the project
 * has. Every check below exists because the failure it prevents is invisible in
 * the output.
 *
 * - **Duplicate bug ids inside a fixture** would let one bug satisfy recall
 *   twice, or let two bugs share an id so that losing one hides the other.
 * - **Two fixtures pinned to the same commit of the same project** would
 *   score one run against a doubled bug count.
 * - **`endLine` without `startLine`**, and a **fix commit equal to the
 *   vulnerable commit**, are self-contradictory ground truth.
 * - **An absolute site path** means the author has understood the snapshot root
 *   differently from everything else in the pipeline, and the site would never
 *   match a candidate.
 *
 * Metadata an author may simply not know — the CVE, the fix commit, the line
 * range, an annotation — is `nullish` in the file format and normalized to an
 * explicit `null` internally. The distinction the rest of the pipeline cares
 * about is "recorded" versus "not recorded", and making an author write
 * `"cwe": null` by hand adds friction without adding information. The strict
 * object shape still refuses a *misspelled* key, which is the error that would
 * otherwise pass unnoticed.
 *
 * A fixture with *no* seeded bugs is accepted, deliberately. That is a negative
 * control — code with no known bug, where the only thing to measure is how much
 * noise the pipeline produces — and its recall is reported as unknown rather
 * than as zero.
 */

import { z } from 'zod'

import type { Fixture, FixtureBug, FixtureSet, FixtureSite } from './types'

/** The list format this build understands. An unknown version is refused. */
export const FIXTURE_SET_VERSION = 1

const SHA = /^[0-9a-f]{7,40}$/i
const CWE = /^CWE-\d{1,5}$/
const CVE = /^CVE-\d{4}-\d{4,7}$/

/**
 * A path as it appears in a candidate, normalized the same way candidates are
 * (see `./match`), so a hand-written list and an engine's output can meet.
 */
const normalizeSitePath = (value: string): string => {
  let path = value.replace(/\\/g, '/').trim()
  while (path.startsWith('./')) path = path.slice(2)
  while (path.startsWith('/')) path = path.slice(1)
  return path
}

const siteSchema = z
  .object({
    filePath: z.string().min(1),
    startLine: z.number().int().positive().nullish(),
    endLine: z.number().int().positive().nullish(),
    functionName: z.string().min(1).nullish(),
  })
  .strict()

const bugSchema = z
  .object({
    id: z.string().min(1).max(120),
    cwe: z.string().regex(CWE, 'must look like CWE-120').nullish(),
    cve: z.string().regex(CVE, 'must look like CVE-2024-1086').nullish(),
    files: z.array(siteSchema).min(1, 'a bug must have at least one site'),
    fixCommit: z.string().regex(SHA, 'must be a hex commit sha').nullish(),
    note: z.string().max(500).nullish(),
  })
  .strict()

const fixtureSchema = z
  .object({
    id: z.string().min(1).max(120),
    project: z.string().min(1).max(120),
    commitSha: z.string().regex(SHA, 'must be a hex commit sha'),
    bugs: z.array(bugSchema),
    note: z.string().max(500).nullish(),
  })
  .strict()

const setSchema = z
  .object({
    version: z.number().int().positive(),
    description: z.string().max(500).nullish(),
    fixtures: z.array(fixtureSchema).min(1, 'a fixture set with no fixtures scores nothing'),
  })
  .strict()

export class InvalidFixtureSetError extends Error {
  constructor(message: string) {
    super(
      `Refusing this fixture set: ${message}. Ground truth that does not validate is ` +
        'refused rather than repaired, because every number computed from it would be ' +
        'wrong in a way the report could not show (spec §11.2, §18).',
    )
    this.name = 'InvalidFixtureSetError'
  }
}

const siteFrom = (site: z.infer<typeof siteSchema>): FixtureSite => ({
  filePath: normalizeSitePath(site.filePath),
  startLine: site.startLine ?? null,
  endLine: site.endLine ?? null,
  functionName: site.functionName ?? null,
})

/**
 * Cross-field checks zod's shape validators cannot express.
 *
 * These are the ones that need to see the whole fixture, so they run after the
 * per-object parse rather than inside it.
 */
const checkSet = (set: FixtureSet): void => {
  if (set.version !== FIXTURE_SET_VERSION) {
    throw new InvalidFixtureSetError(
      `version ${set.version} is not the version this build reads (${FIXTURE_SET_VERSION}). ` +
        'A newer list has fields this build would ignore, which would change the ' +
        'denominator silently',
    )
  }

  const seenFixtureIds = new Set<string>()
  const seenCommits = new Map<string, string>()

  for (const fixture of set.fixtures) {
    if (seenFixtureIds.has(fixture.id)) {
      throw new InvalidFixtureSetError(`fixture id "${fixture.id}" appears twice`)
    }
    seenFixtureIds.add(fixture.id)

    // The key is project + commit: the same upstream commit can legitimately
    // appear under two projects (a fork or a vendored copy), but two fixtures
    // claiming the same project at the same revision are one fixture written
    // twice, and a single run would be scored against both.
    const commitKey = `${fixture.project}@${fixture.commitSha}`
    const existing = seenCommits.get(commitKey)
    if (existing !== undefined) {
      throw new InvalidFixtureSetError(
        `fixtures "${existing}" and "${fixture.id}" are both ${commitKey}; one run would ` +
          'be scored against both, doubling the bug count',
      )
    }
    seenCommits.set(commitKey, fixture.id)

    const seenBugIds = new Set<string>()
    for (const bug of fixture.bugs) {
      if (seenBugIds.has(bug.id)) {
        throw new InvalidFixtureSetError(
          `bug id "${bug.id}" appears twice in fixture "${fixture.id}"`,
        )
      }
      seenBugIds.add(bug.id)

      if (bug.fixCommit !== null && bug.fixCommit.toLowerCase() === fixture.commitSha.toLowerCase()) {
        throw new InvalidFixtureSetError(
          `bug "${bug.id}" fixes at ${bug.fixCommit}, which is the vulnerable commit ` +
            `"${fixture.id}" is pinned to. One of the two is wrong`,
        )
      }

      if (bug.files.some((site) => site.filePath.length === 0)) {
        throw new InvalidFixtureSetError(
          `bug "${bug.id}" has a site whose file path is empty after normalization`,
        )
      }

      const localNames = new Set<string>()
      for (const site of bug.files) {
        const key = `${site.filePath}:${site.startLine ?? '*'}-${site.endLine ?? '*'}`
        if (localNames.has(key)) {
          throw new InvalidFixtureSetError(
            `bug "${bug.id}" lists the site ${key} twice`,
          )
        }
        localNames.add(key)
      }
    }
  }
}

/**
 * Parse a fixture list, throwing on anything invalid.
 *
 * The thrown message names the specific defect, because the researcher authoring
 * the list is the audience and "invalid" is not actionable.
 */
export const parseFixtureSet = (input: unknown): FixtureSet => {
  const parsed = setSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidFixtureSetError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    )
  }

  const set = parsed.data

  const normalized: FixtureSet = {
    version: set.version,
    description: set.description ?? null,
    fixtures: set.fixtures.map(
      (fixture): Fixture => ({
        id: fixture.id,
        project: fixture.project,
        commitSha: fixture.commitSha,
        note: fixture.note ?? null,
        bugs: fixture.bugs.map(
          (bug): FixtureBug => ({
            id: bug.id,
            cwe: bug.cwe ?? null,
            cve: bug.cve ?? null,
            files: bug.files.map(siteFrom),
            fixCommit: bug.fixCommit ?? null,
            note: bug.note ?? null,
          }),
        ),
      }),
    ),
  }

  // The range checks run over the normalized value rather than the parsed one,
  // so they see `null` for "not recorded" instead of two spellings of it.
  for (const fixture of normalized.fixtures) {
    for (const bug of fixture.bugs) {
      for (const site of bug.files) {
        if (site.startLine === null && site.endLine !== null) {
          throw new InvalidFixtureSetError(
            `bug "${bug.id}" site ${site.filePath} sets endLine without startLine`,
          )
        }
        if (site.startLine !== null && site.endLine !== null && site.endLine < site.startLine) {
          throw new InvalidFixtureSetError(
            `bug "${bug.id}" site ${site.filePath} ends (${site.endLine}) before it ` +
              `starts (${site.startLine})`,
          )
        }
      }
    }
  }

  checkSet(normalized)
  return normalized
}

/** Every bug in a fixture, flattened. Convenience for the matcher. */
export const bugsOf = (fixture: Fixture): FixtureBug[] => fixture.bugs
