import path from 'path'
import readline from 'readline'

import {
  readAdjudicationQueue,
  recordAdjudicationDecision,
} from '../pipeline'
import { openStateDatabase } from '../state/db'

import type { Command } from 'commander'
import type { AdjudicationDecision, QueueEntry } from '../pipeline'

const DEFAULT_DB_PATH = path.resolve('.windbreak', 'state.db')

interface ReviewCommandOptions {
  db?: string
  run?: string
  all?: boolean
  decide?: string
  as?: string
  rationale?: string
  json?: boolean
}

const describeEntry = (entry: QueueEntry): string => {
  const lines = [
    `candidate:  ${entry.candidateId}`,
    `location:   ${entry.filePath ?? '(unknown)'}:${entry.startLine ?? '?'}`,
    `detected:   ${entry.source}${entry.patternId ? ` / ${entry.patternId}` : ''}`,
    `class:      ${entry.cwe ?? '(unclassified)'}`,
  ]
  return lines.join('\n')
}

/**
 * §5.3's human tiebreak.
 *
 * A disagreement between two providers is not resolved by a third model: the
 * researcher decides, and the decision is recorded with its rationale. Nothing
 * here auto-resolves a queue entry — a non-interactive invocation lists the
 * queue instead, because silently deciding on the researcher's behalf would
 * either manufacture findings or discard them, and both are wrong.
 */
export const registerReviewCommand = (program: Command): void => {
  program
    .command('review')
    .description('Work the human adjudication queue (spec §5.3)')
    .option('--db <path>', 'state database path', DEFAULT_DB_PATH)
    .option('--run <id>', 'only entries from this run')
    .option('--all', 'include already-resolved entries')
    .option('--decide <candidateId>', 'resolve one entry non-interactively')
    .option('--as <disposition>', 'with --decide: "real" or "benign"')
    .option('--rationale <text>', 'with --decide: why')
    .option('--json', 'emit machine-readable output')
    .action(async (options: ReviewCommandOptions) => {
      const databasePath = options.db ?? DEFAULT_DB_PATH
      const database = openStateDatabase(databasePath)

      try {
        const entries = readAdjudicationQueue(database, options.run)

        if (options.decide) {
          const decision = options.as
          if (decision !== 'real' && decision !== 'benign') {
            console.error('--decide requires --as real|benign')
            process.exitCode = 1
            return
          }
          if (!entries.some((entry) => entry.candidateId === options.decide)) {
            console.error(`No adjudication entry for ${options.decide}.`)
            process.exitCode = 1
            return
          }

          recordAdjudicationDecision({
            db: database,
            candidateId: options.decide,
            decision,
            rationale: options.rationale ?? null,
          })
          console.log(
            `recorded ${options.decide} as ${decision}` +
              `${options.rationale ? ` (${options.rationale})` : ''}`,
          )
          return
        }

        const pending = options.all
          ? entries
          : entries.filter((entry) => entry.decision === null)

        if (options.json) {
          console.log(JSON.stringify(pending, null, 2))
          return
        }

        if (pending.length === 0) {
          console.log(
            entries.length === 0
              ? 'No disagreements in the adjudication queue.'
              : 'No pending disagreements; use --all to see resolved entries.',
          )
          return
        }

        if (!process.stdin.isTTY) {
          console.log(
            `${pending.length} pending disagreement(s). This command needs a terminal to` +
              ' ask you; either run it interactively or resolve one with' +
              ' `--decide <candidateId> --as real|benign`.',
          )
          for (const entry of pending) {
            console.log(`\n${describeEntry(entry)}`)
          }
          return
        }

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        try {
          for (const entry of pending) {
            if (entry.decision !== null) continue

            console.log(`\n${'-'.repeat(72)}\n${describeEntry(entry)}`)
            console.log(
              `\nproposer (${entry.proposerVerdictId}):\n  ${
                entry.proposerReasoning ?? '(no reasoning recorded)'
              }`,
            )
            console.log(
              `\nrefuter (${entry.refuterVerdictId}):\n  ${
                entry.refuterReasoning ?? '(no reasoning recorded)'
              }`,
            )

            const answer = await new Promise<string>((resolve) => {
              rl.question(
                '\n[r]eal, [b]enign, [s]kip, [q]uit? ',
                resolve,
              )
            })
            const choice = answer.trim().toLowerCase()

            if (choice === 'q' || choice === 'quit') break
            if (choice === 's' || choice === 'skip' || choice === '') continue
            if (choice !== 'r' && choice !== 'b' && choice !== 'real' && choice !== 'benign') {
              console.log('unrecognized choice; skipping')
              continue
            }

            const rationale = await new Promise<string>((resolve) => {
              rl.question('rationale (optional): ', resolve)
            })

            const decision: AdjudicationDecision =
              choice === 'r' || choice === 'real' ? 'real' : 'benign'

            recordAdjudicationDecision({
              db: database,
              candidateId: entry.candidateId,
              decision,
              rationale: rationale.trim().length > 0 ? rationale.trim() : null,
            })
            console.log(`recorded: ${decision}`)
          }
        } finally {
          rl.close()
        }
      } finally {
        database.close()
      }
    })
}
