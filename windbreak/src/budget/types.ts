/**
 * Budget governor types (spec §9).
 *
 * The governor exists because the target budget is the scarce resource, not
 * model spend: enough quota must survive to reach verification, which is where
 * the MVP bar (§11) is actually decided.
 */

export const STAGES = [
  'ingestion',
  'static-core',
  'triage',
  'verification',
  'reporting',
] as const

export type StageName = (typeof STAGES)[number]

/**
 * Default shares, applied to the total target budget. §9 makes these
 * percentages a default, not an invariant — every one is configurable (D14).
 */
export const DEFAULT_STAGE_SHARES: Record<StageName, number> = {
  ingestion: 0.1,
  'static-core': 0.25,
  triage: 0.1,
  verification: 0.4,
  reporting: 0.15,
}

/** §9's default: one hour per target, single laptop. */
export const DEFAULT_TOTAL_BUDGET_SECONDS = 3600

export type BudgetAction = 'continue' | 'degrade' | 'abort'

export const BUDGET_ACTIONS: readonly BudgetAction[] = [
  'continue',
  'degrade',
  'abort',
]

/** Who made the call, recorded so a run can be audited after the fact. */
export type BudgetDecider =
  | 'human'
  | 'policy:--yes'
  | 'policy:non-interactive'
  | 'policy:unattended'

export interface BudgetOverrunRequest {
  stage: StageName
  elapsedSeconds: number
  quotaSeconds: number
  /** Remaining seconds across the whole target, after this stage. */
  remainingTargetSeconds: number
}

export type BudgetDeciderFn = (
  request: BudgetOverrunRequest,
) => Promise<{ action: BudgetAction; decidedBy: BudgetDecider }>

export interface BudgetEventRecord {
  id: string
  runId: string | null
  stage: StageName
  quotaSeconds: number
  elapsedSeconds: number
  action: BudgetAction
  decidedBy: BudgetDecider
  decidedAt: string
}
