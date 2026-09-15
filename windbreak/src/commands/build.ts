import path from 'path'

import { buildStepArgv, prepareBuild, runBuild } from '../build'
import { defaultTargetPath, requireTargetOption, TARGET_OPTION_DESCRIPTION } from './defaults'
import { formatArgv, parseBackendName } from './format'

import type { Command } from 'commander'

const DEFAULT_SCRATCH = path.resolve('.windbreak', 'scratch')

interface BuildCommandOptions {
  target?: string
  scratch?: string
  compile?: boolean
  jobs?: string
  backend?: string
  timeLimit?: string
  dryRun?: boolean
}

const parsePositiveInt = (value: string | undefined, label: string) => {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, got "${value}".`)
  }
  return parsed
}

/**
 * Interim command.
 *
 * The spec folds build into ingestion (recon, §4.1) and does not list a
 * standalone `windbreak build` in §7.3. It exists here so the sandbox wiring is
 * exercisable — and so `--dry-run` can show the exact sandboxed argv — before
 * recon lands. When recon is built, this becomes its build step.
 */
export const registerBuildCommand = (program: Command): void => {
  program
    .command('build')
    .description(
      'Generate a compilation database by running the target build inside the sandbox',
    )
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--scratch <path>', 'per-run scratch directory', DEFAULT_SCRATCH)
    .option('--compile', 'also compile, not just configure')
    .option('--jobs <n>', 'parallelism for build tools', '4')
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--time-limit <seconds>', 'wall-clock limit for each step')
    .option('--dry-run', 'print the sandboxed commands without executing them')
    .action(async (options: BuildCommandOptions) => {
      const targetPath = requireTargetOption(options.target)
      if (targetPath === null) return

      const preferredBackend = parseBackendName(options.backend)
      const jobs = parsePositiveInt(options.jobs, '--jobs')
      const timeLimitSeconds = parsePositiveInt(
        options.timeLimit,
        '--time-limit',
      )

      const runOptions = {
        checkoutDir: targetPath,
        scratchDir: options.scratch ?? DEFAULT_SCRATCH,
        compile: options.compile ?? false,
        ...(jobs !== undefined ? { jobs } : {}),
        ...(timeLimitSeconds !== undefined ? { timeLimitSeconds } : {}),
        ...(preferredBackend ? { preferredBackend } : {}),
      }

      if (options.dryRun) {
        const prepared = prepareBuild(runOptions)

        console.log(`target:      ${prepared.checkoutDir}`)
        console.log(`scratch:     ${prepared.scratchDir}`)
        console.log(
          `build system: ${prepared.detection.system} ` +
            `(from ${prepared.detection.evidence.join(', ') || 'no markers'})`,
        )
        console.log(
          `source mode: ${prepared.plan.sourceMode} ` +
            `(source dir inside sandbox: ${prepared.sourceDir})`,
        )
        console.log(`backend:     ${prepared.backend.name}`)
        console.log(`steps:       ${prepared.plan.steps.length}`)

        for (const warning of prepared.warnings) {
          console.log(`warning:     ${warning}`)
        }

        for (const { step, argv } of buildStepArgv(prepared)) {
          console.log(`\n# ${step.description}`)
          console.log(`# cwd: ${step.cwd}`)
          console.log(formatArgv(argv))
        }

        if (prepared.plan.steps.length === 0) {
          console.log('\nNo steps to run.')
        }
        return
      }

      const result = await runBuild({
        ...runOptions,
        log: (line) => console.log(line),
      })

      console.log(
        `\nbuild system: ${result.detection.system} (${result.plan.sourceMode})`,
      )
      for (const outcome of result.stepOutcomes) {
        console.log(
          `  ${outcome.exitCode === 0 ? 'ok  ' : 'fail'} ${outcome.step.description} ` +
            `(${outcome.durationMs}ms${outcome.timedOut ? ', timed out' : ''})`,
        )
      }

      if (result.compileCommandsPath) {
        console.log(`compile_commands.json: ${result.compileCommandsPath}`)
      }

      for (const warning of result.warnings) {
        console.log(`warning: ${warning}`)
      }

      if (!result.ok) {
        process.exitCode = 1
        return
      }

      console.log('\nOK: build finished inside the sandbox.')
    })
}
