import fs from 'fs'
import path from 'path'

import { MissingCredentialsError, SdkEnvironmentError, createWindbreakClient } from '../client'
import { createRun, finishRun, persistCandidates, readCandidateSummary } from '../engines'
import {
  capturePattern,
  describeFingerprint,
  measurePatternPrecision,
  parseFingerprint,
  readChecker,
  readLibrary,
  readReplays,
  refreshPatternPrecision,
  retireChecker,
  runVariantHunt,
} from '../library'
import { createProgramContext, createSdkModelInvoker, readCandidate } from '../pipeline'
import { openStateDatabase } from '../state/db'
import {
  DB_OPTION_DESCRIPTION,
  defaultDbPath,
  defaultTargetPath,
  effectiveConfig,
  requireTargetOption,
  TARGET_OPTION_DESCRIPTION,
} from './defaults'
import { describeMissingTarget, resolveCommandTarget } from './target'

import type { Command } from 'commander'
import type { Fingerprint, LibraryEntry } from '../library'

/** `human-reproduced` is the only tier that makes a pattern replay freely (§10). */
const GATE_LABEL = (entry: LibraryEntry): string =>
  entry.condition === 'confirmed'
    ? 'confirmed'
    : `unconfirmed (${entry.evidenceTier ?? 'no recorded tier'})`

const renderEntry = (entry: LibraryEntry, livePrecision?: number | null): string => {
  const precision = livePrecision === undefined ? entry.precisionObserved : livePrecision
  const lines = [
    `${entry.patternId}  [${GATE_LABEL(entry)}]`,
    `  checker:      ${entry.id}`,
    `  summary:      ${entry.fingerprint.summary}`,
    `  predicates:   ${describeFingerprint(entry.fingerprint)}`,
    `  languages:    ${entry.fingerprint.languages.join(', ')}`,
    `  scope:        ${entry.fingerprint.scope}`,
    `  mined from:   ${entry.originPatchSha}` +
      (entry.targetId ? ` (target ${entry.targetId})` : ''),
  ]

  if (entry.originSite) {
    lines.push(
      `  origin site:  ${entry.originSite.filePath}` +
        `${entry.originSite.functionName ? ` :: ${entry.originSite.functionName}` : ''}:` +
        `${entry.originSite.line}`,
    )
  }

  lines.push(
    `  pre-image:    ${entry.preImageHits ?? 'not validated'}` +
      ` hit(s), post-image: ${
        entry.postImageClean === null
          ? 'not checked'
          : entry.postImageClean === 1
            ? 'silent'
            : 'FIRES (invalid)'
      }`,
    `  precision:    ${
      precision === null
        ? 'no replayed candidates yet'
        : `${precision.toFixed(3)} (confirmed / produced, refreshed now)`
    }`,
  )

  if (entry.findingId) lines.push(`  finding:      ${entry.findingId}`)
  if (entry.modelId) lines.push(`  synthesized:  ${entry.modelId} (${entry.provider})`)
  if (entry.retiredAt) lines.push(`  retired:      ${entry.retiredAt}`)

  return lines.join('\n')
}

interface CommonOptions {
  db?: string
  json?: boolean
}

const readFingerprintFile = (filePath: string): Fingerprint => {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  return parseFingerprint(raw)
}

/**
 * The pattern library and variant hunting (spec §10, §4.8, §12.2).
 *
 * `add` is the only command that can spend a model call, and it spends exactly
 * one. `replay` spends none: it is SQL over the origin and replayed targets'
 * program models, so a sweep is cheap enough to run against every target the
 * researcher has already indexed.
 */
export const registerLibraryCommand = (program: Command): void => {
  const library = program
    .command('library')
    .description('Manage the cross-target pattern library (spec §10)')

  library
    .command('add')
    .description('Turn a confirmed finding into a validated, stored pattern')
    .requiredOption('--candidate <id>', 'the confirmed candidate to generalize')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--config <path>', 'config file with model settings')
    .option(
      '--fingerprint <path>',
      'use this fingerprint JSON instead of asking a model to synthesize one',
    )
    .option('--origin-patch <sha>', 'the revision the pattern is mined from')
    .option(
      '--post-image <targetId>',
      'a target that already contains the fix; the pattern must not match it',
    )
    .option('--no-cache', 'ignore the verdict cache and force a fresh synthesis call')
    .option('--json', 'emit machine-readable output')
    .action(async (options: CommonOptions & {
      candidate: string
      config?: string
      fingerprint?: string
      originPatch?: string
      postImage?: string
      cache?: boolean
    }) => {
      const databasePath = options.db ?? defaultDbPath()
      const database = openStateDatabase(databasePath)
      // Declared outside the `try` because the release happens in its `finally`, and a
      // `let` in a try block is not in scope there.
      let closeSessions: (() => Promise<void>) | undefined

      try {
        const candidate = readCandidate(database, options.candidate)
        if (!candidate) {
          console.error(`No candidate ${options.candidate} in ${databasePath}.`)
          process.exitCode = 1
          return
        }

        let supplied: Fingerprint | undefined
        if (options.fingerprint) {
          try {
            supplied = readFingerprintFile(options.fingerprint)
          } catch (error) {
            console.error(
              `Could not use ${options.fingerprint}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            )
            process.exitCode = 1
            return
          }
        }

        // Credentials are only needed on the synthesis path. A supplied
        // fingerprint is a documented override, not a degraded mode, so it must
        // not require a provider to be reachable.
        let invoker
        if (!supplied) {
          const loaded = effectiveConfig(options.config)
          if (loaded.violations.length > 0) {
            console.error('Configuration is invalid; refusing to run:')
            for (const violation of loaded.violations) {
              console.error(`  [${violation.role}] ${violation.message}`)
            }
            process.exitCode = 1
            return
          }

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
        }

        const result = await capturePattern({
          db: database,
          candidate,
          programContext: createProgramContext(database, candidate.targetId),
          ...(invoker ? { invoker } : {}),
          ...(supplied ? { fingerprint: supplied } : {}),
          ...(options.originPatch ? { originPatchSha: options.originPatch } : {}),
          ...(options.postImage ? { postImageTargetId: options.postImage } : {}),
          cacheDisabled: options.cache === false,
        })

        if (!result.ok) {
          if (options.json) {
            console.log(JSON.stringify({ ok: false, error: result.error }, null, 2))
          } else {
            console.error(result.error)
          }
          process.exitCode = 1
          return
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                ok: true,
                alreadyPresent: result.alreadyPresent,
                checkerId: result.checkerId,
                patternId: result.patternId,
                condition: result.condition,
                evidenceTier: result.evidenceTier,
                source: result.source,
                cached: result.cached,
                originPatchSha: result.entry?.originPatchSha ?? null,
                originSite: result.originSite,
                preImageHits: result.preImageHits,
                postImageClean: result.postImageClean,
                fingerprint: result.fingerprint,
                warnings: result.warnings,
              },
              null,
              2,
            ),
          )
          return
        }

        if (result.alreadyPresent) {
          console.log(`This pattern is already in the library as ${result.patternId}.`)
        } else {
          console.log(
            `Stored ${result.patternId} as ${result.checkerId}` +
              `${result.cached ? ' (fingerprint replayed from cache)' : ''}.`,
          )
        }
        console.log(`gate:         ${GATE_LABEL(result.entry!)}`)
        console.log(`fingerprint:  ${describeFingerprint(result.fingerprint!)}`)
        console.log(`origin hits:  ${result.preImageHits}`)
        console.log(
          `post-image:   ${
            result.postImageClean === null ? 'not checked (none supplied)' : 'silent'
          }`,
        )
        for (const warning of result.warnings) console.log(`warning: ${warning}`)
      } finally {
        await closeSessions?.()
        database.close()
      }
    })

  library
    .command('list')
    .description('List the patterns in the library')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--all', 'include retired patterns')
    .option('--pattern <id>', 'restrict to one pattern id')
    .option('--json', 'emit machine-readable output')
    .action((options: CommonOptions & { all?: boolean; pattern?: string }) => {
      const database = openStateDatabase(options.db ?? defaultDbPath())
      try {
        const entries = readLibrary(database, {
          includeRetired: options.all === true,
          ...(options.pattern ? { patternId: options.pattern } : {}),
        })

        if (options.json) {
          console.log(JSON.stringify(entries, null, 2))
          return
        }

        if (entries.length === 0) {
          console.log('The pattern library is empty.')
          return
        }

        for (const entry of entries) {
          // Measured live rather than read from the stored snapshot: the figure
          // exists to help decide what to retire, and a snapshot taken at the
          // last sweep goes stale the moment the sweep's candidates are
          // triaged — which is precisely when the number becomes meaningful.
          console.log(
            renderEntry(entry, measurePatternPrecision(database, entry.patternId).precision),
          )
          console.log('')
        }
      } finally {
        database.close()
      }
    })

  library
    .command('show')
    .description('Show one pattern, its fingerprint, and its replay history')
    .argument('<checkerId>', 'checker id, as listed by `library list`')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--json', 'emit machine-readable output')
    .action((checkerId: string, options: CommonOptions) => {
      const database = openStateDatabase(options.db ?? defaultDbPath())
      try {
        const entry = readChecker(database, checkerId)
        if (!entry) {
          console.error(`No checker ${checkerId} in ${options.db ?? defaultDbPath()}.`)
          process.exitCode = 1
          return
        }

        const replays = readReplays(database, checkerId)

        if (options.json) {
          console.log(JSON.stringify({ entry, replays }, null, 2))
          return
        }

        console.log(
          renderEntry(entry, measurePatternPrecision(database, entry.patternId).precision),
        )
        console.log('\nreplays:')
        if (replays.length === 0) {
          console.log('  (never replayed)')
        }
        for (const replay of replays) {
          console.log(
            `  ${replay.ranAt}  ${replay.targetId}  ` +
              `${replay.revalidated ? 'revalidated' : 'skipped'}  ` +
              `${replay.candidatesFound} candidate(s)` +
              `${replay.skippedReason ? `  — ${replay.skippedReason}` : ''}`,
          )
        }
      } finally {
        database.close()
      }
    })

  library
    .command('retire')
    .description('Retire a noisy pattern without deleting its history')
    .argument('<checkerId>', 'checker id to retire')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--json', 'emit machine-readable output')
    .action((checkerId: string, options: CommonOptions) => {
      const database = openStateDatabase(options.db ?? defaultDbPath())
      try {
        const changed = retireChecker(database, checkerId)

        if (options.json) {
          console.log(JSON.stringify({ checkerId, retired: changed > 0 }, null, 2))
          return
        }

        if (changed === 0) {
          console.error(
            `No live checker ${checkerId} to retire (it may already be retired).`,
          )
          process.exitCode = 1
          return
        }

        console.log(
          `Retired ${checkerId}. The pattern and its replay history stay in the ` +
            'database; it is simply no longer replayed (spec §10).',
        )
      } finally {
        database.close()
      }
    })

  library
    .command('replay')
    .alias('hunt')
    .description('Replay confirmed patterns against a target (spec §4.8, §12.2)')
    .option('--target <path>', TARGET_OPTION_DESCRIPTION, defaultTargetPath())
    .option('--commit <sha>', 'commit to pin; defaults to the checkout HEAD')
    .option('--db <path>', DB_OPTION_DESCRIPTION)
    .option('--pattern <id>', 'replay only this pattern')
    .option('--post-image <targetId>', "a target containing the fix; patterns must not match it")
    .option(
      '--allow-statically-verified',
      'replay patterns whose seeding finding was not human-reproduced',
    )
    .option('--max-candidates <n>', 'per-pattern candidate cap')
    .option('--json', 'emit machine-readable output')
    .action((options: CommonOptions & {
      target?: string
      commit?: string
      pattern?: string
      postImage?: string
      allowStaticallyVerified?: boolean
      maxCandidates?: string
    }) => {
      const targetPath = requireTargetOption(options.target)
      if (targetPath === null) return

      const databasePath = options.db ?? defaultDbPath()
      const database = openStateDatabase(databasePath)

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

        const maxCandidates = options.maxCandidates
          ? Number.parseInt(options.maxCandidates, 10)
          : undefined
        if (maxCandidates !== undefined && (!Number.isFinite(maxCandidates) || maxCandidates <= 0)) {
          console.error(`Invalid --max-candidates: ${options.maxCandidates}`)
          process.exitCode = 1
          return
        }

        const runId = createRun({
          db: database,
          targetId: target.targetId,
          commitSha: target.commitSha,
          config: { stage: 'variant-hunt', patternId: options.pattern ?? null },
        })

        const result = runVariantHunt({
          db: database,
          targetId: target.targetId,
          targetRoot: target.targetRoot,
          runId,
          targetCommitSha: target.commitSha,
          ...(options.postImage ? { postImageTargetId: options.postImage } : {}),
          allowStaticallyVerified: options.allowStaticallyVerified === true,
          ...(options.pattern ? { patternId: options.pattern } : {}),
          ...(maxCandidates !== undefined ? { maxCandidatesPerPattern: maxCandidates } : {}),
          log: options.json ? () => {} : (line) => console.log(line),
        })

        const persisted = persistCandidates({
          db: database,
          runId,
          candidates: result.candidates,
        })

        const ran = result.outcomes.filter((outcome) => outcome.revalidated)
        const skipped = result.outcomes.length - ran.length
        const status = skipped > 0 ? 'partial' : 'complete'
        finishRun(database, runId, status)

        const precision = refreshPatternPrecision({
          db: database,
          patternIds: result.outcomes.map((outcome) => outcome.patternId),
        })

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                runId,
                targetId: target.targetId,
                commit: target.commitSha,
                status,
                checkersConsidered: result.checkersConsidered,
                candidates: persisted.inserted,
                outcomes: result.outcomes,
                precision,
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
        console.log(`patterns:     ${result.checkersConsidered} considered, ${ran.length} ran`)
        console.log(`status:       ${status}`)

        if (result.outcomes.length > 0) {
          console.log('\nreplay:')
          for (const outcome of result.outcomes) {
            console.log(
              `  ${outcome.patternId.padEnd(28)} ` +
                `${outcome.revalidated ? 'ran      ' : 'skipped  '} ` +
                `${String(outcome.candidatesFound).padStart(4)} candidate(s)` +
                `${outcome.skippedReason ? `  — ${outcome.skippedReason}` : ''}`,
            )
          }
        }

        const summary = readCandidateSummary(database, runId)
        console.log(`\ncandidates:   ${summary.total}`)
        for (const row of summary.bySource) {
          console.log(`  ${row.source.padEnd(12)} ${row.count}`)
        }

        for (const warning of result.warnings) console.log(`warning: ${warning}`)

        if (persisted.inserted === 0) {
          console.log(
            '\nNo pattern matched this target. That is a statement about the patterns ' +
              'and the sweep, not proof the target is clean.',
          )
        }
        console.log(
          status === 'complete'
            ? '\nOK: variant hunting complete.'
            : '\nWARN: variant hunting partial — some patterns were skipped.',
        )
      } finally {
        database.close()
      }
    })
}
