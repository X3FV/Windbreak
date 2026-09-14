import path from 'path'

import { loadConfig } from '../config'
import { formatLanguageCoverage, runScan } from '../scan'
import { openStateDatabase } from '../state/db'
import { VERSION } from '../version'
import { parseBackendName } from './format'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Command } from 'commander'
import type { ResolvedCommandTarget } from './target'
import type { Database } from 'bun:sqlite'
import type { ScanResult } from '../scan'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface ScanCommandOptions {
  target: string
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

const renderSummary = (result: ScanResult): void => {
  console.log(`\nrun id:       ${result.runId}`)
  console.log(`target id:    ${result.targetId}`)
  console.log(`commit:       ${result.commitSha}`)
  console.log(`status:       ${result.status}`)

  console.log('\nstages:')
  for (const stage of result.stages) {
    const seconds = `${(stage.durationMs / 1000).toFixed(1)}s`.padStart(8)
    console.log(
      `  ${stage.stage.padEnd(15)} ${stage.status.padEnd(9)} ${seconds}  ` +
        `${stage.detail ?? stage.reason ?? ''}`,
    )
    if (stage.detail && stage.reason) console.log(`  ${' '.repeat(15)} ${stage.reason}`)
  }

  console.log('\ncandidates:')
  // Three producers feed one worklist, and naming only some of them would make the
  // total look wrong. The breakdown is printed rather than just the sum because
  // "engines found nothing" and "patch mining found nothing" are different
  // statements about a target.
  console.log(`  from discovery             ${result.counts.candidates}`)
  console.log(`    of which patch-mined     ${result.counts.patchMined}`)
  console.log(`    of which variant-hunt    ${result.counts.replays}`)
  console.log(`  triaged                    ${result.counts.triaged}`)
  console.log(`  confirmed                  ${result.counts.confirmed}`)
  console.log(`  dropped                    ${result.counts.dropped}`)
  console.log(`  escalated (needs review)   ${result.counts.escalated}`)
  if (result.counts.rediscovery > 0) {
    console.log(`  rediscovery                ${result.counts.rediscovery}`)
  }

  // §20.24.5: the summary's own copy of the pin's cost, beside the candidate
  // counts rather than only in a warning. `0 candidates` immediately above must
  // not be the last word on a repository whose callables the C-shaped tables
  // never reached — that is the failure §18 names for the OSV stage.
  console.log(`\n${formatLanguageCoverage(result.languageCoverage)}`)

  if (result.report) {
    console.log('\nreport:')
    console.log(`  findings                   ${result.counts.findings}`)
    console.log(`  sarif                      ${result.report.sarifPath}`)
    console.log(`  index                      ${result.report.indexPath}`)
    console.log(`  not reported               ${result.counts.excluded}`)
  }

  for (const warning of result.warnings) console.log(`warning: ${warning}`)

  if (result.status === 'complete') {
    console.log('\nOK: scan complete.')
    return
  }

  console.log(`\nWARN: scan ${result.status}.`)
  if (result.resumeFrom) {
    console.log(
      `Resume with: windbreak resume --run ${result.runId} ` +
        '--target <path>   (the first incomplete stage is ' +
        `${result.resumeFrom})`,
    )
  }
}

const runScanCommand = async (
  options: ScanCommandOptions,
  database: Database,
  target: ResolvedCommandTarget,
): Promise<void> => {
  const loaded = loadConfig(options.config)
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
    .requiredOption('--target <path>', 'path to the target checkout')
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
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
    const databasePath = options.db ?? DEFAULT_DB_PATH
    const database = openStateDatabase(databasePath)

    try {
      const target = resolveCommandTarget({
        target: options.target,
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
    const databasePath = options.db ?? DEFAULT_DB_PATH
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
        target: options.target,
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
