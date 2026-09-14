import path from 'path'

import { correlateWithOsv } from '../osv'
import { collectInventory } from '../recon/inventory'
import { findManifests } from '../recon/deps'
import { openStateDatabase } from '../state/db'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Command } from 'commander'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface OsvCommandOptions {
  target: string
  commit?: string
  db?: string
  enrich?: boolean
  json?: boolean
}

/**
 * Interim command.
 *
 * Spec §7.3 folds correlation into `scan`; this exposes it directly so the
 * stage is runnable and observable before the orchestrator exists.
 */
export const registerOsvCommand = (program: Command): void => {
  program
    .command('osv')
    .description(
      'Correlate a target\'s dependency manifests and commit against OSV.dev',
    )
    .requiredOption('--target <path>', 'path to the target checkout')
    .option('--commit <sha>', 'commit to query; defaults to the checkout HEAD')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
    .option(
      '--no-enrich',
      'skip fetching full advisory records (one querybatch request only)',
    )
    .option('--json', 'emit machine-readable output')
    .action(async (options: OsvCommandOptions) => {
      const databasePath = options.db ?? DEFAULT_DB_PATH
      const database = openStateDatabase(databasePath)

      try {
        const target = resolveCommandTarget({
          target: options.target,
          ...(options.commit ? { commit: options.commit } : {}),
          db: database,
        })
        const { targetRoot, commitSha, targetId } = target

        if (!target.exists) {
          console.error(describeMissingTarget(target, databasePath))
          process.exitCode = 1
          return
        }

        const inventory = collectInventory(targetRoot)
        const manifests = findManifests(
          inventory.files.filter((file) => !file.binary),
        )

        const result = await correlateWithOsv({
          targetRoot,
          manifests,
          targetId,
          commitSha,
          db: database,
          enrich: options.enrich !== false,
          log: options.json ? () => {} : (line) => console.log(line),
        })

        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        console.log(`\ntarget id:    ${targetId}`)
        console.log(`commit:       ${commitSha}`)
        console.log(`status:       ${result.status}`)
        console.log(
          `dependencies: ${result.dependencies.length} ` +
            `(${result.queriedPackages} queried, ${result.unqueryable} recorded only)`,
        )
        console.log(`matches:      ${result.packageMatches.length} packages`)

        if (result.commitMatches.length > 0) {
          console.log(
            `commit hits:  ${result.commitMatches.reduce((total, match) => total + match.vulns.length, 0)}`,
          )
        }

        if (result.unsupportedManifests.length > 0) {
          console.log('\nnot checked:')
          for (const manifest of result.unsupportedManifests) {
            console.log(`  ${manifest.path}: ${manifest.reason}`)
          }
        }

        if (result.packageMatches.length > 0) {
          console.log('\nknown-vulnerable dependencies:')
          for (const match of result.packageMatches) {
            const ids = match.vulns.map((vuln) => vuln.id).join(', ')
            console.log(
              `  ${match.dependency.name}@${match.dependency.version} → ${ids}`,
            )
          }
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        console.log(
          result.status === 'complete'
            ? '\nOK: correlation complete.'
            : `\nWARN: correlation ${result.status} — do not read this as clean.`,
        )
      } finally {
        database.close()
      }
    })
}
