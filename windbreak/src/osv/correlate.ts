import fs from 'fs'
import path from 'path'

import { OsvClient, OsvHttpError } from './client'
import { dedupeDependencies, parseManifest } from './dependencies'
import { persistCorrelation } from './store'

import type { Database } from 'bun:sqlite'
import type { ManifestRef } from '../recon/deps'
import type {
  Dependency,
  OsvCommitMatch,
  OsvCorrelationResult,
  OsvPackageMatch,
  OsvPackageQuery,
  UnsupportedManifest,
} from './types'

/** A manifest larger than this is not a lockfile; refuse rather than buffer it. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/**
 * What the OSV correlation is asked to look up — all of it JSON (§20.17.3).
 *
 * `manifests` is the field that makes this stage worth measuring at all: OSV
 * queries take an ecosystem, a package name and a version, all of which travel
 * fine. What does not travel is the *reading* of the manifest files, which is
 * why `readFile` is a service and `targetRoot` is not enough on its own.
 */
export interface CorrelateRequest {
  /** Target checkout root; manifests are read from here. */
  targetRoot: string
  manifests: readonly ManifestRef[]
  /** Persisted against this target when a database is supplied. */
  targetId?: string | null
  commitSha?: string | null
  /** Resolve hit ids to full records. Default true; off keeps it one request. */
  enrich?: boolean
  /** Cap detail fetches so one very vulnerable target cannot blow the budget. */
  maxDetailFetches?: number
}

/** What OSV correlation needs from the host — none of it serializable. */
export interface CorrelateServices {
  client?: OsvClient
  db?: Database
  /** Injected for tests. Returns null when the file cannot be read. */
  readFile?: (absolutePath: string, maxBytes: number) => string | null
  log?: (line: string) => void
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type CorrelateOptions = CorrelateRequest & CorrelateServices

export const DEFAULT_MAX_DETAIL_FETCHES = 200

/**
 * Did OSV fail to answer, as opposed to answering with an error?
 *
 * A 4xx/5xx is the service responding, so a batch that failed that way is a
 * `partial` result. Anything else — a refused connection, a DNS failure, an
 * unparseable body — means the service could not be reached, which must be
 * recorded as `unavailable` and never as clean (spec §18).
 */
const isTransportFailure = (error: unknown): boolean =>
  !(error instanceof OsvHttpError)

const defaultReadFile = (absolutePath: string, maxBytes: number): string | null => {
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(absolutePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse every located manifest into dependencies.
 *
 * A manifest that cannot be parsed is reported in `unsupportedManifests` rather
 * than dropped: "we could not look" and "we looked and found nothing" are
 * different answers, and the spec's failure table (§18) requires the
 * distinction survive to the report.
 */
export const collectDependencies = (
  options: Pick<CorrelateOptions, 'targetRoot' | 'manifests' | 'readFile'>,
): {
  dependencies: Dependency[]
  unsupportedManifests: UnsupportedManifest[]
  warnings: string[]
} => {
  const readFile = options.readFile ?? defaultReadFile
  const warnings: string[] = []
  const unsupportedManifests: UnsupportedManifest[] = []
  const parsed: Dependency[] = []

  for (const manifest of options.manifests) {
    const absolutePath = path.join(options.targetRoot, manifest.path)
    const content = readFile(absolutePath, MAX_MANIFEST_BYTES)

    if (content === null) {
      unsupportedManifests.push({
        path: manifest.path,
        type: manifest.type,
        reason: 'manifest could not be read (missing, unreadable, or oversized)',
      })
      continue
    }

    const result = parseManifest({
      path: manifest.path,
      type: manifest.type,
      content,
    })

    if (result.reason) {
      unsupportedManifests.push({
        path: manifest.path,
        type: manifest.type,
        reason: result.reason,
      })
    }

    parsed.push(...result.dependencies)
  }

  return {
    dependencies: dedupeDependencies(parsed),
    unsupportedManifests,
    warnings,
  }
}

/**
 * Correlate a target's dependencies and commit against OSV (spec §4.2).
 *
 * On an unreachable OSV the status is `unavailable` and nothing is persisted as
 * a match — the target is reported as `known_vuln: unknown`, never as clean.
 * Partial failure (some batches failed, others succeeded) is `partial`, which
 * downstream must treat as not-clean too.
 */
export const correlateWithOsv = async (
  options: CorrelateOptions,
): Promise<OsvCorrelationResult> => {
  const log = options.log ?? (() => {})
  const client = options.client ?? new OsvClient()
  const warnings: string[] = []

  const { dependencies, unsupportedManifests } = collectDependencies(options)

  const queryable = dependencies.filter(
    (dependency) => dependency.queryable && dependency.version !== 'unpinned',
  )
  const unqueryable = dependencies.length - queryable.length

  const queries: OsvPackageQuery[] = queryable.map((dependency) => ({
    name: dependency.name,
    ecosystem: dependency.ecosystem,
    version: dependency.version,
  }))

  log(
    `[osv] ${dependencies.length} dependencies (${queryable.length} queryable, ${unqueryable} recorded only)`,
  )

  let failures = 0
  let packageMatches: OsvPackageMatch[] = []
  let commitMatches: OsvCommitMatch[] = []
  let transportDead = false

  if (queries.length > 0) {
    try {
      const refs = await client.queryPackageBatch(queries)
      const enrich = options.enrich !== false
      const maxFetches = options.maxDetailFetches ?? DEFAULT_MAX_DETAIL_FETCHES
      const detailCache = new Map<string, Awaited<ReturnType<OsvClient['getVuln']>>>()
      let fetches = 0
      let truncated = false

      for (let index = 0; index < refs.length; index += 1) {
        const hits = refs[index]!
        if (hits.length === 0) continue

        const dependency = queryable[index]!
        const vulns = []

        for (const hit of hits) {
          if (!enrich) {
            vulns.push({ id: hit.id, ...(hit.modified ? { modified: hit.modified } : {}) })
            continue
          }

          if (fetches >= maxFetches && !detailCache.has(hit.id)) {
            truncated = true
            vulns.push({ id: hit.id, ...(hit.modified ? { modified: hit.modified } : {}) })
            continue
          }

          if (!detailCache.has(hit.id)) {
            fetches += 1
            try {
              detailCache.set(hit.id, await client.getVuln(hit.id))
            } catch {
              // A missing detail should not discard the hit; keep the id.
              detailCache.set(hit.id, null)
            }
          }

          const detail = detailCache.get(hit.id)
          vulns.push(
            detail ?? { id: hit.id, ...(hit.modified ? { modified: hit.modified } : {}) },
          )
        }

        packageMatches.push({ dependency, vulns })
      }

      if (truncated) {
        warnings.push(
          `Stopped fetching OSV details after ${maxFetches}; some matches carry ids without summaries.`,
        )
      }
    } catch (error) {
      failures += 1
      if (isTransportFailure(error)) transportDead = true
      warnings.push(
        `OSV package correlation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (options.commitSha && options.commitSha !== 'unknown' && !transportDead) {
    try {
      const vulns = await client.queryCommit(options.commitSha)
      if (vulns.length > 0) {
        commitMatches.push({ commitSha: options.commitSha, vulns })
      }
    } catch (error) {
      failures += 1
      if (isTransportFailure(error)) transportDead = true
      warnings.push(
        `OSV commit correlation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const status = transportDead
    ? 'unavailable'
    : failures > 0
      ? 'partial'
      : 'complete'

  if (status === 'unavailable') {
    warnings.push(
      'OSV was unreachable; known-vulnerability status is unknown, not clean (spec §18).',
    )
    // Matches gathered before the failure are not trustworthy as a complete
    // answer, so nothing is persisted as a result.
    packageMatches = []
    commitMatches = []
  }

  if (options.db && options.targetId) {
    persistCorrelation({
      db: options.db,
      targetId: options.targetId,
      dependencies,
      packageMatches,
      commitMatches,
      status,
    })
  }

  return {
    status,
    dependencies,
    queriedPackages: queries.length,
    unqueryable,
    packageMatches,
    commitMatches,
    unsupportedManifests,
    failures,
    warnings,
  }
}
