import path from 'path'

import { runRecon } from '../recon'
import { openStateDatabase } from '../state/db'
import { parseBackendName } from './format'

import type { Command } from 'commander'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface ReconCommandOptions {
  target: string
  commit?: string
  scratch?: string
  build?: boolean
  db?: string
  backend?: string
  json?: boolean
}

/**
 * Interim command.
 *
 * Spec §7.3 folds recon into `scan`; this exposes it directly so the stage is
 * runnable and observable before the orchestrator exists.
 */
export const registerReconCommand = (program: Command): void => {
  program
    .command('recon')
    .description(
      'Inventory a target, pin its revision, build it in the sandbox, and index its symbols',
    )
    .requiredOption('--target <path>', 'path to the target checkout')
    .option('--commit <sha>', 'expected commit, recorded and checked against HEAD')
    .option('--scratch <path>', 'per-run scratch directory')
    .option('--no-build', 'skip the sandboxed build step')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--json', 'emit machine-readable output')
    .action(async (options: ReconCommandOptions) => {
      const preferredBackend = parseBackendName(options.backend)

      const database = openStateDatabase(options.db ?? DEFAULT_DB_PATH)

      try {
        const result = await runRecon({
          target: options.target,
          ...(options.commit ? { commit: options.commit } : {}),
          ...(options.scratch ? { scratchDir: options.scratch } : {}),
          build: options.build !== false,
          ...(preferredBackend ? { preferredBackend } : {}),
          db: database,
          log: options.json ? () => {} : (line) => console.log(line),
        })

        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        const { target, inventory, build, programModel } = result

        console.log(`\ntarget id:    ${target.id}`)
        console.log(`location:     ${target.location}`)
        console.log(
          `commit:       ${target.commitSha}${result.git.detached ? ' (detached)' : ''}`,
        )
        console.log(
          `working tree: ${result.git.dirty === null ? 'unknown' : result.git.dirty ? 'dirty' : 'clean'}`,
        )
        console.log(`scope class:  ${target.scopeClass}`)
        console.log(
          `inventory:    ${inventory.fileCount} files, ${(inventory.totalBytes / 1024).toFixed(0)} KiB` +
            `${inventory.truncated ? ' (truncated)' : ''}`,
        )

        console.log('\nlanguages:')
        for (const entry of result.languages.slice(0, 8)) {
          console.log(
            `  ${entry.language.padEnd(12)} ${String(entry.fileCount).padStart(6)} files`,
          )
        }

        console.log(
          `\nbuild:        ${build.skipped ? 'skipped' : `${build.system} (${build.sourceMode})`}`,
        )
        console.log(`build model:  ${build.model}`)
        if (build.compileCommandsPath) {
          console.log(`compile db:   ${build.compileCommandsPath}`)
        }

        if (programModel) {
          console.log(
            `\nprogram model: ${programModel.filesParsed} files parsed, ` +
              `${programModel.symbols} symbols, ${programModel.references} call sites`,
          )
        }

        if (result.dependencyManifests.length > 0) {
          console.log(`manifests:    ${result.dependencyManifests.length}`)
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        console.log('\nOK: recon complete.')
      } finally {
        database.close()
      }
    })
}
