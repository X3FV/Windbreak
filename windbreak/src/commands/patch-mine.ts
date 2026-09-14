import path from 'path'

import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
  formatSeconds,
} from '../budget'
import { loadConfig } from '../config'
import { createRun, finishRun, readCandidateSummary } from '../engines'
import { DEFAULT_MAX_COMMITS, DEFAULT_MAX_SITES_PER_PATTERN, runPatchMining } from '../patchmine'
import { openStateDatabase } from '../state/db'
import { parseBackendName } from './format'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Command } from 'commander'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface PatchMineCommandOptions {
  target: string
  commit?: string
  db?: string
  config?: string
  backend?: string
  budgetSeconds?: string
  maxCommits?: string
  'maxSites'?: string
  'fixSubjectsOnly'?: boolean
  yes?: boolean
  json?: boolean
}

/**
 * Interim command.
 *
 * Spec §7.3 folds the static core into `scan`; this exposes patch-mined
 * discovery directly so the stage is runnable and observable on its own, the same
 * way `recon` and `engines` are (§20.7.4). The pattern table it prints is the part
 * worth watching: it is the only place that shows *why* a pattern was admitted,
 * which §4.4.1's validation rule is the whole substance of.
 */
export const registerPatchMineCommand = (program: Command): void => {
  program
    .command('patch-mine')
    .description(
      "Mine the target's own fix history for reusable shapes and sweep for sibling sites (spec §4.4.1)",
    )
    .requiredOption('--target <path>', 'path to the target checkout')
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
    .option('--config <path>', 'config file with budget settings')
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--budget-seconds <n>', 'override the total target budget')
    .option('--max-commits <n>', `commits to walk; default ${DEFAULT_MAX_COMMITS}`)
    .option('--max-sites <n>', 'cap sibling sites per pattern', String(DEFAULT_MAX_SITES_PER_PATTERN))
    .option(
      '--fix-subjects-only',
      'only mine commits whose subject reads like a fix (off: the shape is the filter)',
    )
    .option('--yes', 'non-interactive: budget overruns degrade rather than prompt')
    .option('--json', 'emit machine-readable output')
    .action(async (options: PatchMineCommandOptions) => {
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

        const maxCommits = options.maxCommits
          ? Number.parseInt(options.maxCommits, 10)
          : DEFAULT_MAX_COMMITS
        if (!Number.isFinite(maxCommits) || maxCommits <= 0) {
          console.error(`Invalid --max-commits: ${options.maxCommits}`)
          process.exitCode = 1
          return
        }

        const maxSites = options['maxSites']
          ? Number.parseInt(options['maxSites'], 10)
          : DEFAULT_MAX_SITES_PER_PATTERN
        if (!Number.isFinite(maxSites) || maxSites <= 0) {
          console.error(`Invalid --max-sites: ${options['maxSites']}`)
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

        const log = options.json ? () => {} : (line: string) => console.log(line)

        const runId = createRun({
          db: database,
          targetId: target.targetId,
          commitSha: target.commitSha,
          config: {
            patchMine: { maxCommits, maxSites, fixSubjectsOnly: options['fixSubjectsOnly'] === true },
            budget: { totalSeconds, shares: config.budget.shares },
          },
        })

        const governor = createBudgetGovernor({
          totalSeconds,
          shares: config.budget.shares,
          db: database,
          runId,
          decide: options.yes
            ? createNonInteractiveDecider('policy:--yes')
            : createInteractiveDecider(),
          log,
        })

        const result = await runPatchMining({
          targetRoot: target.targetRoot,
          targetId: target.targetId,
          runId,
          db: database,
          governor,
          maxCommits,
          maxSitesPerPattern: maxSites,
          fixSubjectsOnly: options['fixSubjectsOnly'] === true,
          ...(preferredBackend ? { preferredBackend } : {}),
          log,
        })

        // "Nothing was mined" and "mining did not run" are different statements and
        // the status has to tell them apart: a history that could not be read is a
        // partial result, whereas a history with no recognisable shapes is a
        // complete one that found nothing.
        const status =
          result.stoppedBy === 'budget-abort'
            ? 'aborted'
            : result.stoppedBy === 'budget-degrade'
              ? 'degraded'
              : result.coverage.commitsRead === 0
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
                patterns: result.patterns,
                rejected: result.rejected.length,
                coverage: result.coverage,
                commitsConsidered: result.commitsConsidered,
                sites: result.sites,
                candidates: result.candidates.length,
                persisted: result.persisted,
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
        console.log(
          `budget:       ${formatSeconds(totalSeconds)} total, ` +
            `static core ${formatSeconds(governor.quotaSeconds('static-core'))}`,
        )
        console.log(`status:       ${status}`)

        console.log(
          `\nhistory:      ${result.coverage.commitsRead} commit(s) read, ` +
            `${result.commitsConsidered} considered, ` +
            `${result.coverage.hunksExamined} hunk(s) examined`,
        )

        if (result.patterns.length > 0) {
          console.log('\npatterns (§4.4.1 — each validated against its own patch):')
          for (const pattern of result.patterns) {
            const target_ = pattern.operation ?? '(shape only)'
            console.log(
              `  ${pattern.id}  ${pattern.shape.padEnd(13)} ${String(pattern.occurrences) + 'x'}  ` +
                `${target_.padEnd(12)} ${pattern.originFile}`,
            )
          }
        } else {
          console.log('\npatterns:    none validated')
        }

        if (result.sites.length > 0) {
          console.log('\nsibling sites:')
          for (const site of result.sites) {
            console.log(
              `  ${site.filePath}:${site.matchLine}  ${site.functionName}  — ${site.evidence}`,
            )
          }
        }

        // The drops are reported with their reason, because §4.4.1 says patterns
        // that do not validate are *dropped* — and a count alone would not
        // distinguish "the taxonomy did not apply" from "the detector was wrong".
        if (result.rejected.length > 0) {
          const bothSides = result.rejected.filter(
            (entry) => entry.validation.preImageFlagged && entry.validation.postImageFlagged,
          ).length
          const neither = result.rejected.length - bothSides
          console.log(
            `\ndropped:     ${result.rejected.length} hunk(s) — ` +
              `${bothSides} fired on the fixed code too, ${neither} never fired on the pre-image`,
          )
        }

        const summary = readCandidateSummary(database, runId)
        console.log(`\ncandidates:   ${summary.total}`)
        for (const row of summary.bySource) {
          console.log(`  ${row.source.padEnd(12)} ${row.count}`)
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        if (status === 'complete') {
          console.log('\nOK: patch-mined discovery complete.')
        } else {
          console.log(`\nWARN: patch-mined discovery ${status} — results are incomplete.`)
        }
      } finally {
        database.close()
      }
    })
}
