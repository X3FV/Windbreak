import path from 'path'

import { createProgramContext } from '../pipeline'
import { latestRunForTarget } from '../pipeline/persist'
import {
  DISCLOSURE_STATUSES,
  readLedger,
  runReport,
  updateLedgerStatus,
} from '../report'
import { openStateDatabase } from '../state/db'
import { VERSION } from '../version'
import { DB_OPTION_DESCRIPTION, defaultDbPath, defaultTargetPath } from './defaults'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Database } from 'bun:sqlite'
import type { Command } from 'commander'
import type { DisclosureStatus } from '../report'

interface ReportCommandOptions {
  target?: string
  run?: string
  db?: string
  out?: string
  reproduced?: string[]
  ledger?: boolean
  setStatus?: string
  finding?: string
  channel?: string
  note?: string
  json?: boolean
}

const isDisclosureStatus = (value: string): value is DisclosureStatus =>
  (DISCLOSURE_STATUSES as readonly string[]).includes(value)

/**
 * Reporting (§13, build order step 8).
 *
 * Renders recorded state into SARIF, a writeup per finding, and a manual harness
 * per finding. Two things this command deliberately does not do: it never makes
 * a model call (reporting is a rendering stage), and it never builds or runs the
 * harnesses it generates (D21).
 */
export const registerReportCommand = (program: Command): void => {
  program
    .command('report')
    .description('Write SARIF, tiered writeups, and manual harnesses from recorded state')
    .option(
      '--target <path>',
      "target checkout; defaults to the configured target, then to the run's recorded location",
      defaultTargetPath(),
    )
    .option('--run <id>', 'run to report on; defaults to the target\'s latest run')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--out <dir>', 'output directory (default: .windbreak/reports/<runId>)')
    .option(
      '--reproduced <candidateId...>',
      'candidate ids you reproduced outside WindBreak; sets the human-reproduced tier',
    )
    .option('--ledger', 'print the disclosure ledger instead of writing a report')
    .option('--set-status <status>', `update a ledger entry (${DISCLOSURE_STATUSES.join('|')})`)
    .option('--finding <findingId>', 'with --set-status: the finding to update')
    .option('--channel <name>', 'with --set-status: how it was disclosed')
    .option('--note <text>', 'with --set-status: a note')
    .option('--json', 'emit machine-readable output')
    .action(async (options: ReportCommandOptions) => {
      const databasePath = options.db ?? defaultDbPath()
      const database = openStateDatabase(databasePath)

      try {
        // The ledger is target-independent bookkeeping, so it is reachable
        // without a run (§12.5).
        if (options.ledger) {
          const rows = readLedger(database)
          if (options.json) {
            console.log(JSON.stringify(rows, null, 2))
            return
          }
          if (rows.length === 0) {
            console.log('The disclosure ledger is empty.')
            return
          }
          console.log('finding id                       status         channel        updated')
          for (const row of rows) {
            console.log(
              `${row.findingId.padEnd(32)} ${row.status.padEnd(14)} ` +
                `${(row.channel ?? '-').padEnd(14)} ${row.updatedAt}`,
            )
          }
          return
        }

        if (options.setStatus) {
          if (!isDisclosureStatus(options.setStatus)) {
            console.error(
              `Unknown status "${options.setStatus}". Expected one of: ${DISCLOSURE_STATUSES.join(', ')}.`,
            )
            process.exitCode = 1
            return
          }
          if (!options.finding) {
            console.error('--set-status requires --finding <findingId>')
            process.exitCode = 1
            return
          }

          const updated = updateLedgerStatus({
            db: database,
            findingId: options.finding,
            status: options.setStatus,
            channel: options.channel ?? null,
            notes: options.note ?? null,
          })
          if (!updated) {
            console.error(
              `No ledger entry for ${options.finding}. Run \`windbreak report\` first so the finding is drafted.`,
            )
            process.exitCode = 1
            return
          }
          console.log(`${options.finding} -> ${options.setStatus}`)
          return
        }

        // --- reporting proper ---
        let runId = options.run

        if (!runId) {
          if (!options.target) {
            console.error(
              'Nothing to report on. Pass --run <id>, or --target <path> with a run already recorded.',
            )
            process.exitCode = 1
            return
          }

          const target = resolveCommandTarget({ target: options.target, db: database })
          if (!target.exists) {
            console.error(describeMissingTarget(target, databasePath))
            process.exitCode = 1
            return
          }

          const run = latestRunForTarget(database, target.targetId)
          if (!run) {
            console.error(
              `No run recorded for target ${target.targetId}. Run \`windbreak engines --target ...\` first.`,
            )
            process.exitCode = 1
            return
          }
          runId = run.id
        }

        const runRow = readRunRow(database, runId)
        if (!runRow) {
          console.error(`No run ${runId} in ${databasePath}.`)
          process.exitCode = 1
          return
        }

        const targetRow = readTargetRow(database, runRow.targetId)
        if (!targetRow) {
          console.error(`Run ${runId} references target ${runRow.targetId}, which is missing.`)
          process.exitCode = 1
          return
        }

        const result = await runReport({
          db: database,
          runId,
          targetId: runRow.targetId,
          targetLocation: targetRow.location,
          commitSha: runRow.commitSha,
          version: VERSION,
          outDir: options.out ? path.resolve(options.out) : undefined,
          reproduced: options.reproduced,
          programContext: createProgramContext(database, runRow.targetId),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        if (options.json) {
          console.log(JSON.stringify(result, null, 2))
          return
        }

        console.log(`\noutput:       ${result.outDir}`)
        console.log(`sarif:        ${result.sarifPath}`)
        console.log(`index:        ${result.indexPath}`)
        console.log(`findings:     ${result.findings.length}`)
        console.log(`rediscovery:  ${result.rediscoveries.length}`)
        console.log(`not reported: ${result.excluded.length}`)

        if (result.findings.length > 0) {
          console.log('\nreported findings:')
          for (const finding of result.findings) {
            console.log(
              `  [${finding.evidenceTier}] ${finding.title} ` +
                `(${finding.filePath ?? '?'}:${finding.startLine ?? '?'})`,
            )
          }
          console.log(
            '\nHarnesses were generated but not built or run (spec D21). They are under' +
              ' harness/<finding-id>/.',
          )
        }

        for (const warning of result.warnings) {
          console.log(`warning: ${warning}`)
        }

        if (result.partial) {
          console.log(
            '\nWARN: this run is not complete, so the report is partial — an absent finding' +
              ' may not have been examined.',
          )
        } else {
          console.log('\nOK: report written.')
        }
      } finally {
        database.close()
      }
    })
}

const readRunRow = (
  db: Database,
  runId: string,
): { targetId: string; commitSha: string } | null => {
  const row = db
    .query<{ target_id: string; commit_sha: string }, [string]>(
      'SELECT target_id, commit_sha FROM runs WHERE id = ?',
    )
    .get(runId)
  return row ? { targetId: row.target_id, commitSha: row.commit_sha } : null
}

const readTargetRow = (
  db: Database,
  targetId: string,
): { location: string } | null => {
  const row = db
    .query<{ location: string }, [string]>('SELECT location FROM targets WHERE id = ?')
    .get(targetId)
  return row ? { location: row.location } : null
}

