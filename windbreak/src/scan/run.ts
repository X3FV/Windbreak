/**
 * `scan` orchestration (spec §3.2, §7.3, §9).
 *
 * Three decisions shape this file, and they are why it exists rather than being
 * a shell script over the existing commands.
 *
 * **One run.** The individual commands each create their own run row, which is
 * right when they are used alone. A scan creates *one* and threads it through
 * every stage, because §9's budget is per target and §11.3's metrics are per
 * run — six runs for one target would make both meaningless.
 *
 * **One budget.** For the same reason, one governor spans the scan, so
 * `ingestion → static-core → triage → verification → reporting` draw on a
 * single §9 manifest instead of each getting a fresh hour.
 *
 * **Discovery degrades, sandboxing does not.** A missing model environment
 * costs the scan its triage and verification stages and nothing else (§20.13),
 * while a missing sandbox or an unresolvable engine is a hard stop (§18) —
 * those are the two cases where continuing would mean running target code
 * unsandboxed, or reporting a net narrower than the one that was asked for.
 */

import {
  createBudgetGovernor,
  createInteractiveDecider,
  createNonInteractiveDecider,
} from '../budget'
import { MissingCredentialsError, SdkEnvironmentError, createWindbreakClient } from '../client'
import { findProviderFailure } from '../provider-failure'
import { createRun, finishRun, persistCandidates, requireEngines, runBaselineEngines } from '../engines'
import { runPatchMining } from '../patchmine'
import { runToctou } from '../toctou'
import { resolveRulePaths } from '../engines/rules'
import { capturePattern, refreshPatternPrecision, runVariantHunt } from '../library'
import { correlateWithOsv, OsvClient } from '../osv'
import {
  createProgramContext,
  createSdkModelInvoker,
  readCandidate,
  readCandidatesForTriage,
  readCandidatesForVerification,
  runRediscoveryCheck,
  runTriage,
  runVerification,
} from '../pipeline'
import { runRecon } from '../recon'
import { runReport } from '../report'
import { readLanguageCoverage } from './coverage'
import {
  carriedElapsedSeconds,
  deriveCounts,
  firstIncompleteStage,
  LIBRARY_OPT_IN_SKIP,
  modelsUsedByRun,
  readRunMetrics,
  SCAN_STAGES,
  skippedByRequest,
  stageDefinition,
  STATIC_ONLY_SKIP,
  writeRunMetrics,
} from './stages'

import type { Database } from 'bun:sqlite'
import type { ManifestRef } from '../recon'
import type { ModelInvoker, PipelineProgramContext } from '../pipeline'
import type { InvokerOutcome, ScanOptions, ScanResult, ScanStageId, ScanStatus, StageRecord, StageStatus } from './types'

/**
 * The stage entry points that touch the environment — a filesystem, a sandbox,
 * a process, the network — as an injectable seam.
 *
 * Only these are injectable. The pipeline stages are *not*, because they are
 * already driven by the `ModelInvoker` seam and operate purely on database rows,
 * so a test exercises the real ones with a fake invoker. The five below have no
 * such seam, and without one the orchestrator's control flow — which stage runs
 * next, what a stage's failure does to the rest, where `resume` picks up — could
 * only be tested by running the whole thing for real.
 */
export interface ScanDeps {
  runRecon: typeof runRecon
  correlateWithOsv: typeof correlateWithOsv
  requireEngines: typeof requireEngines
  runBaselineEngines: typeof runBaselineEngines
  runPatchMining: typeof runPatchMining
  runToctou: typeof runToctou
  runVariantHunt: typeof runVariantHunt
  runReport: typeof runReport
}

export const DEFAULT_SCAN_DEPS: ScanDeps = {
  runRecon,
  correlateWithOsv,
  requireEngines,
  runBaselineEngines,
  runPatchMining,
  runToctou,
  runVariantHunt,
  runReport,
}

/** A stage handler's verdict on its own work, and on whether to continue. */
interface StageOutcome {
  status: StageStatus
  detail: string | null
  counts: Record<string, number>
  reason: string | null
  /** Stop the chain, with this terminal status. */
  stop: 'failed' | 'aborted' | null
  warnings: string[]
  report?: ScanResult['report']
}

const ok = (
  detail: string | null,
  counts: Record<string, number> = {},
  extra: Partial<StageOutcome> = {},
): StageOutcome => ({
  status: 'complete',
  detail,
  counts,
  reason: null,
  stop: null,
  warnings: [],
  ...extra,
})

const skippedStage = (reason: string): StageOutcome => ({
  status: 'skipped',
  detail: null,
  counts: {},
  reason,
  stop: null,
  warnings: [],
})

const failedStage = (
  reason: string,
  stop: StageOutcome['stop'] = null,
): StageOutcome => ({
  status: 'failed',
  detail: null,
  counts: {},
  reason,
  stop,
  warnings: [],
})

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** First line only: the SDK's own message is a multi-line validation dump. */
const shortReason = (error: unknown): string => {
  if (error instanceof MissingCredentialsError) {
    return 'no credentials found (neither credentials.json nor CODEBUFF_API_KEY); run `windbreak auth status`'
  }
  if (error instanceof SdkEnvironmentError) {
    return 'the model SDK environment is not configured; run `windbreak auth status`'
  }
  return messageOf(error).split('\n')[0] ?? messageOf(error)
}

export const defaultResolveInvoker =
  (models: ScanOptions['config']['models'], log: (line: string) => void) =>
  async (): Promise<InvokerOutcome> => {
    try {
      const { client } = await createWindbreakClient()
      return {
        ok: true,
        invoker: createSdkModelInvoker({ client, models, log }),
      }
    } catch (error) {
      return { ok: false, reason: shortReason(error) }
    }
  }

/**
 * The §4.2 lookup-3 refresh, wired here because it needs the OSV client and the
 * pipeline deliberately does not depend on it. `commands/pipeline.ts` wires the
 * same pair for the same reason.
 */
const knownVulnRefresher =
  (commitSha: string) =>
  async (): Promise<Array<{ vulnId: string; aliases: string[]; summary: string | null; details: string | null }>> => {
    const vulns = await new OsvClient().queryCommit(commitSha)
    return vulns.map((vuln) => ({
      vulnId: vuln.id,
      aliases: vuln.aliases ?? [],
      summary: vuln.summary ?? null,
      details: vuln.details ?? null,
    }))
  }

/**
 * The subset of `runs.config_json` that a resume inherits.
 *
 * Read defensively: the column holds whatever the creating invocation wrote,
 * and a run created by an older build may not have these keys at all. A
 * missing key means "no recorded preference", which leaves the default — never
 * a crash on resume.
 */
const parseRunConfig = (
  json: string,
): { totalSeconds?: number; staticOnly?: boolean; updateLibrary?: boolean } => {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.totalSeconds === 'number' ? { totalSeconds: record.totalSeconds } : {}),
      ...(record.staticOnly === true ? { staticOnly: true } : {}),
      ...(record.updateLibrary === true ? { updateLibrary: true } : {}),
    }
  } catch {
    return {}
  }
}

const readTargetLocation = (db: Database, targetId: string): string =>
  db
    .query<{ location: string }, [string]>('SELECT location FROM targets WHERE id = ?')
    .get(targetId)?.location ?? '(unknown)'

/**
 * Run or continue a scan.
 *
 * When `runId` is supplied the invocation behaves as `resume`: the run's
 * recorded stages decide where to start, and the governor is built with the
 * time each stage already spent, so the target's budget is not renewed.
 */
export const runScan = async (options: ScanOptions): Promise<ScanResult> => {
  const log = options.log ?? (() => {})
  const now = options.now ?? Date.now
  const warnings: string[] = []
  const stages: StageRecord[] = []

  let totalSeconds = options.budgetSeconds ?? options.config.budget.totalSeconds
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    throw new Error(`Invalid budget: ${String(options.budgetSeconds)}`)
  }

  // The mode flags are resolved *after* the run is known, because a resume
  // inherits them: §9's budget is per target, so a resumed scan must not be
  // handed a fresh hour, and a `--static-only` run that was interrupted must
  // not come back with model stages switched on. An explicitly passed flag
  // always wins over the record.
  let staticOnly = options.staticOnly === true
  let updateLibrary = options.updateLibrary === true

  // --- the run: one, created here and carried through every stage ---
  let runId: string
  let priorRecords: StageRecord[] = []

  if (options.runId) {
    const run = options.db
      .query<{ id: string; target_id: string; config_json: string }, [string]>(
        'SELECT id, target_id, config_json FROM runs WHERE id = ?',
      )
      .get(options.runId)

    if (!run) throw new Error(`No run ${options.runId} in this database.`)
    if (run.target_id !== options.targetId) {
      throw new Error(
        `Run ${options.runId} belongs to target ${run.target_id}, not ${options.targetId}.`,
      )
    }

    runId = run.id
    priorRecords = readRunMetrics(options.db, runId).stages

    const recorded = parseRunConfig(run.config_json)
    if (options.budgetSeconds === undefined && typeof recorded.totalSeconds === 'number') {
      totalSeconds = recorded.totalSeconds
    }
    if (options.staticOnly === undefined && recorded.staticOnly === true) {
      staticOnly = true
    }
    if (options.updateLibrary === undefined && recorded.updateLibrary === true) {
      updateLibrary = true
    }

    const done = priorRecords.filter((record) => record.status === 'complete').length
    log(`[scan] resuming ${runId}: ${done} stage(s) already complete`)
  } else {
    runId = createRun({
      db: options.db,
      targetId: options.targetId,
      commitSha: options.commitSha,
      // Recorded so `resume` can rebuild the same budget without the flags.
      config: {
        stage: 'scan',
        totalSeconds,
        shares: options.config.budget.shares,
        staticOnly,
        updateLibrary,
      },
      cacheDisabled: options.cacheDisabled,
    })
  }

  const includeOptIn = updateLibrary
  const startAt = firstIncompleteStage(priorRecords, { includeOptIn })

  const governor = createBudgetGovernor({
    totalSeconds,
    shares: options.config.budget.shares,
    initialElapsedSeconds: carriedElapsedSeconds(priorRecords),
    db: options.db,
    runId,
    decide: options.yes
      ? createNonInteractiveDecider('policy:--yes')
      : createInteractiveDecider(),
    log,
    now,
  })

  /** Model calls and real cache replays, for §11.3's `cache_hit_rate`. */
  const rates = { calls: 0, hits: 0 }

  let programContext: PipelineProgramContext | undefined
  let manifests: readonly ManifestRef[] = []
  let report: ScanResult['report'] = null
  let invokerOutcome: InvokerOutcome | null = null
  let activeInvoker: ModelInvoker | null = null
  let terminal: ScanStatus | null = null

  const resolveInvoker =
    options.resolveInvoker ??
    defaultResolveInvoker(options.config.models, staticOnly ? () => {} : log)

  const getInvoker = async (): Promise<InvokerOutcome> => {
    invokerOutcome ??= await resolveInvoker()
    if (invokerOutcome.ok) activeInvoker = invokerOutcome.invoker
    return invokerOutcome
  }

  const ensureProgramContext = (): PipelineProgramContext => {
    programContext ??= createProgramContext(options.db, options.targetId)
    return programContext
  }

  /**
   * The run's record so far: everything an earlier invocation left, with this
   * invocation's stages layered on top so a re-run supersedes what it replaces.
   */
  const recordsSoFar = (): StageRecord[] => [...priorRecords.filter((prior) =>
    !stages.some((stage) => stage.stage === prior.stage),
  ), ...stages]

  const persistProgress = (): void => {
    writeRunMetrics({
      db: options.db,
      runId,
      stages: recordsSoFar(),
      counts: deriveCounts(recordsSoFar()),
      cacheHitRate: null,
      models: modelsUsedByRun(options.db, runId),
    })
  }

  if (startAt === null) {
    const metrics = readRunMetrics(options.db, runId)
    log('[scan] every requested stage is already complete; nothing to do')
    return {
      runId,
      targetId: options.targetId,
      commitSha: options.commitSha,
      status: 'complete',
      stages: metrics.stages,
      counts: deriveCounts(metrics.stages),
      resumeFrom: null,
      report: null,
      languageCoverage: readLanguageCoverage(options.db, options.targetId),
      // Nothing ran in this invocation, so nothing was refused here. What the *recorded*
      // stages met is on their own rows, and a resume that re-enters them will classify it
      // then rather than this path reporting a refusal it did not observe.
      providerFailure: null,
      warnings: ['every requested stage was already complete'],
    }
  }

  const deps: ScanDeps = { ...DEFAULT_SCAN_DEPS, ...options.deps }
  const ordered = SCAN_STAGES.map((stage) => stage.id)
  const startIndex = ordered.indexOf(startAt)

  // A resumed run does not repeat what it already finished. Without this the
  // stages that follow the resume point are re-entered even though they are
  // complete, which spends budget twice and re-writes their artifacts for no
  // new information.
  //
  // Only `complete` is settled. A stage skipped *by request* is deliberately
  // re-entered: the operator's flags may have changed since, and re-deciding is
  // the whole reason a resume can ask for more than the first invocation did.
  // `partial` and `failed` are re-entered for the same reason they exist.
  const settled = new Set(
    priorRecords.filter((prior) => prior.status === 'complete').map((prior) => prior.stage),
  )

  for (const stageId of ordered.slice(startIndex)) {
    const definition = stageDefinition(stageId)
    const startedAt = now()

    if (settled.has(stageId)) {
      log(`[scan] ${stageId}: already complete, not re-run`)
      continue
    }

    log(`[scan] ${stageId} (${definition.spec})`)

    // --- deliberately not attempted in this invocation ---
    if (definition.optIn && !includeOptIn) {
      stages.push(record(stageId, startedAt, skippedStage(LIBRARY_OPT_IN_SKIP)))
      persistProgress()
      continue
    }
    if (definition.needsModel && staticOnly) {
      stages.push(record(stageId, startedAt, skippedStage(STATIC_ONLY_SKIP)))
      persistProgress()
      continue
    }
    if (definition.needsModel) {
      const outcome = await getInvoker()
      if (!outcome.ok) {
        stages.push(record(stageId, startedAt, skippedStage(outcome.reason)))
        persistProgress()
        continue
      }
    }

    let outcome: StageOutcome
    try {
      outcome = await runStage(stageId, startedAt)
    } catch (error) {
      // A stage's own failure semantics are all return values; a throw out of
      // one is a bug or a hard environment failure, and either way the chain
      // must not continue as if it had worked.
      outcome = failedStage(messageOf(error), 'failed')
    }

    stages.push(record(stageId, startedAt, outcome))
    warnings.push(...outcome.warnings)
    if (outcome.report !== undefined) report = outcome.report ?? report
    persistProgress()

    if (outcome.stop) {
      terminal = outcome.stop
      break
    }
  }

  // --- status, resume point, final metrics ---
  const reRun = new Set(stages.map((stage) => stage.stage))
  const allStages = [
    ...priorRecords.filter((prior) => !reRun.has(prior.stage)),
    ...stages,
  ].sort(
    (a, b) => ordered.indexOf(a.stage) - ordered.indexOf(b.stage),
  )

  const resumeFrom = firstIncompleteStage(allStages, { includeOptIn })

  // `complete` means "everything that was asked for ran". A stage the operator
  // deliberately switched off — `--static-only`, or the opt-in library update
  // nobody asked for — is not a gap, so counting it as one would make every
  // ordinary scan report itself partial and exit non-zero. A stage skipped
  // because the environment refused it (no provider, no engine) is a real gap
  // and keeps the run partial, which is what tells the operator the net was
  // narrower than the one they asked for.
  const status: ScanStatus =
    terminal ??
    (allStages.every((stage) => stage.status === 'complete' || skippedByRequest(stage))
      ? 'complete'
      : 'partial')

  finishRun(options.db, runId, status)

  const counts = deriveCounts(allStages)
  const cacheHitRate = rates.calls > 0 ? rates.hits / rates.calls : null

  // Classified once, from the evidence the run already collected: the per-call warnings and
  // the reasons attached to stages that never ran. Both are where a refusal actually shows
  // up — a provider that refuses every call is a warning per candidate, and an environment
  // with no credentials at all is a *skipped* stage whose reason says so — so reading them
  // is a search rather than a second tally that could drift from them.
  const providerFailure = findProviderFailure([
    ...warnings,
    ...allStages.map((stage) => stage.reason ?? ''),
  ])

  writeRunMetrics({
    db: options.db,
    runId,
    stages: allStages,
    counts,
    cacheHitRate,
    models: modelsUsedByRun(options.db, runId),
  })

  return {
    runId,
    targetId: options.targetId,
    commitSha: options.commitSha,
    status,
    stages: allStages,
    counts,
    resumeFrom,
    report,
    // Read after every stage, so a scan that aborted before the static core still
    // reports the model it found rather than an empty coverage line that would
    // read as "nothing indexed" instead of "nothing ran".
    languageCoverage: readLanguageCoverage(options.db, options.targetId),
    providerFailure,
    warnings,
  }

  // --- stage implementations -------------------------------------------------

  function record(stage: ScanStageId, startedAt: number, outcome: StageOutcome): StageRecord {
    return {
      stage,
      status: outcome.status,
      durationMs: Math.round(now() - startedAt),
      detail: outcome.detail,
      counts: outcome.counts,
      reason: outcome.reason,
    }
  }

  async function runStage(stageId: ScanStageId, startedAt: number): Promise<StageOutcome> {
    switch (stageId) {
      case 'ingestion': {
        const recon = await deps.runRecon({
          target: options.targetRoot,
          commit: options.commitSha,
          ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
          build: options.build !== false,
          ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
          db: options.db,
          log,
        })

        manifests = recon.dependencyManifests
        const stageWarnings = [...recon.warnings]

        // §9 gives ingestion 10% of the target. The walk is not interrupted
        // part-way — recon has no checkpoint to interrupt at — so an overrun is
        // recorded rather than prompted for. Silently absorbing it would hide
        // where the hour went.
        const ingestionQuota = governor.quotaSeconds('ingestion')
        if ((now() - startedAt) / 1000 > ingestionQuota) {
          stageWarnings.push(
            `ingestion took longer than its ${ingestionQuota}s share of the budget; ` +
              'the later stages are working with less than §9 gives them.',
          )
        }

        return ok(
          `${recon.inventory.fileCount} files, ${recon.programModel?.symbols ?? 0} symbols, ` +
            `build model ${recon.build.model}`,
          {
            files: recon.inventory.fileCount,
            symbols: recon.programModel?.symbols ?? 0,
            callSites: recon.programModel?.references ?? 0,
          },
          { warnings: stageWarnings },
        )
      }

      case 'known-vuln': {
        const result = await deps.correlateWithOsv({
          targetRoot: options.targetRoot,
          manifests,
          targetId: options.targetId,
          commitSha: options.commitSha,
          db: options.db,
          enrich: true,
          log,
        })

        const advisories =
          result.packageMatches.reduce((sum, match) => sum + match.vulns.length, 0) +
          result.commitMatches.reduce((sum, match) => sum + match.vulns.length, 0)

        return {
          status: result.status === 'complete' ? 'complete' : 'partial',
          detail:
            `${result.dependencies.length} dependencies, ${advisories} advisory match(es), ` +
            `status ${result.status}`,
          counts: { dependencies: result.dependencies.length, advisories },
          // §18: a failed correlation is `known_vuln: unknown`, never clean.
          reason:
            result.status === 'complete'
              ? null
              : `OSV status is ${result.status}, so this target is known_vuln: unknown, not clean`,
          stop: null,
          warnings: result.warnings,
        }
      }

      case 'static-core': {
        // §18 / §4.3: fail closed. A configured engine that cannot be resolved
        // stops the scan rather than quietly thinning the net.
        const resolved = await deps.requireEngines({
          required: options.config.engines.required,
          log: staticOnly ? () => {} : log,
        })

        const engines = await deps.runBaselineEngines({
          targetRoot: options.targetRoot,
          targetId: options.targetId,
          commitSha: options.commitSha,
          engines: resolved.resolved,
          unavailable: resolved.unavailable,
          rulePaths: resolveRulePaths(options.config.engines.rulePaths),
          db: options.db,
          runId,
          governor,
          engineCapSeconds: options.config.engines.engineCapSeconds,
          jobs: options.config.engines.jobs,
          timeoutSeconds: options.config.engines.timeoutSeconds,
          ...(options.scratchDir ? { scratchDir: options.scratchDir } : {}),
          ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
          log,
        })

        if (engines.stoppedBy === 'budget-abort') {
          return {
            status: 'aborted',
            detail: `${engines.candidates.length} candidate(s) before the abort`,
            counts: { candidates: engines.candidates.length },
            reason: 'the budget governor aborted the static core',
            stop: 'aborted',
            warnings: engines.warnings,
          }
        }

        // §4.4.1: patch-mined discovery. It sits in the static core because §3.2
        // step 3 groups it there, and it persists its own candidates for the same
        // reason the engines stage does — it is the thing that knows the run id.
        //
        // It runs after the engines and before the replay so that a run whose
        // budget dies mid-discovery has spent it on the sources that produce the
        // most candidates first.
        const patchMined = await deps.runPatchMining({
          targetRoot: options.targetRoot,
          targetId: options.targetId,
          runId,
          db: options.db,
          governor,
          ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
          log,
        })

        if (patchMined.stoppedBy === 'budget-abort') {
          return {
            status: 'aborted',
            detail:
              `${engines.candidates.length} engine candidate(s), ` +
              `${patchMined.patterns.length} pattern(s) before the abort`,
            counts: {
              candidates: engines.candidates.length,
              patchMined: patchMined.candidates.length,
              patchPatterns: patchMined.patterns.length,
            },
            reason: 'the budget governor aborted patch-mined discovery',
            stop: 'aborted',
            warnings: [...engines.warnings, ...patchMined.warnings],
          }
        }

        // §4.4.3: check-to-use discovery. It sits in the static core for the same
        // reason patch mining does — §3.2 step 3 groups it there — and it runs after
        // the engines for the same reason too: a run whose budget dies mid-discovery
        // should have spent it on the sources that produce the most candidates first.
        const toctou = await deps.runToctou({
          targetRoot: options.targetRoot,
          targetId: options.targetId,
          runId,
          db: options.db,
          governor,
          ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
          log,
        })

        if (toctou.stoppedBy === 'budget-abort') {
          return {
            status: 'aborted',
            detail:
              `${engines.candidates.length} engine candidate(s), ` +
              `${patchMined.candidates.length} patch-mined, ` +
              `${toctou.rules.length} atomicity rule(s) before the abort`,
            counts: {
              candidates: engines.candidates.length,
              patchMined: patchMined.candidates.length,
              patchPatterns: patchMined.patterns.length,
              toctou: toctou.candidates.length,
              toctouRules: toctou.rules.length,
            },
            reason: 'the budget governor aborted check-to-use discovery',
            stop: 'aborted',
            warnings: [...engines.warnings, ...patchMined.warnings, ...toctou.warnings],
          }
        }

        // §4.8: patterns confirmed on any previous target are swept here, in
        // discovery, so their hits are triaged and verified like any candidate.
        const replay = deps.runVariantHunt({
          db: options.db,
          targetId: options.targetId,
          targetRoot: options.targetRoot,
          runId,
          targetCommitSha: options.commitSha,
          log,
        })

        const replayPersisted = persistCandidates({
          db: options.db,
          runId,
          candidates: replay.candidates,
        })

        refreshPatternPrecision({
          db: options.db,
          patternIds: replay.outcomes.map((outcome) => outcome.patternId),
        })

        const patternsRan = replay.outcomes.filter((outcome) => outcome.revalidated).length
        const engineFailed = engines.executions.some((execution) => execution.failed)

        const patchMineDegraded = patchMined.stoppedBy === 'budget-degrade'
        const toctouDegraded = toctou.stoppedBy === 'budget-degrade'
        // Counted per kind rather than by subtraction. The subtraction that used to be
        // here (`sites.length - fsm`) was correct only while there were two kinds, and
        // the third would have been reported as atomicity violations — a count that
        // lies is worse than a count that is missing.
        const toctouFsm = toctou.sites.filter((site) => site.kind === 'fsm').length
        const toctouAtomicity = toctou.sites.filter((site) => site.kind === 'atomicity').length
        const toctouSignal = toctou.sites.filter((site) => site.kind === 'signal').length
        const toctouInterproc = toctou.sites.filter((site) => site.kind === 'interproc').length

        return {
          status:
            engineFailed ||
            engines.stoppedBy === 'budget-degrade' ||
            patchMineDegraded ||
            toctouDegraded
              ? 'partial'
              : 'complete',
          detail:
            `${engines.candidates.length} engine candidate(s), ` +
            `${patchMined.candidates.length} patch-mined from ${patchMined.patterns.length} ` +
            `pattern(s), ${toctou.candidates.length} toctou from ` +
            `${toctou.rules.length} rule(s) + ${toctouFsm} fsm site(s) + ` +
            `${toctouInterproc} interprocedural site(s) + ` +
            `${toctouSignal} signal site(s) over ${toctou.coverage.signalHandlers} handler(s), ` +
            `${replayPersisted.inserted} variant(s) from ` +
            `${patternsRan}/${replay.checkersConsidered} pattern(s)`,
          counts: {
            candidates: engines.candidates.length,
            patchMined: patchMined.candidates.length,
            patchPatterns: patchMined.patterns.length,
            toctou: toctou.candidates.length,
            toctouRules: toctou.rules.length,
            toctouFsm,
            toctouAtomicity,
            toctouSignal,
            toctouInterproc,
            signalHandlers: toctou.coverage.signalHandlers,
            // The call graph's own denominator, carried beside the counts it qualifies.
            callEdges: toctou.coverage.callEdges,
            callSitesSeen: toctou.coverage.callSitesSeen,
            callSitesUnattributed: toctou.coverage.callSitesUnattributed,
            callSitesAmbiguous: toctou.coverage.callSitesAmbiguous,
            callerGuardedSites: toctou.coverage.callerGuardedSites,
            variants: replayPersisted.inserted,
            patternsConsidered: replay.checkersConsidered,
            patternsRan,
          },
          reason: engineFailed
            ? 'an engine failed, so its findings are partial and this is not a clean result'
            : patchMineDegraded
              ? 'patch-mined discovery hit the budget, so its sweep is partial'
              : toctouDegraded
                ? 'check-to-use discovery hit the budget, so its sweep is partial'
                : null,
          stop: null,
          warnings: [
            ...engines.warnings,
            ...patchMined.warnings,
            ...toctou.warnings,
            ...replay.warnings,
          ],
        }
      }

      case 'triage': {
        if (!activeInvoker) return skippedStage('no model invoker is available')

        // §4.2 lookup 3 first: it is free and it keeps known vulnerabilities out
        // of the model stages entirely.
        const rediscovery = await runRediscoveryCheck({
          db: options.db,
          targetId: options.targetId,
          candidates: readCandidatesForTriage(options.db, runId),
          programContext: ensureProgramContext(),
          ...(options.refresh === false
            ? {}
            : { refreshKnownVulns: knownVulnRefresher(options.commitSha) }),
          log,
        })
        const triage = await runTriage({
          db: options.db,
          runId,
          candidates: readCandidatesForTriage(options.db, runId),
          invoker: activeInvoker,
          programContext: ensureProgramContext(),
          governor,
          ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
          ...(options.enrich === false ? { enrich: false } : {}),
          log,
          now,
        })

        // Every triaged candidate answered one call, plus one enrichment call
        // for each candidate the second pass actually ran for. Counting
        // candidates alone would let `cached` (which counts enrichment answers
        // too) push the hit rate above 1.
        rates.calls += triage.processed + triage.enriched
        rates.hits += triage.cached

        const aborted = triage.stoppedBy === 'budget-abort'

        return {
          status: aborted ? 'aborted' : triage.failed > 0 ? 'partial' : 'complete',
          detail:
            `${triage.processed} triaged, ${triage.byLabel['likely-real']} likely-real, ` +
            `${triage.byLabel['likely-noise']} likely-noise, ` +
            `${triage.byLabel['needs-context']} needs-context` +
            (rediscovery.count > 0 ? `, ${rediscovery.count} rediscovery` : ''),
          counts: {
            processed: triage.processed,
            likelyReal: triage.byLabel['likely-real'],
            likelyNoise: triage.byLabel['likely-noise'],
            needsContext: triage.byLabel['needs-context'],
            cached: triage.cached,
            failed: triage.failed,
            rediscovery: rediscovery.count,
          },
          reason: aborted
            ? 'the budget governor aborted triage'
            : triage.failed > 0
              ? `${triage.failed} call(s) failed; those candidates were left unlabelled, not treated as clean`
              : null,
          stop: aborted ? 'aborted' : null,
          warnings: [...rediscovery.warnings, ...triage.warnings],
        }
      }

      case 'verification': {
        if (!activeInvoker) return skippedStage('no model invoker is available')

        const verification = await runVerification({
          db: options.db,
          runId,
          candidates: readCandidatesForVerification(options.db, runId),
          invoker: activeInvoker,
          programContext: ensureProgramContext(),
          governor,
          ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
          log,
          now,
        })

        // Two calls per verified candidate: the Proposer and the Refuter.
        rates.calls += verification.verified * 2
        rates.hits += verification.cached

        const aborted = verification.stoppedBy === 'budget-abort'

        return {
          status: aborted ? 'aborted' : verification.failed > 0 ? 'partial' : 'complete',
          detail:
            `${verification.verified} verified: ` +
            `${verification.byDisposition['likely-real']} confirmed, ` +
            `${verification.byDisposition.dropped} dropped, ` +
            `${verification.byDisposition.escalated} escalated`,
          counts: {
            verified: verification.verified,
            confirmed: verification.byDisposition['likely-real'],
            dropped: verification.byDisposition.dropped,
            escalated: verification.byDisposition.escalated,
            cached: verification.cached,
            failed: verification.failed,
          },
          reason: aborted
            ? 'the budget governor aborted verification'
            : verification.failed > 0
              ? `${verification.failed} call(s) failed; those candidates are neither confirmed nor dropped`
              : null,
          stop: aborted ? 'aborted' : null,
          warnings: verification.warnings,
        }
      }

      case 'reporting': {
        // The run row is still `running` here — the chain has not finished, so
        // it cannot have been finalized — so the report is told what has
        // actually completed rather than being allowed to read it and conclude
        // that every in-scan report is partial.
        const upstreamComplete = stages.every(
          (stage) => stage.status === 'complete' || skippedByRequest(stage),
        )

        const result = await deps.runReport({
          db: options.db,
          runId,
          targetId: options.targetId,
          targetLocation: readTargetLocation(options.db, options.targetId),
          commitSha: options.commitSha,
          version: options.version,
          runStatus: upstreamComplete ? 'complete' : 'partial',
          ...(options.outDir ? { outDir: options.outDir } : {}),
          programContext: ensureProgramContext(),
          log,
          now,
        })

        return {
          status: result.partial ? 'partial' : 'complete',
          detail:
            `${result.findings.length} finding(s), ${result.rediscoveries.length} rediscovery, ` +
            `${result.excluded.length} not reported`,
          counts: {
            findings: result.findings.length,
            rediscoveries: result.rediscoveries.length,
            excluded: result.excluded.length,
          },
          reason: result.partial
            ? 'the run was not complete, so this report is partial'
            : null,
          stop: null,
          warnings: result.warnings,
          report: result,
        }
      }

      case 'library-update': {
        if (!activeInvoker) return skippedStage('no model invoker is available')

        const confirmed = options.db
          .query<{ id: string }, [string]>(
            "SELECT id FROM candidates WHERE run_id = ? AND state = 'confirmed' " +
              'ORDER BY file_path, start_line',
          )
          .all(runId)

        if (confirmed.length === 0) {
          return ok('no confirmed finding to generalize', { considered: 0 })
        }

        let stored = 0
        let present = 0
        const failures: string[] = []

        for (const row of confirmed) {
          const candidate = readCandidate(options.db, row.id)
          if (!candidate) continue

          // Capture applies §10's own gates, including the D15 tier gate, so a
          // pattern whose finding is only statically verified is stored
          // unconfirmed rather than promoted by being captured here.
          const capture = await capturePattern({
            db: options.db,
            candidate,
            programContext: ensureProgramContext(),
            invoker: activeInvoker,
            ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
            now,
          })

          if (capture.alreadyPresent) present += 1
          else if (capture.ok) stored += 1
          else failures.push(`${row.id}: ${capture.error}`)
        }

        return {
          status: failures.length > 0 ? 'partial' : 'complete',
          detail:
            `${stored} pattern(s) stored, ${present} already present, ` +
            `${confirmed.length} confirmed finding(s) considered`,
          counts: { considered: confirmed.length, stored, alreadyPresent: present },
          reason:
            failures.length > 0
              ? `${failures.length} pattern(s) were not captured: ${failures.join('; ')}`
              : null,
          stop: null,
          warnings: [],
        }
      }
    }
  }
}
