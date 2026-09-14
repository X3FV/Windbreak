/**
 * Known-vulnerability correlation (spec §4.2).
 *
 * Host-side only: the sandbox never has a route (§6.3), so this stage runs on
 * the host and feeds `known_vuln_match` records back into state.
 */
export {
  OsvClient,
  OsvHttpError,
  OsvUnavailableError,
  OSV_BASE_URL,
  toVulnDetail,
} from './client'
export {
  collectDependencies,
  correlateWithOsv,
  DEFAULT_MAX_DETAIL_FETCHES,
  MAX_MANIFEST_BYTES,
} from './correlate'
export {
  dedupeDependencies,
  MANIFEST_PARSERS,
  normalizePyPiName,
  packageNameFromNodeModulesKey,
  parseManifest,
} from './dependencies'
export { dependencyId, osvMatchId, persistCorrelation, readCorrelationSummary } from './store'
export { OSV_QUERYABLE_ECOSYSTEMS } from './types'

export type {
  Dependency,
  OsvCommitMatch,
  OsvCorrelationResult,
  OsvPackageMatch,
  OsvPackageQuery,
  OsvStatus,
  OsvTransport,
  OsvVulnDetail,
  OsvVulnRef,
  UnsupportedManifest,
} from './types'
export type { CorrelateOptions, CorrelateRequest, CorrelateServices } from './correlate'
