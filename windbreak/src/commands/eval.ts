import fs from 'fs'
import os from 'os'
import path from 'path'

import { MissingCredentialsError, SdkEnvironmentError, createWindbreakClient } from '../client'
import {
  createSemgrepBatchRunner,
  DEFAULT_MIN_RECALL,
  loadEvalInput,
  renderRuleTierReport,
  runEval,
  runRuleTier,
  runTier1,
  UnknownRunError,
} from '../eval'
import { renderEvalReport } from '../eval/report-text'
import { renderTier1Report } from '../eval/tier1-text'
import { resolveRulePaths } from '../engines/rules'
import { createSdkModelInvoker } from '../pipeline'
import { openStateDatabase } from '../state/db'
import { DB_OPTION_DESCRIPTION, defaultDbPath, effectiveConfig } from './defaults'

import type { Command } from 'commander'
import type { EvalInput, PairSet } from '../eval'

interface EvalCommandOptions {
  db?: string
  run?: string
  minRecall?: string
  rules?: boolean
  json?: boolean
}

/**
 * Score a corpus (spec §11, D11, D22).
 *
 * One command, two measurements, and the input file says which it is (§11's
 * `kind` discriminator). They differ in more than their metrics:
 *
 * - **Tier 2 reads; Tier 1 spends.** A fixture list is scored against runs that
 *   already exist, so it is free and offline. A function-level corpus is scored
 *   by driving §4.6 and §5 over it, so it needs a provider — and its cost is one
 *   triage call per half plus two verification calls, which is why the pair
 *   count is printed before anything is asked.
 * - **Tier 2 gates on D11's recall bar. Tier 1 does not gate on anything.** The
 *   bar in D11 is repo-level recall, and §11.1 explicitly forbids reading a
 *   function-level number as repo-scale evidence. So `--min-recall` is refused
 *   for a corpus rather than quietly applied to the wrong denominator.
 *
 * What both tiers share is the exit rule: `0` only for a measurement that
 * happened. A run that could not be scored exits 1, because a pipeline that was
 * never measured must not report success.
 */
export const registerEvalCommand = (program: Command): void => {
  program
    .command('eval')
    .description('Score a corpus: repo-snapshot fixtures (§11.2) or function pairs (§11.1)')
    .argument('<corpus>', 'path to a fixture list or a pair set (JSON)')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--run <id>', 'score only this run (fixture lists only)')
    .option(
      '--min-recall <n>',
      `recall gate in [0, 1] for fixture lists (default ${DEFAULT_MIN_RECALL}, from D11)`,
    )
    .option('--no-cache', 'ignore the verdict cache (pair sets only)')
    .option(
      '--rules',
      'score the committed rule set over a pair set instead of the model stages ' +
        '(no provider, no database)',
    )
    .option('--json', 'emit machine-readable output')
    .action(async (corpusPath: string, options: EvalCommandOptions & { cache?: boolean }) => {
      let input: EvalInput
      try {
        input = loadEvalInput(corpusPath)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return
      }

      // The rule tier reads a corpus and runs an engine. It needs neither the
      // state database nor a provider, so it is handled before either is
      // required — refusing it for a missing database would be a gate on a
      // dependency it does not have.
      if (options.rules === true) {
        if (input.kind !== 'function-pairs') {
          console.error(
            '--rules scores a function-level corpus (§11.1); this file is a repo-snapshot ' +
              'fixture list (§11.2), whose sites are scored against recorded runs rather ' +
              'than function text.',
          )
          process.exitCode = 1
          return
        }
        await runRuleTierCommand({ options, pairSet: input.pairSet })
        return
      }

      const databasePath = options.db ?? defaultDbPath()
      const resolved = path.resolve(databasePath)

      if (resolved !== ':memory:' && !fs.existsSync(resolved)) {
        console.error(
          `no state database at ${resolved}. \`eval\` scores runs that are already ` +
            'recorded; point --db at the database a scan wrote.',
        )
        process.exitCode = 1
        return
      }

      const database = openStateDatabase(databasePath)
      try {
        if (input.kind === 'repo-snapshots') {
          await runFixtureTier({ database, options, fixtureSet: input.fixtureSet })
          return
        }

        await runPairTier({ database, options, pairSet: input.pairSet })
      } finally {
        database.close()
      }
    })
}

/**
 * Score the committed rule set over a corpus (§11.1's third instrument).
 *
 * Free and providerless, so it says so rather than failing when no credentials
 * are present — the tier's whole point is that the detection net can be measured
 * without spending anything. Flags belonging to the other tiers are refused
 * rather than ignored: `--run` selects a recorded run and this tier records
 * nothing, so accepting it would let a script believe it had scored a run.
 */
const runRuleTierCommand = async (input: {
  options: EvalCommandOptions
  pairSet: PairSet
}): Promise<void> => {
  const { options, pairSet } = input

  if (options.run !== undefined) {
    console.error(
      '--run selects a recorded run, which the rule tier does not use: it scores the ' +
        'corpus directly and records nothing.',
    )
    process.exitCode = 1
    return
  }

  if (options.minRecall !== undefined) {
    console.error(
      '--min-recall is a repo-level bar (D11) and does not apply to a function-level ' +
        'corpus. §11.1 forbids reading this tier as repo-scale evidence, so there is no ' +
        'threshold here to fail.',
    )
    process.exitCode = 1
    return
  }

  const loaded = effectiveConfig()
  if (loaded.violations.length > 0) {
    console.error('Configuration is invalid; refusing to run:')
    for (const violation of loaded.violations) {
      console.error(`  [${violation.role}] ${violation.message}`)
    }
    process.exitCode = 1
    return
  }

  let rulePaths: string[]
  try {
    rulePaths = resolveRulePaths(loaded.config.engines.rulePaths)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-rules-'))
  try {
    const quiet = options.json ? () => {} : (line: string) => console.log(line)

    const report = await runRuleTier({
      pairSet,
      runBatch: createSemgrepBatchRunner({ rulePaths, scratchDir, log: quiet }),
      log: quiet,
    })

    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log('')
      console.log(renderRuleTierReport(report))
    }

    // No gate, but a measurement that did not happen is not a success.
    if (report.metrics.status === 'not-run') process.exitCode = 1
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true })
  }
}

const runFixtureTier = async (input: {
  database: ReturnType<typeof openStateDatabase>
  options: EvalCommandOptions
  fixtureSet: Parameters<typeof runEval>[0]['fixtureSet']
}): Promise<void> => {
  const { options, fixtureSet, database } = input

  const minRecall =
    options.minRecall === undefined ? DEFAULT_MIN_RECALL : Number.parseFloat(options.minRecall)
  if (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1) {
    console.error(`Invalid --min-recall: ${options.minRecall} (expected a number in [0, 1])`)
    process.exitCode = 1
    return
  }

  let report
  try {
    report = runEval({
      db: database,
      fixtureSet,
      minRecall,
      ...(options.run ? { runId: options.run } : {}),
    })
  } catch (error) {
    if (error instanceof UnknownRunError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderEvalReport(report))
  }

  if (report.gate !== 'pass') process.exitCode = 1
}

const runPairTier = async (input: {
  database: ReturnType<typeof openStateDatabase>
  options: EvalCommandOptions & { cache?: boolean }
  pairSet: Parameters<typeof runTier1>[0]['pairSet']
}): Promise<void> => {
  const { options, pairSet, database } = input

  // Refused rather than ignored: D11's bar is repo-level recall, and applying it
  // to a function-level denominator would gate on a number the spec says cannot
  // carry that claim.
  if (options.minRecall !== undefined) {
    console.error(
      '--min-recall is a repo-level bar (D11) and does not apply to a function-level ' +
        'corpus. §11.1 forbids reading this tier as repo-scale evidence, so there is no ' +
        'threshold here to fail.',
    )
    process.exitCode = 1
    return
  }

  if (options.run !== undefined) {
    console.error(
      '--run selects a recorded run, which a pair set does not use: it creates its own ' +
        'run and drives §4.6 and §5 over the corpus.',
    )
    process.exitCode = 1
    return
  }

  const loaded = effectiveConfig()
  if (loaded.violations.length > 0) {
    console.error('Configuration is invalid; refusing to run:')
    for (const violation of loaded.violations) {
      console.error(`  [${violation.role}] ${violation.message}`)
    }
    process.exitCode = 1
    return
  }

  let invoker
  let closeSessions: (() => Promise<void>) | undefined
  try {
    const windbreak = await createWindbreakClient()
    closeSessions = windbreak.close
    invoker = createSdkModelInvoker({
      client: windbreak.client,
      sessions: windbreak.sessions,
      models: loaded.config.models,
      log: options.json ? () => {} : (line) => console.log(line),
    })
  } catch (error) {
    if (error instanceof MissingCredentialsError || error instanceof SdkEnvironmentError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }

  const halves = pairSet.pairs.length * 2
  if (!options.json) {
    console.log(
      `\nScoring ${pairSet.pairs.length} pair(s) — ${halves} function(s) to judge, ` +
        'one triage call each and two verification calls each (§11.1).',
    )
  }

  try {
    const report = await runTier1({
      db: database,
      pairSet,
      invoker,
      cacheDisabled: options.cache === false,
      log: options.json ? () => {} : (line) => console.log(line),
    })

    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log('')
      console.log(renderTier1Report(report))
    }

    // No gate, but a measurement that produced nothing is not a success.
    if (report.stages.every((stage) => stage.status === 'not-run')) {
      process.exitCode = 1
    }
  } finally {
    // A session is a slot the account owns, so it is released with the measurement
    // rather than left to expire (§20.41).
    await closeSessions?.()
  }
}
