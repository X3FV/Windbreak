/**
 * Scoring a labelled corpus (spec §11.1, §15).
 *
 * Tier 2's funnel counts candidates against seeded sites, which is a *discovery*
 * question. A function-level corpus asks a *classification* question instead,
 * and the ground truth is two-sided by construction: the vulnerable half is a
 * bug, the patched half is the same function with that bug fixed. So the output
 * is a 2×2 and the metrics that follow from it.
 *
 * The metric that matters most here is not accuracy. §15 records the finding
 * that drives §5: detection collapses by up to 93% under benign framing, and the
 * false-negative bias is roughly 114× the false-positive bias. A stage can score
 * beautifully on precision by killing everything, and that failure is invisible
 * in a single number — so `biasRatio` (false-negative rate over false-alarm
 * rate) is reported alongside, and `discrimination` measures the pair directly:
 * did this stage keep the bug **and** clear the fix?
 *
 * A third bucket exists because the binary one would lie. A call that fails, or
 * a half the stage was never given, is neither `flagged` nor `cleared`: counting
 * a provider outage as a negative prediction would report a perfect
 * false-alarm rate for a stage that answered nothing (§18).
 */

import type { FunctionPair } from './types'

/** What a stage decided about one half of a pair. */
export type HalfOutcome =
  /** The stage kept it: triage `likely-real`/`needs-context`, verification not `dropped`. */
  | 'flagged'
  /** The stage killed it: triage `likely-noise`, verification `dropped`. */
  | 'cleared'
  /** The stage was driven and produced no decision for this half. */
  | 'unscoreable'
  /** The stage was never driven at all. */
  | 'not-run'

export interface Observation {
  pairId: string
  half: 'vulnerable' | 'patched'
  outcome: HalfOutcome
  /**
   * The raw answer, so a misleading aggregate stays visible: the triage label,
   * the verification disposition, or why no answer exists.
   */
  detail: string | null
}

export type Tier1Stage = 'triage' | 'verification' | 'combined'

/**
 * One stage's result over a corpus.
 *
 * Every metric is nullable for the same reason Tier 2's rows are: a stage that
 * did not run has no numbers, and a zero would say it ran and cleared
 * everything.
 */
export interface StageMetrics {
  stage: Tier1Stage
  label: string
  status: 'scored' | 'not-run'
  reason: string | null
  /** Pairs in the corpus. The recall and discrimination denominators. */
  pairs: number
  /** Vulnerable halves the stage kept. */
  truePositives: number | null
  /** Vulnerable halves the stage killed — the recall loss. */
  falseNegatives: number | null
  /** Patched halves the stage flagged — noise on code that has no bug. */
  falsePositives: number | null
  /** Patched halves the stage cleared. */
  trueNegatives: number | null
  /** Halves the stage was given but could not decide. In no side of the matrix. */
  unscoreable: number | null
  /** Halves the stage was never given. */
  notRun: number | null
  /** TP / (TP + FN): of the real bugs, how many were kept. */
  sensitivity: number | null
  /** FP / (FP + TN): of the fixed functions, how many were still called bugs. */
  falseAlarmRate: number | null
  /** TN / (FP + TN). */
  specificity: number | null
  /** TP / (TP + FP). */
  precision: number | null
  f1: number | null
  /**
   * The §11.1 headline: the share of pairs the stage kept the bug **and** cleared
   * the fix on. Unlike sensitivity alone, this cannot be earned by flagging
   * everything.
   */
  discrimination: number | null
  /**
   * False-negative rate over false-alarm rate — §15's asymmetry, and the number
   * that exposes an over-suppressing stage.
   *
   * `null` when there are no false alarms at all: a ratio against zero is
   * undefined, and reporting `Infinity` would read as catastrophic bias when the
   * stage may simply be excellent. The report says which it is.
   */
  biasRatio: number | null
  /** The raw answer breakdown, so an aggregate is never the only thing shown. */
  byDetail: Array<{ detail: string; count: number }>
  notes: string[]
}

/** A `flagged` verdict is one where the stage kept the half. */
export const isFlagged = (outcome: HalfOutcome): boolean => outcome === 'flagged'
export const isCleared = (outcome: HalfOutcome): boolean => outcome === 'cleared'

const safeRatio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator

/**
 * Score one stage's observations over a corpus.
 *
 * `pairs` is the corpus rather than a count so the denominator and the
 * discrimination figure are computed from the same object: a pair that lost a
 * half to an unscoreable call still counts once in the denominator and never in
 * the numerator, which is the conservative direction for a recall-first bar.
 */
export const scoreStage = (input: {
  stage: Tier1Stage
  label: string
  pairs: readonly FunctionPair[]
  observations: readonly Observation[]
  /** Why the stage has no numbers. Set when it was never driven. */
  notRunReason?: string | null
}): StageMetrics => {
  const byKey = new Map<string, HalfOutcome>()
  const details = new Map<string, number>()

  for (const observation of input.observations) {
    byKey.set(`${observation.pairId}:${observation.half}`, observation.outcome)
    if (observation.detail !== null) {
      details.set(observation.detail, (details.get(observation.detail) ?? 0) + 1)
    }
  }

  const notRunReason = input.notRunReason ?? null
  const notes: string[] = []

  if (notRunReason !== null) {
    return {
      stage: input.stage,
      label: input.label,
      status: 'not-run',
      reason: notRunReason,
      pairs: input.pairs.length,
      truePositives: null,
      falseNegatives: null,
      falsePositives: null,
      trueNegatives: null,
      unscoreable: null,
      notRun: null,
      sensitivity: null,
      falseAlarmRate: null,
      specificity: null,
      precision: null,
      f1: null,
      discrimination: null,
      biasRatio: null,
      byDetail: [],
      notes: [],
    }
  }

  let truePositives = 0
  let falseNegatives = 0
  let falsePositives = 0
  let trueNegatives = 0
  let unscoreable = 0
  let notRun = 0
  let discriminated = 0

  for (const pair of input.pairs) {
    const vulnerable = byKey.get(`${pair.id}:vulnerable`) ?? 'not-run'
    const patched = byKey.get(`${pair.id}:patched`) ?? 'not-run'

    for (const outcome of [vulnerable, patched]) {
      if (outcome === 'unscoreable') unscoreable += 1
      if (outcome === 'not-run') notRun += 1
    }

    if (vulnerable === 'flagged') truePositives += 1
    else if (vulnerable === 'cleared') falseNegatives += 1

    if (patched === 'flagged') falsePositives += 1
    else if (patched === 'cleared') trueNegatives += 1

    if (vulnerable === 'flagged' && patched === 'cleared') discriminated += 1
  }

  const sensitive = truePositives + falseNegatives
  const specific = falsePositives + trueNegatives
  const positive = truePositives + falsePositives

  const sensitivity = safeRatio(truePositives, sensitive)
  const falseAlarmRate = safeRatio(falsePositives, specific)
  const precision = safeRatio(truePositives, positive)
  const f1 =
    precision === null || sensitivity === null || precision + sensitivity === 0
      ? null
      : (2 * precision * sensitivity) / (precision + sensitivity)

  const falseNegativeRate = safeRatio(falseNegatives, sensitive)
  const biasRatio =
    falseNegativeRate === null || falseAlarmRate === null || falseAlarmRate === 0
      ? null
      : falseNegativeRate / falseAlarmRate

  if (unscoreable > 0) {
    notes.push(
      `${unscoreable} half/halves produced no decision and are in no side of the ` +
        'matrix: a call that failed is not a prediction that the code is clean (§18)',
    )
  }

  if (notRun > 0) {
    notes.push(`${notRun} half/halves were never given to this stage`)
  }

  if (falseAlarmRate === 0 && falsePositives === 0 && specific > 0) {
    notes.push(
      'no false alarms at all, so the false-negative/false-alarm ratio is undefined ' +
        'rather than infinite',
    )
  }

  if (sensitivity !== null && sensitivity < 0.5 && precision !== null && precision > 0.9) {
    notes.push(
      'high precision with low sensitivity is the §15 failure mode: the stage may be ' +
        'suppressing findings rather than judging them',
    )
  }

  return {
    stage: input.stage,
    label: input.label,
    status: 'scored',
    reason: null,
    pairs: input.pairs.length,
    truePositives,
    falseNegatives,
    falsePositives,
    trueNegatives,
    unscoreable,
    notRun,
    sensitivity,
    falseAlarmRate,
    specificity: safeRatio(trueNegatives, specific),
    precision,
    f1,
    discrimination: safeRatio(discriminated, input.pairs.length),
    biasRatio,
    byDetail: [...details.entries()]
      .map(([detail, count]) => ({ detail, count }))
      .sort((left, right) => right.count - left.count || left.detail.localeCompare(right.detail)),
    notes,
  }
}

/**
 * Compose two stages into the outcome the pipeline would actually produce.
 *
 * A half is flagged only if **both** stages kept it, so this is the shipping
 * behaviour rather than either stage's own ability: verification never sees a
 * half that triage cleared. That distinction is why the report shows the stage
 * rows and this one separately — a strong verifier behind a recall-killing
 * triager produces bad production numbers, and only side-by-side rows make that
 * visible.
 */
export const composeObservations = (
  triage: readonly Observation[],
  verification: readonly Observation[],
): Observation[] => {
  const verificationByKey = new Map<string, Observation>()
  for (const observation of verification) {
    verificationByKey.set(`${observation.pairId}:${observation.half}`, observation)
  }

  return triage.map((observation) => {
    const later = verificationByKey.get(`${observation.pairId}:${observation.half}`)

    // A half triage cleared never reaches verification, so triage's `cleared`
    // stands. A half triage kept needs verification to have kept it as well —
    // and a verification that produced no decision leaves the composed verdict
    // **unscoreable**, not cleared. Reading a failed call as a kill would turn a
    // provider outage into a better-looking pipeline.
    const outcome: HalfOutcome = (() => {
      if (observation.outcome !== 'flagged') return observation.outcome
      if (later === undefined) return 'unscoreable'
      if (later.outcome === 'flagged') return 'flagged'
      if (later.outcome === 'cleared') return 'cleared'
      return later.outcome
    })()

    // The detail is a chain only where a hand-off actually happens. A half
    // triage cleared is never seen by verification in production, so reporting
    // "likely-noise → confirmed" would describe a transition the pipeline does
    // not perform — and would read as if the verifier had confirmed a half the
    // triager killed.
    const detail =
      observation.outcome === 'flagged'
        ? `${observation.detail ?? 'kept'} → ${later?.detail ?? 'not run'}`
        : observation.detail

    return {
      pairId: observation.pairId,
      half: observation.half,
      outcome,
      detail,
    }
  })
}
