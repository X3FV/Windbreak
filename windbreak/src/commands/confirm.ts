import path from 'path'

import {
  DEFAULT_FUZZ_SECONDS,
  DEFAULT_FUZZ_SEED,
  confirmFinding,
  decidabilityOf,
  resolveConfirmBackend,
} from '../confirm'
import { persistConfirmation, readConfirmedCandidateIds } from '../confirm/persist'
import { createProgramContext } from '../pipeline'
import { latestRunForTarget } from '../pipeline/persist'
import { deriveFindings } from '../report/findings'
import { collectReportableInputs } from '../report/persist'
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
import type { ConfirmationResult } from '../confirm'

const DEFAULT_SCRATCH = path.resolve('.windbreak', 'scratch')

interface ConfirmCommandOptions {
  target?: string
  run?: string
  db?: string
  candidate?: string[]
  scratch?: string
  seconds?: string
  seed?: string
  backend?: string
  all?: boolean
  json?: boolean
}

/**
 * Automated dynamic confirmation (§20.35, build order step 11).
 *
 * Takes the findings that survived verification and *runs* them: a fuzz target is
 * generated per finding, built and fuzzed inside the sandbox, and the result is
 * recorded. This is the stage D21 deferred — D21 replaced dynamic confirmation
 * with a harness a human runs by hand, and §20.35 narrows that decision rather
 * than reversing it, because what lands here is bounded, sandboxed, and only ever
 * *adds* evidence.
 *
 * Three things it will not do, each on purpose:
 *
 * - **Run anything outside a sandbox.** No backend means it stops, per §6. There
 *   is no fallback that runs target code unsandboxed.
 * - **Confirm a class one run cannot decide.** Races and output-shaped defects are
 *   refused with the reason, because a single run that finds nothing is not
 *   evidence either way (§4.7).
 * - **Lower a tier.** A run that reproduces nothing leaves the finding exactly as
 *   it was. Silence is silence.
 */
export const registerConfirmCommand = (program: Command): void => {
  program
    .command('confirm')
    .description(
      'Reproduce surviving findings by fuzzing them inside the sandbox, and record what manifested (§20.35)',
    )
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--run <id>', "run to take findings from; defaults to the target's latest run")
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--candidate <id...>', 'confirm only these candidates')
    .option(
      '--scratch <path>',
      'per-run scratch directory for the sandboxed build and fuzz run',
      DEFAULT_SCRATCH,
    )
    .option('--seconds <n>', `fuzzing budget per finding, in seconds (default ${DEFAULT_FUZZ_SECONDS})`)
    .option('--seed <n>', `fuzzer seed (default ${DEFAULT_FUZZ_SEED})`)
    .option('--backend <name>', 'sandbox backend to use (nsjail|bwrap)')
    .option(
      '--all',
      're-attempt findings that already carry a recorded confirmation',
    )
    .option('--json', 'emit machine-readable output')
    .action(async (options: ConfirmCommandOptions) => {
      const databasePath = options.db ?? defaultDbPath()
      const database = openStateDatabase(databasePath)

      const targetPath = requireTargetOption(options.target)
      if (targetPath === null) return

      const target = resolveCommandTarget({ target: targetPath, db: database })

      if (!target.exists) {
        console.error(describeMissingTarget(target, databasePath))
        process.exitCode = 1
        return
      }

      const run = options.run
        ? { id: options.run }
        : (() => {
            const latest = latestRunForTarget(database, target.targetId)
            return latest ? { id: latest.id } : null
          })()

      if (!run) {
        console.error(
          'No run to confirm findings from. Scan the target first, or pass --run <id>.',
        )
        process.exitCode = 1
        return
      }

      // Fail closed before anything runs: §6 permits no unsandboxed execution of
      // target code, so the absence of a backend stops the stage rather than
      // degrading it.
      const backend = resolveConfirmBackend({
        ...(options.backend ? { preferred: parseBackendName(options.backend) } : {}),
      })
      if (!backend.ok) {
        console.error(
          `No sandbox backend is available, so nothing can be confirmed: ${backend.reason}\n` +
            'Install nsjail or bubblewrap. WindBreak does not run target code outside a sandbox.',
        )
        process.exitCode = 1
        return
      }

      const fuzzSeconds = options.seconds
        ? Number.parseInt(options.seconds, 10)
        : DEFAULT_FUZZ_SECONDS
      if (!Number.isFinite(fuzzSeconds) || fuzzSeconds <= 0) {
        console.error('--seconds must be a positive number.')
        process.exitCode = 1
        return
      }
      const seed = options.seed ? Number.parseInt(options.seed, 10) : DEFAULT_FUZZ_SEED

      const programContext = createProgramContext(database, target.targetId)
      const inputs = collectReportableInputs({
        db: database,
        runId: run.id,
        programContext,
      })

      // Findings that already have a recorded confirmation are left alone unless
      // `--all` asks for them again: re-fuzzing a finding whose answer is on disk
      // spends the whole budget to learn what the record already says.
      const alreadyConfirmed = readConfirmedCandidateIds(database, run.id)
      const { findings } = deriveFindings({
        candidates: inputs,
        ...(alreadyConfirmed.length > 0 ? { dynamicallyConfirmed: alreadyConfirmed } : {}),
      })

      const requested = options.candidate ? new Set(options.candidate) : null
      const byCandidate = new Map(inputs.map((entry) => [entry.candidate.id, entry]))

      const candidatesToAttempt = findings.filter((finding) => {
        if (requested && !requested.has(finding.candidateId)) return false
        if (options.all) return true
        // Anything whose tier already moved is done; `contested` findings are
        // deliberately not attempted — a dispute is the human's to settle (§5.3).
        return finding.evidenceTier === 'statically-verified'
      })

      const results: ConfirmationResult[] = []
      const skipped: Array<{ candidateId: string; reason: string }> = []

      for (const finding of candidatesToAttempt) {
        const input = byCandidate.get(finding.candidateId)
        if (!input) continue

        // Refusals are decided and recorded here rather than silently omitted, so
        // the run can say how much of the queue this stage could not touch and why.
        const verdict = decidabilityOf(input.candidate.cwe)
        const name = verdict.decidable ? null : verdict.reason

        const result = await confirmFinding({
          finding: {
            candidateId: finding.candidateId,
            filePath: input.candidate.filePath,
            startLine: input.candidate.startLine,
            endLine: input.candidate.endLine,
            functionName: input.enclosingFunction,
            language: input.language,
            cwe: input.candidate.cwe,
          },
          checkoutDir: target.targetRoot,
          scratchDir: options.scratch ?? DEFAULT_SCRATCH,
          fuzzSeconds,
          seed,
          ...(backend.name ? { preferredBackend: backend.name } : {}),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        persistConfirmation({ db: database, runId: run.id, result })
        results.push(result)
        if (name) skipped.push({ candidateId: finding.candidateId, reason: name })
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              runId: run.id,
              target: target.targetRoot,
              backend: backend.name,
              fuzzSeconds,
              seed,
              attempted: results.length,
              results,
              notAttempted: skipped,
            },
            null,
            2,
          ),
        )
        return
      }

      if (results.length === 0) {
        console.log(
          `Nothing to confirm on run ${run.id}: no finding is both eligible and unconfirmed.` +
            (options.candidate ? ' Check the --candidate ids.' : ' Pass --all to re-attempt the rest.'),
        )
        return
      }

      console.log(`\nconfirming ${results.length} finding(s) on run ${run.id} (${backend.name})\n`)
      for (const result of results) {
        console.log(`  ${result.outcome.padEnd(15)} ${result.candidateId}`)
        console.log(`                  ${result.detail.split('\n')[0]}`)
      }

      const confirmed = results.filter((result) => result.outcome === 'confirmed').length
      const counts = new Map<string, number>()
      for (const result of results) {
        counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1)
      }

      console.log('')
      for (const [outcome, count] of [...counts].sort()) {
        console.log(`  ${outcome}: ${count}`)
      }
      console.log(
        `\n${confirmed} of ${results.length} reproduced. Findings that were not reproduced keep ` +
          'their tier: a bounded run is silence, not disproof.\n' +
          'Run `windbreak report` to write the tiers into the artifacts.',
      )
    })
}
