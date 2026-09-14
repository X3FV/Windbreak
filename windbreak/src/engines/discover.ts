import path from 'path'

import { IGNORED_DIRECTORIES } from '../recon/inventory'
import { normalizeFindings } from './normalize'
import { persistCandidates } from './persist'
import { buildSemgrepArgv, DEFAULT_SEMGREP_JOBS } from './semgrep'
import { runEngine } from './run'

import type { Database } from 'bun:sqlite'
import type { BudgetGovernor } from '../budget'
import type { DetectOptions } from '../sandbox/backends'
import type { SandboxSpawn } from '../sandbox/run'
import type { SandboxBackendName } from '../sandbox/types'
import type {
  Candidate,
  EngineExecution,
  EngineInvocation,
  EngineUnavailable,
  ResolvedEngine,
  RunEnginesResult,
} from './types'

/** Per-engine wall-clock ceiling, capped again by the stage's remaining quota. */
export const DEFAULT_ENGINE_CAP_SECONDS = 600
/** Below this, starting an engine is pointless — it would be killed mid-scan. */
export const MIN_ENGINE_SECONDS = 5

/**
 * What the engine sweep is asked to run — all of it JSON (§20.17.3).
 *
 * This is the stage where the split earns its keep, because the serializable and
 * the host fields are interleaved rather than grouped: `runId` and `scratchDir`
 * are strings sitting between `unavailable` (a plain array of records) and
 * `governor` (a live object). A positional or name-based heuristic would have to
 * get all of those right; `JsonCompatible` gets them right by asking what they
 * actually are.
 */
export interface DiscoverRequest {
  /** Target checkout root. */
  targetRoot: string
  targetId: string
  commitSha: string
  /** Engines resolved host-side by `prepare`, already fail-closed checked. */
  engines: readonly ResolvedEngine[]
  /** Engine rule paths on the host; bound read-only at the same location. */
  rulePaths: readonly string[]
  /** Extra rule paths, e.g. from config. */
  extraRulePaths?: readonly string[]
  /** Engines recognized by the spec but not driven; recorded, not hidden. */
  unavailable?: readonly EngineUnavailable[]
  runId?: string
  scratchDir?: string
  engineCapSeconds?: number
  excludedDirectories?: readonly string[]
  jobs?: number
  timeoutSeconds?: number
  preferredBackend?: SandboxBackendName
}

/** What the engine sweep needs from the host — none of it serializable. */
export interface DiscoverServices {
  db?: Database
  governor?: BudgetGovernor
  detect?: DetectOptions
  spawn?: SandboxSpawn
  log?: (line: string) => void
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type DiscoverOptions = DiscoverRequest & DiscoverServices

/**
 * Build the invocation for one engine.
 *
 * The target is passed as `.` with the checkout as the working directory, so
 * engine-reported paths come back relative to the target root — which is what
 * `candidates.file_path` and every downstream stage expect.
 */
export const buildInvocation = (
  engine: ResolvedEngine,
  options: Pick<
    DiscoverOptions,
    | 'rulePaths'
    | 'extraRulePaths'
    | 'excludedDirectories'
    | 'jobs'
    | 'timeoutSeconds'
  >,
  timeLimitSeconds: number,
): EngineInvocation => {
  if (engine.engine === 'semgrep') {
    return {
      engine: 'semgrep',
      argv: buildSemgrepArgv({
        rulePaths: options.rulePaths,
        extraRulePaths: options.extraRulePaths ?? [],
        targetPaths: ['.'],
        excludedDirectories: options.excludedDirectories ?? [
          ...IGNORED_DIRECTORIES,
        ],
        ...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
        ...(options.timeoutSeconds !== undefined
          ? { timeoutSeconds: options.timeoutSeconds }
          : {}),
      }),
      workingDirectory: '.',
      timeLimitSeconds,
    }
  }

  throw new Error(`No invocation builder for engine "${engine.engine}"`)
}

/**
 * Run the baseline engines (spec §4.3).
 *
 * Engines are the wide net, not the catch. This stage does not rank, filter, or
 * judge: it produces normalized candidates and hands them to triage, and it
 * records every engine that could not run so a thin net is visible rather than
 * mistaken for a clean target.
 */
export const runBaselineEngines = async (
  options: DiscoverOptions,
): Promise<RunEnginesResult> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []
  const executions: EngineExecution[] = []
  const unavailable: EngineUnavailable[] = [...(options.unavailable ?? [])]
  const engineCapSeconds = options.engineCapSeconds ?? DEFAULT_ENGINE_CAP_SECONDS

  const scratchDir =
    options.scratchDir ??
    path.join(process.cwd(), '.windbreak', 'scratch', 'engines')

  const session = options.governor?.session('static-core') ?? null
  let stoppedBy: RunEnginesResult['stoppedBy'] = null

  const allFindings: Candidate[] = []

  for (const engine of options.engines) {
    // Budget is checked *before* starting an engine, and the engine's own
    // ceiling is the stage's remaining quota. That way one slow engine cannot
    // consume the stage and the human is asked before, not after.
    let timeLimitSeconds = Math.min(engineCapSeconds, Number.MAX_SAFE_INTEGER)

    if (session) {
      if (session.exhausted() || session.remainingMs() < MIN_ENGINE_SECONDS * 1000) {
        const action = await options.governor!.resolveOverrun(
          'static-core',
          session.elapsedSeconds(),
        )
        if (action !== 'continue') {
          stoppedBy = action === 'abort' ? 'budget-abort' : 'budget-degrade'
          warnings.push(
            `Static core stopped at the budget governor's ${action} decision; ` +
              `${options.engines.length - executions.length} engine(s) did not run.`,
          )
          break
        }
      }
      timeLimitSeconds = Math.max(
        MIN_ENGINE_SECONDS,
        Math.floor(session.allowMs(engineCapSeconds) / 1000),
      )
    }

    const invocation = buildInvocation(engine, options, timeLimitSeconds)
    log(
      `[engines] ${engine.engine} (limit ${timeLimitSeconds}s): ${invocation.argv.join(' ')}`,
    )

    const execution = await runEngine({
      engine,
      invocation,
      checkoutDir: options.targetRoot,
      scratchDir,
      extraReadOnlyBinds: options.rulePaths.map((rulePath) => ({
        source: rulePath,
        dest: rulePath,
      })),
      ...(options.preferredBackend ? { preferredBackend: options.preferredBackend } : {}),
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    })

    executions.push(execution)
    warnings.push(...execution.warnings)

    const normalized = normalizeFindings(execution.findings, {
      runId: options.runId ?? 'unpersisted',
      targetRoot: options.targetRoot,
    })

    if (normalized.unresolvedSlices > 0) {
      warnings.push(
        `${engine.engine}: ${normalized.unresolvedSlices} finding(s) could not be tied to readable ` +
          'source; their slice hash is absent.',
      )
    }
    if (normalized.duplicates > 0) {
      warnings.push(
        `${engine.engine}: dropped ${normalized.duplicates} duplicate finding(s)`,
      )
    }

    allFindings.push(...normalized.candidates)
    log(
      `[engines] ${engine.engine}: ${normalized.candidates.length} candidate(s) in ${execution.durationMs}ms`,
    )
  }

  if (options.db && options.runId) {
    const persisted = persistCandidates({
      db: options.db,
      runId: options.runId,
      candidates: allFindings,
    })
    log(`[engines] persisted ${persisted.inserted} candidate(s)`)
  }

  return {
    executions,
    candidates: allFindings,
    unavailable,
    enginesAttempted: executions.length,
    warnings,
    stoppedBy,
  }
}
