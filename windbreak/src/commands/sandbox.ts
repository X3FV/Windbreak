import {
  detectBackends,
  resolveBackend,
  runSandboxProbes,
  SANDBOX_BACKEND_PREFERENCE,
  SandboxUnavailableError,
} from '../sandbox'
import { parseBackendName } from './format'

import type { Command } from 'commander'

interface SandboxCommandOptions {
  backend?: string
  json?: boolean
}

export const registerSandboxCommand = (program: Command): void => {
  const sandbox = program
    .command('sandbox')
    .description('Inspect and verify the sandbox that target code runs in')

  sandbox
    .command('check')
    .description(
      'Report the host platform and which sandbox backends are available',
    )
    .option('--backend <name>', 'require a specific backend (nsjail|bwrap)')
    .option('--json', 'emit machine-readable output')
    .action((options: SandboxCommandOptions) => {
      const platform = process.platform
      const available = detectBackends()
      const preferred = parseBackendName(options.backend)

      let selected: { name: string; binary: string } | null = null
      let error: string | null = null

      try {
        selected = resolveBackend(preferred ? { preferred } : {})
      } catch (cause) {
        error =
          cause instanceof SandboxUnavailableError
            ? cause.message
            : String(cause)
      }

      if (options.json) {
        console.log(
          JSON.stringify({ platform, available, preference: SANDBOX_BACKEND_PREFERENCE, selected, error }, null, 2),
        )
        process.exitCode = error ? 1 : 0
        return
      }

      console.log(`host platform: ${platform}`)
      console.log(`preference:    ${SANDBOX_BACKEND_PREFERENCE.join(' -> ')}`)
      console.log('available:')
      for (const name of SANDBOX_BACKEND_PREFERENCE) {
        const binary = available[name]
        console.log(`  ${name.padEnd(7)} ${binary ?? 'not found'}`)
      }

      if (!selected) {
        console.error(`\n${error}`)
        process.exitCode = 1
        return
      }

      console.log(`\nselected:      ${selected.name} (${selected.binary})`)
      console.log('\nOK: a sandbox backend is available.')
    })

  sandbox
    .command('probe')
    .description(
      'Run live probes: exec works, the read-only bind refuses writes, and the sandbox has no network',
    )
    .option('--backend <name>', 'require a specific backend (nsjail|bwrap)')
    .action(async (options: SandboxCommandOptions) => {
      const preferred = parseBackendName(options.backend)

      try {
        resolveBackend(preferred ? { preferred } : {})
      } catch (cause) {
        console.error(cause instanceof Error ? cause.message : String(cause))
        process.exitCode = 1
        return
      }

      const results = await runSandboxProbes(
        preferred ? { preferred } : {},
      )

      for (const result of results) {
        console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
        console.log(`      ${result.detail}`)
      }

      const failed = results.filter((result) => !result.ok)
      if (failed.length > 0) {
        console.error(`\n${failed.length} probe(s) failed.`)
        process.exitCode = 1
        return
      }

      console.log('\nOK: all sandbox probes passed.')
    })
}
