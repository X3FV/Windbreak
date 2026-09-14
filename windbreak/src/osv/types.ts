/**
 * Types for the known-vulnerability correlation stage (spec §4.2).
 */

/** Ecosystems OSV can be queried by. Anything else is recorded but not checked. */
export const OSV_QUERYABLE_ECOSYSTEMS = new Set([
  'npm',
  'PyPI',
  'crates.io',
  'Go',
  'RubyGems',
  'Packagist',
  'Maven',
  'NuGet',
  'Hex',
  'Pub',
])

export interface Dependency {
  /** OSV ecosystem name when queryable; the manifest's label otherwise. */
  ecosystem: string
  name: string
  version: string
  /** True when the manifest pins an exact version rather than a range. */
  exact: boolean
  /** Manifest path relative to the target root. */
  manifestPath: string
  queryable: boolean
  /** Why it is not queryable. Present only when `queryable` is false. */
  reason?: string
}

/** A package/version pair to send to OSV. */
export interface OsvPackageQuery {
  name: string
  ecosystem: string
  version: string
}

/** `querybatch` returns only this much per hit; details need a second fetch. */
export interface OsvVulnRef {
  id: string
  modified?: string
}

export interface OsvSeverity {
  type: string
  score: string
}

export interface OsvVulnDetail {
  id: string
  summary?: string
  details?: string
  aliases?: string[]
  modified?: string
  published?: string
  severity?: OsvSeverity[]
  databaseSpecific?: Record<string, unknown>
}

export interface OsvTransport {
  post(path: string, body: unknown): Promise<unknown>
  get(path: string): Promise<unknown>
}

export interface OsvPackageMatch {
  dependency: Dependency
  vulns: OsvVulnDetail[]
}

export interface OsvCommitMatch {
  commitSha: string
  vulns: OsvVulnDetail[]
}

export interface UnsupportedManifest {
  path: string
  type: string
  reason: string
}

/**
 * Whether correlation actually happened.
 *
 * `unavailable` is the important one: when OSV cannot be reached, a target must
 * never be reported as having no known vulnerabilities. The spec's failure table
 * (§18) requires "record `known_vuln: unknown`; do not pretend correlation
 * happened".
 */
export type OsvStatus = 'complete' | 'partial' | 'unavailable'

export interface OsvCorrelationResult {
  status: OsvStatus
  dependencies: Dependency[]
  /** Packages actually sent to OSV. */
  queriedPackages: number
  /**
   * Recorded but never checked, e.g. a range-pinned dependency or an ecosystem
   * OSV does not cover. Kept separate so "0 matches" cannot be read as "clean".
   */
  unqueryable: number
  packageMatches: OsvPackageMatch[]
  commitMatches: OsvCommitMatch[]
  unsupportedManifests: UnsupportedManifest[]
  /** Requests that failed, which is what makes the status non-complete. */
  failures: number
  warnings: string[]
}
