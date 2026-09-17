import { loadEffectiveConfig } from '../config'
import { runScan, scanSummaryLines } from '../scan'
import { openStateDatabase } from '../state/db'
import { VERSION } from '../version'
import {
  DB_OPTION_DESCRIPTION,
  defaultDbPath,
  defaultTargetPath,
  requireTargetOption,
  TARGET_OPTION_DESCRIPTION,
} from './defaults'
import { parseBackendName } from './format'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Command } from 'commander'
import type { ResolvedCommandTarget } from './target'
import type { Database } from 'bun:sqlite'
import type { ScanResult } from '../scan'

interface ScanCommandOptions {
  target?: string
  commit?: string
  db?: string
  config?: string
  run?: string
  scratch?: string
  out?: string
  backend?: string
  budgetSeconds?: string
  yes?: boolean
  cache?: boolean
  enrich?: boolean
  refresh?: boolean
  build?: boolean
  staticOnly?: boolean
  updateLibrary?: boolean
  json?: boolean
}

/**
 * Print the summary the TUI renders.
 *
 * One write rather than a line at a time, and the text is identical either way: the lines
 * carry their own blank rows, and `scan/summary.ts` exists so this command and the in-TUI
 * view cannot drift into two accounts of the same run.
 */
const renderSummary = (result: ScanResult): void => {
  console.log(scanSummaryLines(result).join('\n'))
}

const runScanCommand = async (
  options: ScanCommandOptions,
  database: Database,
  target: ResolvedCommandTarget,
): Promise<void> => {
  const loaded = loadEffectiveConfig(options.config)
  if (loaded.violations.length > 0) {
    console.error('Configuration is invalid; refusing to run:')
    for (const violation of loaded.violations) {
      console.error(`  [${violation.role}] ${violation.message}`)
    }
    process.exitCode = 1
    return
  }

  const preferredBackend = parseBackendName(options.backend)
  const budgetSeconds = options.budgetSeconds
    ? Number.parseInt(options.budgetSeconds, 10)
    : undefined

  if (options.budgetSeconds && (!Number.isFinite(budgetSeconds) || budgetSeconds! <= 0)) {
    console.error(`Invalid --budget-seconds: ${options.budgetSeconds}`)
    process.exitCode = 1
    return
  }

  const result = await runScan({
    db: database,
    targetRoot: target.targetRoot,
    targetId: target.targetId,
    commitSha: target.commitSha,
    config: loaded.config,
    ...(options.run ? { runId: options.run } : {}),
    ...(options.scratch ? { scratchDir: options.scratch } : {}),
    ...(options.out ? { outDir: options.out } : {}),
    ...(options.budgetSeconds ? { budgetSeconds } : {}),
    ...(preferredBackend ? { preferredBackend } : {}),
    // Omitted rather than defaulted when the flag is absent, so a `resume` can
    // inherit them from the run it is continuing (see `scan/run.ts`). Passing
    // `false` here would silently cancel the recorded mode.
    ...(options.staticOnly === undefined ? {} : { staticOnly: options.staticOnly }),
    ...(options.updateLibrary === undefined ? {} : { updateLibrary: options.updateLibrary }),
    cacheDisabled: options.cache === false,
    enrich: options.enrich !== false,
    refresh: options.refresh !== false,
    build: options.build !== false,
    yes: options.yes === true,
    version: VERSION,
    log: options.json ? () => {} : (line) => console.log(line),
  })

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    renderSummary(result)
  }

  // A partial scan is not a failure — discovery-only and unanswered queue items
  // are legitimate outcomes — but it must not exit 0 as if the chain ran.
  if (result.status !== 'complete') process.exitCode = 1
}

const addScanOptions = (command: Command, options: { resume: boolean }): Command => {
  command
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--config <path>', 'config file with model, budget, and engine settings')
    .option('--scratch <path>', 'per-run scratch directory for sandboxed work')
    .option('--out <dir>', 'report output directory')
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--budget-seconds <n>', 'override the total target budget (spec §9)')
    .option('--yes', 'non-interactive: budget overruns degrade rather than prompt')
    .option('--no-cache', 'ignore the verdict cache and force fresh model calls')
    .option('--no-enrich', "skip the second triage pass for 'needs-context'")
    .option('--no-refresh', 'do not re-query OSV for the rediscovery check')
    .option('--no-build', 'skip the sandboxed build during recon')
    .option('--static-only', 'run discovery and reporting, skipping every model stage')
    .option(
      '--update-library',
      'generalize this scan\'s confirmed findings into library patterns (one model call each)',
    )
    .option('--json', 'emit machine-readable output')

  if (options.resume) {
    command.requiredOption('--run <id>', 'the run to continue')
  }

  return command
}

export const registerScanCommand = (program: Command): void => {
  addScanOptions(
    program
      .command('scan')
      .description(
        'Run the full pipeline against a target: recon, OSV, engines, variant hunting, ' +
          'triage, verification, reporting (spec §3.2)',
      ),
    { resume: false },
  ).action(async (options: ScanCommandOptions) => {
    const targetPath = requireTargetOption(options.target)
    if (targetPath === null) return

    const databasePath = options.db ?? defaultDbPath()
    const database = openStateDatabase(databasePath)

    try {
      const target = resolveCommandTarget({
        target: targetPath,
        ...(options.commit ? { commit: options.commit } : {}),
        db: database,
      })

      // `scan` starts with recon, so a target that is not in the database yet is
      // expected rather than an error.
      await runScanCommand(options, database, target)
    } finally {
      database.close()
    }
  })

  addScanOptions(
    program
      .command('resume')
      .description('Continue an interrupted run from its first incomplete stage (spec §7.3)'),
    { resume: true },
  ).action(async (options: ScanCommandOptions) => {
    const targetPath = requireTargetOption(options.target)
    if (targetPath === null) return

    const databasePath = options.db ?? defaultDbPath()
    const database = openStateDatabase(databasePath)

    try {
      const run = database
        .query<{ target_id: string }, [string]>(
          'SELECT target_id FROM runs WHERE id = ?',
        )
        .get(options.run!)

      if (!run) {
        console.error(`No run ${options.run} in ${databasePath}.`)
        process.exitCode = 1
        return
      }

      const target = resolveCommandTarget({
        target: targetPath,
        ...(options.commit ? { commit: options.commit } : {}),
        db: database,
      })

      if (!target.exists) {
        console.error(describeMissingTarget(target, databasePath))
        process.exitCode = 1
        return
      }

      if (target.targetId !== run.target_id) {
        console.error(
          `Run ${options.run} belongs to target ${run.target_id}, but --target resolves to ` +
            `${target.targetId}. Point --target at the checkout the run was started from.`,
        )
        process.exitCode = 1
        return
      }

      await runScanCommand(options, database, target)
    } finally {
      database.close()
    }
  })
}
