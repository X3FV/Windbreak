import { resolveEngines, UNIMPLEMENTED_ENGINES } from '../engines'
import { defaultRulePaths, DEFAULT_RULES_DIR } from '../engines/rules'

import type { Command } from 'commander'

interface PrepareCommandOptions {
  engine?: string[]
  json?: boolean
}

/**
 * Host-side engine setup (spec §6.3).
 *
 * The sandbox binds neither `$HOME` nor any package root a user-level install
 * needs, so a tool like Semgrep — a Python entry point under `~/.local` — is
 * invisible inside it by design. Rather than loosening the sandbox, `prepare`
 * resolves each engine on the host and reports exactly which directories and
 * environment the stage will bind read-only at scan time.
 *
 * This command runs no target code and touches no target content.
 */
export const registerPrepareCommand = (program: Command): void => {
  program
    .command('prepare')
    .description(
      'Resolve baseline engines on the host and report what the sandbox will bind',
    )
    .option(
      '--engine <name...>',
      'engines to resolve (default: the engines this build drives)',
    )
    .option('--json', 'emit machine-readable output')
    .action(async (options: PrepareCommandOptions) => {
      const engines = options.engine ?? ['semgrep']

      const result = await resolveEngines({
        engines,
        log: options.json ? () => {} : (line) => console.log(line),
      })

      const rulePaths = defaultRulePaths()

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              engines: result.resolved,
              unavailable: result.unavailable,
              rulePaths,
              rulesDir: DEFAULT_RULES_DIR,
            },
            null,
            2,
          ),
        )
        return
      }

      console.log('\nengines ready to bind:')
      for (const engine of result.resolved) {
        console.log(`  ${engine.engine} ${engine.version}`)
        console.log(`    binary:  ${engine.binary}`)
        console.log(`    binds:   ${engine.readOnlyRoots.join('\n             ')}`)
      }

      if (result.unavailable.length > 0) {
        console.log('\nnot available:')
        for (const entry of result.unavailable) {
          console.log(`  ${entry.engine}: ${entry.reason}`)
        }
      }

      console.log('\nrules:')
      for (const rulePath of rulePaths) {
        console.log(`  ${rulePath}`)
      }

      console.log(`\nnot driven yet (§4.3): ${UNIMPLEMENTED_ENGINES.join(', ')}`)

      if (result.resolved.length === 0) {
        console.error(
          '\nNo baseline engine could be resolved; `windbreak engines` will refuse to run.',
        )
        process.exitCode = 1
        return
      }

      console.log('\nOK: prepare complete.')
    })
}
