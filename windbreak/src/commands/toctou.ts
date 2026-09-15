import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
  formatSeconds,
} from '../budget'
import { loadEffectiveConfig } from '../config'
import { createRun, finishRun, readCandidateSummary } from '../engines'
import { DEFAULT_MAX_COMMITS } from '../patchmine'
import { DEFAULT_MAX_SITES_PER_PRODUCER, SIGNAL_SHAPES, TOCTOU_FSMS, runToctou } from '../toctou'
import { openStateDatabase } from '../state/db'
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
import type { ToctouFsm } from '../toctou'

interface ToctouCommandOptions {
  target?: string
  commit?: string
  db?: string
  config?: string
  backend?: string
  budgetSeconds?: string
  maxCommits?: string
  'maxSites'?: string
  fsm?: string
  'fixSubjectsOnly'?: boolean
  signal?: boolean
  interproc?: boolean
  yes?: boolean
  json?: boolean
}

/** Parse `--fsm a,b` against the closed union, so a typo is rejected. */
const parseFsms = (value: string | undefined): ToctouFsm[] | string | undefined => {
  if (value === undefined) return undefined

  const requested = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (requested.length === 0) return undefined

  const unknown = requested.filter(
    (entry) => !(TOCTOU_FSMS as readonly string[]).includes(entry),
  )
  if (unknown.length > 0) {
    return (
      `Unknown FSM(s): ${unknown.join(', ')}. ` +
      `Known: ${TOCTOU_FSMS.join(', ')}`
    )
  }

  return requested as ToctouFsm[]
}

/**
 * Interim command.
 *
 * Spec §7.3 folds §4.4.3 into `scan`'s static core; this exposes it directly so the
 * stage is runnable and observable on its own, the same way `recon`, `engines`, and
 * `patch-mine` are (§20.7.4). Two parts of the output are the reason it exists: the
 * mined rule table, which is the only place that shows *why* a pairing was admitted,
 * and the per-producer site counts, which distinguish "the FSM found nothing" from
 * "the FSM's cap truncated the sweep".
 */
export const registerToctouCommand = (program: Command): void => {
  program
    .command('toctou')
    .description(
      'Mine atomicity rules and validate check-to-use (four FSMs) and signal-handler ' +
        '(CWE-364, four shapes) patterns (spec §4.4.3)',
    )
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--config <path>', 'config file with budget settings')
    .option('--backend <name>', 'require a specific sandbox backend')
    .option('--budget-seconds <n>', 'override the total target budget')
    .option('--max-commits <n>', `commits to walk; default ${DEFAULT_MAX_COMMITS}`)
    .option(
      '--max-sites <n>',
      'cap sites per producer (per FSM, per rule, and per signal shape)',
      String(DEFAULT_MAX_SITES_PER_PRODUCER),
    )
    .option(
      '--fsm <names>',
      `comma-separated subset of ${TOCTOU_FSMS.join(', ')}; default all four`,
    )
    .option(
      '--fix-subjects-only',
      'only mine commits whose subject reads like a fix (off: added locking is the filter)',
    )
    .option(
      '--no-signal',
      `skip the CWE-364 producer (${SIGNAL_SHAPES.join(', ')}); it reads every ` +
        'indexed function, which is the most expensive thing this stage does',
    )
    .option(
      '--no-interproc',
      'skip caller-lock annotation and the cross-function check-to-use producer; ' +
        'it reads every indexed function again to summarize parameters and lock holdings',
    )
    .option('--yes', 'non-interactive: budget overruns degrade rather than prompt')
    .option('--json', 'emit machine-readable output')
    .action(async (options: ToctouCommandOptions) => {
      const targetPath = requireTargetOption(options.target)
      if (targetPath === null) return

      const loaded = loadEffectiveConfig(options.config)
      const { config } = loaded

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
      const preferredBackend = parseBackendName(options.backend)

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

        const fsms = parseFsms(options.fsm)
        if (typeof fsms === 'string') {
          console.error(fsms)
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
          : DEFAULT_MAX_SITES_PER_PRODUCER
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
            toctou: {
              maxCommits,
              maxSites,
              fsms: fsms ?? [...TOCTOU_FSMS],
              signalHandlers: options.signal !== false,
              interprocedural: options.interproc !== false,
              fixSubjectsOnly: options['fixSubjectsOnly'] === true,
            },
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

        const result = await runToctou({
          targetRoot: target.targetRoot,
          targetId: target.targetId,
          runId,
          db: database,
          governor,
          maxCommits,
          maxSitesPerProducer: maxSites,
          signalHandlers: options.signal !== false,
          interprocedural: options.interproc !== false,
          fixSubjectsOnly: options['fixSubjectsOnly'] === true,
          ...(fsms ? { fsms } : {}),
          ...(preferredBackend ? { preferredBackend } : {}),
          log,
        })

        // "Nothing was mined" and "mining did not run" are different statements, so
        // the status distinguishes them: a history that could not be read is partial,
        // whereas a history with no lock-adding hunk is a complete result.
        const status =
          result.stoppedBy === 'budget-abort'
            ? 'aborted'
            : result.stoppedBy === 'budget-degrade'
              ? 'degraded'
              : result.coverage.commitsRead === 0
                ? 'partial'
                : 'complete'

        finishRun(database, runId, status)

        const fsmSites = result.sites.filter((site) => site.kind === 'fsm')
        const atomicitySites = result.sites.filter((site) => site.kind === 'atomicity')
        const interprocSites = result.sites.filter((site) => site.kind === 'interproc')
        const signalSites = result.sites.filter((site) => site.kind === 'signal')

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                runId,
                targetId: target.targetId,
                commitSha: target.commitSha,
                status,
                rules: result.rules,
                coverage: result.coverage,
                fixesConsidered: result.fixesConsidered,
                outcomes: result.outcomes,
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
            `${result.coverage.hunksAddingLock} hunk(s) added locking`,
        )

        if (result.rules.length > 0) {
          console.log('\natomicity rules (§4.4.3 — mined from lock-adding hunks):')
          for (const rule of result.rules) {
            console.log(
              `  ${rule.id}  ${rule.resource.padEnd(20)} requires ${rule.lock.padEnd(14)} ` +
                `${String(rule.occurrences) + 'x'}  ${rule.originFile}`,
            )
          }
        } else {
          console.log('\natomicity rules: none mined')
        }

        console.log(
          `\nsweep:        ${result.coverage.functionsSwept} function(s), ` +
            `${result.coverage.functionsWithEvents} with events`,
        )
        // Printed even at zero: "no signal handlers found" and "the signal producer
        // did not run" are different statements, and only the second one means the
        // result is partial.
        console.log(
          `signal:       ${result.coverage.signalHandlers} handler(s), ` +
            `${result.coverage.sharedKeys} shared object(s)` +
            (options.signal === false ? '  (producer disabled)' : ''),
        )
        // The graph's own denominator, printed even when the pass is off. An empty
        // cross-function result and an empty call graph produce the same site count,
        // and this is the line that tells them apart.
        console.log(
          `interproc:    ${result.coverage.callEdges} call edge(s) over ` +
            `${result.coverage.callSitesSeen} call site(s) ` +
            `(${result.coverage.callSitesUnattributed} unattributed, ` +
            `${result.coverage.callSitesAmbiguous} ambiguous); ` +
            `${result.coverage.callerGuardedSites} caller-guarded site(s)` +
            (options.interproc === false ? '  (pass disabled)' : ''),
        )
        for (const outcome of result.outcomes) {
          console.log(
            `  ${outcome.producer.padEnd(30)} ${String(outcome.sites).padStart(4)} site(s)` +
              `${outcome.capped ? '  (capped — sweep is partial)' : ''}`,
          )
        }

        if (fsmSites.length > 0) {
          console.log('\ncheck-to-use sites:')
          for (const site of fsmSites) {
            console.log(
              `  ${site.filePath}:${site.matchLine}  ${site.functionName}  ` +
                `[${site.fsm}] ${site.evidence}`,
            )
          }
        }

        if (atomicitySites.length > 0) {
          console.log('\natomicity violations:')
          for (const site of atomicitySites) {
            console.log(
              `  ${site.filePath}:${site.matchLine}  ${site.functionName}  ${site.evidence}`,
            )
          }
        }

        if (interprocSites.length > 0) {
          console.log('\ncheck-to-use sites across a call:')
          for (const site of interprocSites) {
            console.log(
              `  ${site.filePath}:${site.matchLine}  ${site.functionName}  ${site.evidence}`,
            )
          }
        }

        if (signalSites.length > 0) {
          console.log('\nsignal-handler races (CWE-364):')
          for (const site of signalSites) {
            console.log(
              `  ${site.filePath}:${site.matchLine}  ${site.functionName}  ` +
                `[${site.shape}] ${site.evidence}`,
            )
          }
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
          console.log('\nOK: check-to-use discovery complete.')
        } else {
          console.log(`\nWARN: check-to-use discovery ${status} — results are incomplete.`)
        }
      } finally {
        database.close()
      }
    })
}
