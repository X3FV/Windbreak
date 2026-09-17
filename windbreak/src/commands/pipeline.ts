import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
  formatSeconds,
} from '../budget'
import {
  MissingCredentialsError,
  SdkEnvironmentError,
  createWindbreakClient,
} from '../client'
import { loadEffectiveConfig } from '../config'
import { OsvClient } from '../osv'
import { describeProviderFailure, findProviderFailure } from '../provider-failure'
import {
  runPipeline,
  createProgramContext,
  createSdkModelInvoker,
  latestRunForTarget,
  readCandidatesForTriage,
} from '../pipeline'
import { openStateDatabase } from '../state/db'
import {
  DB_OPTION_DESCRIPTION,
  defaultDbPath,
  defaultTargetPath,
  requireTargetOption,
  TARGET_OPTION_DESCRIPTION,
} from './defaults'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { FreebuffSessions } from '../freebuff-session'

import type { Command } from 'commander'
import type { KnownVulnRecord } from '../pipeline'

interface PipelineCommandOptions {
  target?: string
  commit?: string
  db?: string
  config?: string
  run?: string
  budgetSeconds?: string
  yes?: boolean
  cache?: boolean
  enrich?: boolean
  refresh?: boolean
  json?: boolean
}

/**
 * Interim command.
 *
 * Spec §7.3 folds triage and verification into `scan`; this exposes them
 * directly so the stage is runnable and observable before the orchestrator
 * exists. It reuses the run row the `engines` stage created rather than starting
 * a second run for the same target scan (§9 is a per-target budget).
 */
export const registerPipelineCommand = (program: Command): void => {
  program
    .command('pipeline')
    .description(
      'Triage recorded candidates and cross-model-verify them (spec §4.6, §5.2)',
    )
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--config <path>', 'config file with model and budget settings')
    .option('--run <id>', 'run to attach to; defaults to the target\'s latest run')
    .option('--budget-seconds <n>', 'override the total target budget')
    .option('--yes', 'non-interactive: budget overruns degrade rather than prompt')
    .option('--no-cache', 'ignore the verdict cache and force fresh model calls')
    .option('--no-enrich', "skip the second triage pass for 'needs-context'")
    .option('--no-refresh', 'do not re-query OSV for the rediscovery check')
    .option('--json', 'emit machine-readable output')
    .action(async (options: PipelineCommandOptions) => {
      const targetPath = requireTargetOption(options.target)
      if (targetPath === null) return

      const loaded = loadEffectiveConfig(options.config)
      const { config } = loaded

      // §5.2 / §18: Proposer and Refuter on the same provider is refused, not
      // warned about. Cross-model gating is the point of the stage.
      if (loaded.violations.length > 0) {
        console.error('Configuration is invalid; refusing to run:')
        for (const violation of loaded.violations) {
          console.error(`  [${violation.role}] ${violation.message}`)
        }
        process.exitCode = 1
        return
      }

      const databasePath = options.db ?? defaultDbPath()
      const database = openStateDatabase(databasePath)
      // Declared outside the `try` because the release runs in its `finally`, and a
      // `let` in a try block is not in scope there.
      let closeSessions: (() => Promise<void>) | undefined

      try {
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

        const run = options.run
          ? { id: options.run, commitSha: target.commitSha }
          : latestRunForTarget(database, target.targetId)

        if (!run) {
          console.error(
            `No run recorded for target ${target.targetId}. ` +
              'Run `windbreak engines --target ...` first; the pipeline consumes its candidates.',
          )
          process.exitCode = 1
          return
        }

        const candidates = readCandidatesForTriage(database, run.id)

        // Fail closed before any model call: no credentials is a hard error, not
        // an empty run. The client carries its Freebuff sessions (§20.41).
        let client
        let sessions: FreebuffSessions
        try {
          const windbreak = await createWindbreakClient()
          client = windbreak.client
          sessions = windbreak.sessions
          closeSessions = windbreak.close
        } catch (error) {
          if (error instanceof MissingCredentialsError || error instanceof SdkEnvironmentError) {
            console.error(error.message)
            process.exitCode = 1
            return
          }
          throw error
        }

        const invoker = createSdkModelInvoker({
          client,
          sessions,
          models: config.models,
          log: options.json ? () => {} : (line) => console.log(line),
        })

        const programContext = createProgramContext(database, target.targetId)

        const totalSeconds = options.budgetSeconds
          ? Number.parseInt(options.budgetSeconds, 10)
          : config.budget.totalSeconds

        if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
          console.error(`Invalid budget: ${options.budgetSeconds}`)
          process.exitCode = 1
          return
        }

        const governor = createBudgetGovernor({
          totalSeconds,
          shares: config.budget.shares,
          db: database,
          runId: run.id,
          decide: options.yes
            ? createNonInteractiveDecider('policy:--yes')
            : createInteractiveDecider(),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        // §4.2 lookup 3: OSV has no path or symbol query, so the only refresh the
        // API supports is the commit lookup. A failure here is surfaced by
        // `runPipeline`, which falls back to the recorded set.
        const refreshKnownVulns =
          options.refresh === false
            ? undefined
            : async (): Promise<KnownVulnRecord[]> => {
                const vulns = await new OsvClient().queryCommit(run.commitSha)
                return vulns.map((vuln) => ({
                  vulnId: vuln.id,
                  aliases: vuln.aliases ?? [],
                  summary: vuln.summary ?? null,
                  details: vuln.details ?? null,
                }))
              }

        const result = await runPipeline({
          db: database,
          runId: run.id,
          targetId: target.targetId,
          candidates,
          invoker,
          programContext,
          governor,
          cacheDisabled: options.cache === false,
          enrich: options.enrich !== false,
          refreshKnownVulns,
          log: options.json ? () => {} : (line) => console.log(line),
        })

        const failed = result.triage.failed + result.verification.failed
        const status =
          result.stoppedBy === 'budget-abort'
            ? 'aborted'
            : result.stoppedBy === 'budget-degrade' || failed > 0
              ? 'partial'
              : 'complete'

        // §18, classified from the same warnings the summary prints. A stage with a
        // refused account fails once per candidate, so the count above says `partial` and
        // the reason is not in the count — it is in the hundred identical warnings, which
        // is where it stays: each of them is a candidate left unchecked.
        const providerFailure = findProviderFailure(result.warnings)

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                runId: run.id,
                targetId: target.targetId,
                commit: run.commitSha,
                status,
                rediscovery: result.rediscovery,
                triage: result.triage,
                verification: result.verification,
                summary: result.summary,
                budgetEvents: governor.events(),
                providerFailure,
                warnings: result.warnings,
              },
              null,
              2,
            ),
          )
          return
        }

        console.log(`\nrun id:       ${run.id}`)
        console.log(`target id:    ${target.targetId}`)
        console.log(`commit:       ${run.commitSha}`)
        console.log(
          `budget:       ${formatSeconds(totalSeconds)} total, ` +
            `triage ${formatSeconds(governor.quotaSeconds('triage'))}, ` +
            `verification ${formatSeconds(governor.quotaSeconds('verification'))}`,
        )
        console.log(`status:       ${status}`)

        if (providerFailure) {
          console.log(`\nBLOCKED: ${describeProviderFailure(providerFailure)}`)
        }

        if (result.rediscovery > 0) {
          console.log(
            `\nrediscovery:  ${result.rediscovery} candidate(s) matched a known record and were routed to reporting, not verified`,
          )
        }

        console.log('\ntriage:')
        console.log(`  checked:      ${result.triage.processed}`)
        console.log(`  likely-real:  ${result.triage.byLabel['likely-real']}`)
        console.log(`  likely-noise: ${result.triage.byLabel['likely-noise']}`)
        console.log(
          `  needs-ctx:    ${result.triage.byLabel['needs-context']} (${result.triage.enriched} enriched)`,
        )
        if (result.triage.cached > 0) {
          console.log(`  cache hits:   ${result.triage.cached}`)
        }

        console.log('\nverification:')
        console.log(`  verified:     ${result.verification.verified}`)
        console.log(`  likely-real:  ${result.verification.byDisposition['likely-real']}`)
        console.log(`  dropped:      ${result.verification.byDisposition.dropped}`)
        console.log(
          `  escalated:    ${result.verification.byDisposition.escalated} (awaiting ` +
            '`windbreak review`)',
        )

        console.log('\ncandidates by state:')
        for (const row of result.summary.byState) {
          console.log(`  ${row.state.padEnd(12)} ${row.count}`)
        }

        const escaped =
          result.triage.escapedLines + result.verification.escapedLines
        if (escaped > 0) {
          console.log(
            `\nnote: ${escaped} instruction-like line(s) from the target were neutralized ` +
              'before reaching a model (spec §5.1).',
          )
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        if (status === 'complete') {
          console.log('\nOK: candidate pipeline complete.')
        } else {
          console.log(`\nWARN: candidate pipeline ${status}.`)
        }
      } finally {
        // The sessions live exactly as long as the model stages do: a Freebuff
        // session is a slot the account owns, and holding it past the run would
        // lock out the operator's own chat until it expired (§20.41).
        await closeSessions?.()
        database.close()
      }
    })
}
