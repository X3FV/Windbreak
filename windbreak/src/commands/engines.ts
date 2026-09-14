import path from 'path'

import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
  formatSeconds,
} from '../budget'
import {
  createRun,
  finishRun,
  readCandidateSummary,
  requireEngines,
  runBaselineEngines,
} from '../engines'
import { resolveRulePaths } from '../engines/rules'
import { loadConfig } from '../config'
import { openStateDatabase } from '../state/db'
import { describeMissingTarget, resolveCommandTarget } from './target'
import { parseBackendName } from './format'

import type { Command } from 'commander'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface EnginesCommandOptions {
  target: string
  commit?: string
  db?: string
  config?: string
  backend?: string
  budgetSeconds?: string
  yes?: boolean
  json?: boolean
}

/**
 * Interim command.
 *
 * Spec §7.3 folds the static core into `scan`; this exposes it directly so the
 * stage is runnable and observable before the orchestrator exists.
 */
export const registerEnginesCommand = (program: Command): void => {
  program
    .command('engines')
    .description(
      'Run the baseline static engines (spec §4.3) and record normalized candidates',
    )
    .requiredOption('--target <path>', 'path to the target checkout')
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
    .option('--config <path>', 'config file with engine and budget settings')
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--budget-seconds <n>', 'override the total target budget')
    .option('--yes', 'non-interactive: budget overruns degrade rather than prompt')
    .option('--json', 'emit machine-readable output')
    .action(async (options: EnginesCommandOptions) => {
      const loaded = loadConfig(options.config)
      const { config } = loaded

      if (loaded.violations.length > 0) {
        console.error('Configuration is invalid; refusing to run:')
        for (const violation of loaded.violations) {
          console.error(`  [${violation.role}] ${violation.message}`)
        }
        process.exitCode = 1
        return
      }

      const databasePath = options.db ?? DEFAULT_DB_PATH
      const database = openStateDatabase(databasePath)
      const preferredBackend = parseBackendName(options.backend)

      try {
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

        const rulePaths = resolveRulePaths(config.engines.rulePaths)

        // Fail closed before any sandbox starts: a configured engine that is
        // missing stops the stage rather than silently thinning the net.
        let resolved
        try {
          resolved = await requireEngines({
            required: config.engines.required,
            log: options.json ? () => {} : (line) => console.log(line),
          })
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
          return
        }

        const totalSeconds = options.budgetSeconds
          ? Number.parseInt(options.budgetSeconds, 10)
          : config.budget.totalSeconds

        if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
          console.error(`Invalid budget: ${options.budgetSeconds}`)
          process.exitCode = 1
          return
        }

        const runId = createRun({
          db: database,
          targetId: target.targetId,
          commitSha: target.commitSha,
          config: { engines: config.engines, budget: { totalSeconds, shares: config.budget.shares } },
        })

        const governor = createBudgetGovernor({
          totalSeconds,
          shares: config.budget.shares,
          db: database,
          runId,
          decide: options.yes
            ? createNonInteractiveDecider('policy:--yes')
            : createInteractiveDecider(),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        const result = await runBaselineEngines({
          targetRoot: target.targetRoot,
          targetId: target.targetId,
          commitSha: target.commitSha,
          engines: resolved.resolved,
          unavailable: resolved.unavailable,
          rulePaths,
          db: database,
          runId,
          governor,
          engineCapSeconds: config.engines.engineCapSeconds,
          jobs: config.engines.jobs,
          timeoutSeconds: config.engines.timeoutSeconds,
          ...(preferredBackend ? { preferredBackend } : {}),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        const failedEngines = result.executions.filter((execution) => execution.failed)
        const status =
          result.stoppedBy === 'budget-abort'
            ? 'aborted'
            : result.stoppedBy === 'budget-degrade'
              ? 'degraded'
              : failedEngines.length > 0
                ? 'partial'
                : 'complete'

        finishRun(database, runId, status)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                runId,
                targetId: target.targetId,
                commitSha: target.commitSha,
                status,
                candidates: result.candidates.length,
                engines: result.executions.map((execution) => ({
                  engine: execution.engine,
                  exitCode: execution.exitCode,
                  durationMs: execution.durationMs,
                  timedOut: execution.timedOut,
                  findings: execution.findings.length,
                  failed: execution.failed,
                  argv: execution.argv,
                })),
                unavailable: result.unavailable,
                budgetEvents: governor.events(),
                warnings: result.warnings,
              },
              null,
              2,
            ),
          )
          return
        }

        console.log(`\nrun id:       ${runId}`)
        console.log(`target id:    ${target.targetId}`)
        console.log(`commit:       ${target.commitSha}`)
        console.log(`budget:       ${formatSeconds(totalSeconds)} total, ` +
          `static core ${formatSeconds(governor.quotaSeconds('static-core'))}`)
        console.log(`status:       ${status}`)

        console.log('\nengines:')
        for (const execution of result.executions) {
          console.log(
            `  ${execution.engine.padEnd(10)} exit ${String(execution.exitCode).padStart(2)}  ` +
              `${String(execution.findings.length).padStart(5)} finding(s)  ` +
              `${(execution.durationMs / 1000).toFixed(1)}s` +
              `${execution.timedOut ? '  (killed at limit)' : ''}` +
              `${execution.failed && !execution.timedOut ? '  (failed)' : ''}`,
          )
        }

        if (result.unavailable.length > 0) {
          console.log('\nnot run:')
          for (const entry of result.unavailable) {
            console.log(`  ${entry.engine}: ${entry.reason}`)
          }
        }

        const summary = readCandidateSummary(database, runId)
        console.log(
          `\ncandidates:   ${summary.total}` +
            (summary.total > result.candidates.length
              ? ` (${result.candidates.length} this run)`
              : ''),
        )
        for (const row of summary.bySource) {
          console.log(`  ${row.source.padEnd(10)} ${row.count}`)
        }
        if (summary.withInjectionSignals > 0) {
          console.log(
            `\nwarning: ${summary.withInjectionSignals} candidate(s) carry instruction-like ` +
              'content from the target (spec §5.1); they are flagged, not deleted.',
          )
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        if (status === 'complete') {
          console.log('\nOK: static core complete.')
        } else {
          console.log(`\nWARN: static core ${status} — candidates are incomplete.`)
        }
      } finally {
        database.close()
      }
    })
}
