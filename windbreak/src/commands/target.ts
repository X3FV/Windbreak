import path from 'path'

import { readGitRefs } from '../recon/git'
import { createTargetId } from '../recon/run'

import type { Database } from 'bun:sqlite'

/**
 * Resolve a `--target` path to the target record recon would have created.
 *
 * The id must be computed the same way recon computes it, or a stage would
 * attach its rows to a target that does not exist.
 */
export interface ResolvedCommandTarget {
  targetRoot: string
  commitSha: string
  targetId: string
  exists: boolean
}

export const targetExists = (db: Database, targetId: string): boolean =>
  (db
    .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM targets WHERE id = ?')
    .get(targetId)?.n ?? 0) > 0

export const resolveCommandTarget = (options: {
  target: string
  commit?: string
  db: Database
}): ResolvedCommandTarget => {
  const targetRoot = path.resolve(options.target)
  const git = readGitRefs(targetRoot)
  const commitSha = options.commit ?? git.commitSha ?? 'unknown'
  const targetId = createTargetId(targetRoot, commitSha)

  return {
    targetRoot,
    commitSha,
    targetId,
    exists: targetExists(options.db, targetId),
  }
}

export const describeMissingTarget = (
  target: ResolvedCommandTarget,
  dbPath: string,
): string =>
  `No target ${target.targetId} in ${dbPath}.\n` +
  `Run \`windbreak recon --target ${target.targetRoot}\` first so the target is pinned and indexed.`
