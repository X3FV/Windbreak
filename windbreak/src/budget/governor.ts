import { createHash } from 'crypto'
import readline from 'readline'

import {
  DEFAULT_STAGE_SHARES,
  DEFAULT_TOTAL_BUDGET_SECONDS,
  STAGES,
} from './types'

import type { Database } from 'bun:sqlite'
import type {
  BudgetAction,
  BudgetDeciderFn,
  BudgetEventRecord,
  BudgetOverrunRequest,
  StageName,
} from './types'

export interface StageSession {
  readonly stage: StageName
  readonly quotaSeconds: number
  elapsedSeconds(): number
  /** Milliseconds left in this stage's quota; 0 once it is spent. */
  remainingMs(): number
  /** True once this stage has spent its quota. */
  exhausted(): boolean
  /**
   * Milliseconds to allow the next work unit: whatever remains of the quota,
   * capped by the unit's own ceiling. Preventing overrun at the unit level is
   * cheaper than recovering from it: the sandbox kills the engine at this
   * limit, so a single slow engine cannot consume the stage.
   */
  allowMs(ceilingSeconds: number): number
}

export interface BudgetGovernor {
  readonly totalSeconds: number
  session(stage: StageName): StageSession
  quotaSeconds(stage: StageName): number
  /**
   * Ask what to do about a stage that has spent its quota, and record the
   * decision (spec §9.1).
   */
  resolveOverrun(stage: StageName, elapsedSeconds: number): Promise<BudgetAction>
  events(): BudgetEventRecord[]
}

export interface CreateBudgetGovernorOptions {
  /** Total seconds for the target. Defaults to §9's one hour. */
  totalSeconds?: number
  /** Overrides for the §9 shares. */
  shares?: Partial<Record<StageName, number>>
  /**
   * Seconds each stage already spent in an earlier invocation.
   *
   * `resume` needs this: quotas are computed from the *target's* total, so a
   * resumed run must continue a stage's clock rather than restart it — otherwise
   * every interruption would hand the stage a fresh share and the one-hour
   * target budget would mean nothing (spec §9).
   */
  initialElapsedSeconds?: Partial<Record<StageName, number>>
  db?: Database
  runId?: string | null
  /**
   * The decision function. Defaults to a TTY prompt, or to `degrade` when
   * stdin is not a TTY (spec §9.1: non-interactive never silently continues).
   */
  decide?: BudgetDeciderFn
  log?: (line: string) => void
  /** Injected for tests so elapsed time is deterministic. */
  now?: () => number
}

export const budgetEventId = (
  runId: string | null,
  stage: StageName,
  sequence: number,
): string =>
  `bud_${createHash('sha256')
    .update(`${runId ?? 'no-run'}:${stage}:${sequence}`)
    .digest('hex')
    .slice(0, 24)}`

/**
 * Build the overrun prompt.
 *
 * Returns `degrade` without asking whenever stdin is not a TTY, so a piped or
 * `--yes` run cannot hang waiting on input nobody will give.
 */
export const createInteractiveDecider = (
  options: {
    isTty?: boolean
    input?: NodeJS.ReadableStream
    output?: NodeJS.WritableStream
  } = {},
): BudgetDeciderFn => {
  const isTty = options.isTty ?? Boolean(process.stdin.isTTY)

  if (!isTty) {
    return async () => ({ action: 'degrade', decidedBy: 'policy:non-interactive' })
  }

  return async (request) => {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout

    const rl = readline.createInterface({ input, output })
    try {
      const answer = await new Promise<string>((resolve) => {
        output.write(
          `\n[budget] stage=${request.stage} elapsed=${formatSeconds(request.elapsedSeconds)} ` +
            `quota=${formatSeconds(request.quotaSeconds)}\n` +
            '  1) continue this stage  (extends the quota, borrowing from remaining stages)\n' +
            '  2) degrade              (skip this stage\'s remainder, continue the pipeline)\n' +
            '  3) abort                (keep partial results, stop)\n' +
            'choose [2]: ',
        )
        rl.question('', resolve)
      })

      const choice = answer.trim()
      if (choice === '1' || choice.toLowerCase() === 'continue') {
        return { action: 'continue', decidedBy: 'human' }
      }
      if (choice === '3' || choice.toLowerCase() === 'abort') {
        return { action: 'abort', decidedBy: 'human' }
      }
      return { action: 'degrade', decidedBy: 'human' }
    } finally {
      rl.close()
    }
  }
}

/** `--yes` and unattended runs degrade rather than continuing silently. */
export const createNonInteractiveDecider = (
  decidedBy: 'policy:--yes' | 'policy:unattended' = 'policy:--yes',
): BudgetDeciderFn => {
  return async () => ({ action: 'degrade', decidedBy })
}

export const formatSeconds = (seconds: number): string => {
  const rounded = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return minutes > 0 ? `${minutes}m${String(rest).padStart(2, '0')}s` : `${rest}s`
}

export const createBudgetGovernor = (
  options: CreateBudgetGovernorOptions = {},
): BudgetGovernor => {
  const totalSeconds = options.totalSeconds ?? DEFAULT_TOTAL_BUDGET_SECONDS
  const shares = { ...DEFAULT_STAGE_SHARES, ...options.shares }
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const decide = options.decide ?? createInteractiveDecider()
  const events: BudgetEventRecord[] = []

  const quotaSeconds = (stage: StageName): number =>
    Math.max(1, Math.round(totalSeconds * (shares[stage] ?? 0)))

  /** Wall-clock start per stage, for the part being spent in this invocation. */
  const stageStarts = new Map<StageName, number>()
  /** Elapsed time carried in from a previous invocation. */
  const carriedElapsed = { ...options.initialElapsedSeconds }

  const elapsedForStage = (stage: StageName): number => {
    const carried = carriedElapsed[stage] ?? 0
    const start = stageStarts.get(stage)
    if (start === undefined) return carried
    return carried + (now() - start) / 1000
  }

  return {
    totalSeconds,
    quotaSeconds,

    session(stage) {
      // First use of a stage starts its clock. A stage used twice shares one
      // quota rather than getting a second helping.
      if (!stageStarts.has(stage)) stageStarts.set(stage, now())

      const quota = quotaSeconds(stage)

      return {
        stage,
        quotaSeconds: quota,
        elapsedSeconds: () => elapsedForStage(stage),
        remainingMs: () =>
          Math.max(0, (quota - elapsedForStage(stage)) * 1000),
        exhausted: () => elapsedForStage(stage) >= quota,
        allowMs: (ceilingSeconds) =>
          Math.max(
            0,
            Math.min(
              (quota - elapsedForStage(stage)) * 1000,
              ceilingSeconds * 1000,
            ),
          ),
      }
    },

    async resolveOverrun(stage, elapsedSeconds) {
      const quota = quotaSeconds(stage)
      const consumed = Math.min(
        totalSeconds,
        STAGES.reduce(
          (acc, candidate) =>
            acc + (candidate === stage ? 0 : Math.min(elapsedForStage(candidate), quotaSeconds(candidate))),
          0,
        ) + Math.min(elapsedSeconds, quota),
      )

      const request: BudgetOverrunRequest = {
        stage,
        elapsedSeconds,
        quotaSeconds: quota,
        remainingTargetSeconds: Math.max(0, totalSeconds - consumed),
      }

      log(
        `[budget] stage=${stage} elapsed=${formatSeconds(elapsedSeconds)} quota=${formatSeconds(quota)}`,
      )

      const { action, decidedBy } = await decide(request)

      const record: BudgetEventRecord = {
        id: budgetEventId(options.runId ?? null, stage, events.length),
        runId: options.runId ?? null,
        stage,
        quotaSeconds: quota,
        elapsedSeconds: Math.round(elapsedSeconds),
        action,
        decidedBy,
        decidedAt: new Date(now()).toISOString(),
      }
      events.push(record)

      if (options.db && options.runId) {
        options.db
          .prepare(
            `INSERT OR REPLACE INTO budget_events
               (id, run_id, stage, quota_seconds, elapsed_seconds, action, decided_by, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.runId,
            record.stage,
            record.quotaSeconds,
            record.elapsedSeconds,
            record.action,
            record.decidedBy,
            record.decidedAt,
          )
      }

      log(`[budget] decision: ${action} (${decidedBy})`)
      return action
    },

    events: () => [...events],
  }
}
