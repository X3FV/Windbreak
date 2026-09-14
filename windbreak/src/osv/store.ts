import { createHash } from 'crypto'

import type { Database } from 'bun:sqlite'
import type { Dependency, OsvPackageMatch, OsvVulnDetail } from './types'

/**
 * Persistence for the known-vulnerability correlation stage (spec §4.2).
 *
 * Ids are content hashes rather than random, so re-running correlation against
 * the same commit replaces its rows instead of duplicating them. §11.3 compares
 * runs across invocations, which only works if the same input yields the same
 * rows.
 */

const hashId = (prefix: string, key: string): string =>
  `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`

export const dependencyId = (targetId: string, dependency: Dependency): string =>
  hashId(
    'dep',
    `${targetId}:${dependency.ecosystem}:${dependency.name}:${dependency.version}:${dependency.manifestPath}`,
  )

export const osvMatchId = (
  targetId: string,
  source: 'package' | 'commit',
  key: string,
  vulnId: string,
): string => hashId('osv', `${targetId}:${source}:${key}:${vulnId}`)

export interface PersistCorrelationInput {
  db: Database
  targetId: string
  dependencies: readonly Dependency[]
  packageMatches: readonly OsvPackageMatch[]
  commitMatches: readonly { commitSha: string; vulns: OsvVulnDetail[] }[]
  status: string
}

/**
 * Replace this target's dependency and match rows.
 *
 * Deletes first: a dependency that is no longer present, or a match that has
 * since been withdrawn from OSV, must not linger in state and get reported.
 */
export const persistCorrelation = (input: PersistCorrelationInput): void => {
  const { db, targetId } = input

  const insertDependency = db.prepare(
    `INSERT OR REPLACE INTO dependencies
       (id, target_id, ecosystem, name, version, exact, queryable, manifest_path, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const insertMatch = db.prepare(
    `INSERT OR REPLACE INTO osv_matches
       (id, target_id, source, dependency_id, ecosystem, name, version, commit_sha,
        vuln_id, summary, published, modified, aliases_json, severity_json, raw_json, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const now = new Date().toISOString()

  db.transaction(() => {
    // Cascades handle `osv_matches` rows that reference a deleted dependency.
    db.prepare('DELETE FROM osv_matches WHERE target_id = ?').run(targetId)
    db.prepare('DELETE FROM dependencies WHERE target_id = ?').run(targetId)

    const dependencyIds = new Map<Dependency, string>()
    for (const dependency of input.dependencies) {
      const id = dependencyId(targetId, dependency)
      dependencyIds.set(dependency, id)
      insertDependency.run(
        id,
        targetId,
        dependency.ecosystem,
        dependency.name,
        dependency.version,
        dependency.exact ? 1 : 0,
        dependency.queryable ? 1 : 0,
        dependency.manifestPath,
        dependency.reason ?? null,
      )
    }

    for (const match of input.packageMatches) {
      const dependency = match.dependency
      const dependencyKey = dependencyIds.get(dependency) ?? null
      const key = `${dependency.ecosystem}:${dependency.name}:${dependency.version}`

      for (const vuln of match.vulns) {
        insertMatch.run(
          osvMatchId(targetId, 'package', key, vuln.id),
          targetId,
          'package',
          dependencyKey,
          dependency.ecosystem,
          dependency.name,
          dependency.version,
          null,
          vuln.id,
          vuln.summary ?? null,
          vuln.published ?? null,
          vuln.modified ?? null,
          vuln.aliases ? JSON.stringify(vuln.aliases) : null,
          vuln.severity ? JSON.stringify(vuln.severity) : null,
          JSON.stringify(vuln),
          now,
        )
      }
    }

    for (const match of input.commitMatches) {
      for (const vuln of match.vulns) {
        insertMatch.run(
          osvMatchId(targetId, 'commit', match.commitSha, vuln.id),
          targetId,
          'commit',
          null,
          null,
          null,
          null,
          match.commitSha,
          vuln.id,
          vuln.summary ?? null,
          vuln.published ?? null,
          vuln.modified ?? null,
          vuln.aliases ? JSON.stringify(vuln.aliases) : null,
          vuln.severity ? JSON.stringify(vuln.severity) : null,
          JSON.stringify(vuln),
          now,
        )
      }
    }

    db.prepare('UPDATE targets SET osv_status = ? WHERE id = ?').run(
      input.status,
      targetId,
    )
  })()
}

/** Counts for the CLI summary and for §11 metrics. */
export const readCorrelationSummary = (
  db: Database,
  targetId: string,
): { dependencies: number; queryable: number; matches: number } => {
  const count = (sql: string, ...params: string[]): number =>
    db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0

  return {
    dependencies: count(
      'SELECT COUNT(*) AS n FROM dependencies WHERE target_id = ?',
      targetId,
    ),
    queryable: count(
      'SELECT COUNT(*) AS n FROM dependencies WHERE target_id = ? AND queryable = 1',
      targetId,
    ),
    matches: count(
      'SELECT COUNT(*) AS n FROM osv_matches WHERE target_id = ?',
      targetId,
    ),
  }
}
