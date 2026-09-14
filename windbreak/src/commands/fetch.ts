import path from 'path'

import {
  DEFAULT_SNAPSHOTS_DIR,
  EvalInputReadError,
  ProjectRegistryError,
  ensureSnapshot,
  loadEvalInput,
  loadProjectRegistry,
  resolveProject,
} from '../eval'

import type { Command } from 'commander'
import type { SnapshotResult } from '../eval'
import type { FixtureSet } from '../eval'

interface FetchCommandOptions {
  into?: string
  projects?: string
  timeoutSeconds?: string
  force?: boolean
  json?: boolean
}

/**
 * Materialize the snapshots a fixture list names (spec §11.2, D22).
 *
 * This command exists because D22 splits the corpus in two: the *list* is private and
 * ships in-repo, and the *snapshots* are fetched on demand. Before this, "on demand"
 * meant a researcher checking out each project by hand at each pinned revision —
 * which is a step that cannot be verified and that nobody enjoys getting wrong, since
 * a snapshot at the wrong revision makes every number `eval` produces wrong without
 * changing any of them.
 *
 * It is deliberately a separate command rather than a flag on `eval` or a mode of
 * `scan`:
 *
 * - **`eval` is documented as offline and free.** It reads rows that already exist.
 *   Making it clone repositories would put a network fetch behind the one command a
 *   researcher can run to re-score yesterday's corpus.
 * - **`scan` is the per-target tool.** Reaching a whole corpus from it would make the
 *   batch pipeline reachable from the thing the human runs interactively.
 *
 * So this does the one thing that needs a network, prints where every snapshot landed,
 * and stops. `scan --target <path>` takes it from there.
 *
 * One fixture that cannot be fetched does not cancel the others — they are independent
 * repositories, and a single mistyped sha should not cost a whole corpus — but any
 * failure exits non-zero, because a partially materialized corpus must not read as a
 * complete one (§18).
 */
export const registerFetchCommand = (program: Command): void => {
  program
    .command('fetch')
    .description(
      'Fetch the snapshots a fixture list names, at their pinned commits (spec §11.2, D22)',
    )
    .argument('<corpus>', 'path to a repo-snapshot fixture list (JSON)')
    .option(
      '--into <dir>',
      'snapshot cache directory',
      DEFAULT_SNAPSHOTS_DIR,
    )
    .option('--projects <path>', 'JSON file of project → remote entries, overriding the shipped map')
    .option('--timeout-seconds <n>', 'per-git-command limit (clone defaults to 900)')
    .option('--force', 'refetch even when a verified snapshot is cached')
    .option('--json', 'emit machine-readable output')
    .action(async (corpusPath: string, options: FetchCommandOptions) => {
      const into = path.resolve(options.into ?? DEFAULT_SNAPSHOTS_DIR)

      let fixtureSet: FixtureSet
      try {
        const input = loadEvalInput(corpusPath)
        if (input.kind !== 'repo-snapshots') {
          console.error(
            `${corpusPath} is a function-level pair set, whose halves are functions ` +
              'rather than repositories, so there is nothing to check out. ' +
              '`windbreak fetch` takes a repo-snapshot fixture list (spec §11.2).',
          )
          process.exitCode = 1
          return
        }
        fixtureSet = input.fixtureSet
      } catch (error) {
        if (error instanceof EvalInputReadError) {
          console.error(error.message)
          process.exitCode = 1
          return
        }
        throw error
      }

      let registry
      try {
        registry = loadProjectRegistry(options.projects)
      } catch (error) {
        if (error instanceof ProjectRegistryError) {
          console.error(error.message)
          process.exitCode = 1
          return
        }
        throw error
      }

      const timeoutSeconds =
        options.timeoutSeconds === undefined ? undefined : Number.parseInt(options.timeoutSeconds, 10)
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
        console.error(`Invalid --timeout-seconds: ${options.timeoutSeconds}`)
        process.exitCode = 1
        return
      }

      const log = options.json ? () => {} : (line: string) => console.log(line)
      const total = fixtureSet.fixtures.length
      log(
        `\nMaterializing ${total} snapshot(s) into ${into}` +
          `${options.force ? ' (forcing a refetch)' : ''}`,
      )

      const snapshots: SnapshotResult[] = []
      const failures: Array<{ fixtureId: string; project: string; reason: string }> = []

      for (const fixture of fixtureSet.fixtures) {
        const label = `${fixture.project}@${fixture.commitSha.slice(0, 12)}`
        try {
          const resolution = resolveProject({ project: fixture.project, registry })
          const snapshot = await ensureSnapshot({
            project: fixture.project,
            commitSha: fixture.commitSha,
            repo: resolution.repo,
            into,
            ...(options.force === true ? { force: true } : {}),
            ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
            log,
          })
          snapshots.push(snapshot)

          if (!options.json) {
            const status = snapshot.status.padEnd(6)
            const seconds = `${(snapshot.durationMs / 1000).toFixed(1)}s`.padStart(7)
            console.log(`  ${label.padEnd(30)} ${status} ${seconds}  ${snapshot.path}`)
            if (!snapshot.filtered) {
              console.log(
                `  ${' '.repeat(30)} note: full clone (the remote does not support ` +
                  'partial clone)',
              )
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          failures.push({ fixtureId: fixture.id, project: fixture.project, reason })
          // The reason is printed once, in the failure summary below the table, so
          // that a run with several failures reads as a list rather than as prose
          // interleaved with results.
          if (!options.json) console.log(`  ${label.padEnd(30)} FAILED`)
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ into, snapshots, failures }, null, 2))
      } else {
        if (snapshots.length > 0) {
          console.log('\nScan one with:')
          for (const snapshot of snapshots) {
            console.log(`  windbreak scan --target ${snapshot.path}`)
          }
        }
        for (const failure of failures) {
          console.log(`\nfailed: ${failure.fixtureId} (${failure.project})`)
          console.log(`  ${failure.reason}`)
        }
        console.log(
          `\n${snapshots.length}/${total} snapshot(s) materialized` +
            (failures.length > 0 ? `, ${failures.length} failed` : ''),
        )
      }

      // A corpus that is only partly on disk is not a corpus that was fetched, and
      // the difference has to be an exit code rather than a line somebody can miss.
      if (failures.length > 0) process.exitCode = 1
    })
}
