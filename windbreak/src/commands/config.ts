import { loadConfig } from '../config'
import { modelVendor, UNMETERED_MODEL_IDS } from '../models'

import type { Command } from 'commander'

interface ConfigCommandOptions {
  config?: string
}

export const registerConfigCommand = (program: Command): void => {
  const config = program
    .command('config')
    .description('Inspect and validate the WindBreak configuration')

  config
    .command('validate')
    .description(
      'Validate model roles, including the cross-provider requirement for verification',
    )
    .option('--config <path>', 'path to a windbreak config file')
    .action((options: ConfigCommandOptions) => {
      const { violations, sourcePath } = loadConfig(options.config)

      if (sourcePath) {
        console.log(`Config: ${sourcePath}`)
      } else {
        console.log('Config: built-in defaults')
      }

      if (violations.length > 0) {
        console.error(`\n${violations.length} problem(s) found:\n`)
        for (const violation of violations) {
          console.error(`  [${violation.role}] ${violation.message}`)
        }
        process.exitCode = 1
        return
      }

      console.log('OK: model configuration is valid.')
    })

  config
    .command('show')
    .description('Print the effective configuration')
    .option('--config <path>', 'path to a windbreak config file')
    .action((options: ConfigCommandOptions) => {
      const { config: loaded, sourcePath } = loadConfig(options.config)

      console.log(JSON.stringify({ source: sourcePath, ...loaded }, null, 2))
    })

  config
    .command('models')
    .description('List the unmetered model ids WindBreak may use')
    .action(() => {
      for (const modelId of UNMETERED_MODEL_IDS) {
        console.log(`${modelVendor(modelId)}\t${modelId}`)
      }
    })
}
