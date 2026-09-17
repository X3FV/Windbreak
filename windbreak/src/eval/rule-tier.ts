/**
 * Scoring the rule set against a real corpus (spec §11.1).
 *
 * §11.1 already scores the **model stages** over function pairs, and §11.2 scores
 * the whole pipeline over repo snapshots. Neither answers the question a low
 * recall figure immediately raises: *is the thing that produced these candidates
 * any good?* Tier 2's raw row mixes the engines, patch mining, variant hunting
 * and OSV correlation together, so a good raw number there can be carried by a
 * stage that found the bug by correlation rather than by reading the code —
 * which is why §11.2 reports `discoveryRecall` beside `recall`.
 *
 * This tier isolates one instrument. Every half of every pair is handed to the
 * committed rule set, and the only thing recorded is whether a rule fired on it.
 * That makes the measurement two-sided by construction, like §11.1's:
 *
 * - a rule firing on the vulnerable half and not on the patched one has
 *   `discrimination` — it caught the defect *and* cleared the fix;
 * - a rule firing on both caught nothing, and is a false alarm;
 * - a rule firing on neither is recall loss.
 *
 * `discrimination` is the number to read first, and it is deliberately hard to
 * game: a rule set that fires on everything scores perfectly on the vulnerable
 * halves and zero here.
 *
 * **What a low figure does and does not mean.** The corpus is every CVE a project
 * chose to name in a commit message, so it samples the whole disclosed weakness
 * space. The committed rules test seven shapes (unbounded string ops, command
 * injection, format strings, allocation overflow, realloc aliasing, temp files,
 * weak randomness). A null dereference or an authorization error is real ground
 * truth here and is reachable by none of them, so a low number is partly "these
 * fixes were not that shape". The per-rule table is what separates the two: a
 * rule with no fires anywhere does not earn its place, and that is a different
 * fact from a corpus the rules were never aimed at.
 *
 * **Batching is not an optimization detail.** The engine runs once over every
 * half rather than once per half, because that is how §4.3 drives it in a real
 * scan — one process, many targets, one rule compilation. A tier that invoked it
 * 2×N times would measure a different machine, and would do it slowly enough
 * that nobody would re-run it.
 *
 * Execution is injected, so the tier can also be scored against recorded engine
 * output — which is how a measurement stays comparable after the engine version
 * changes underneath it, the same reasoning §8.4 applies to a verdict.
 */

import { scoreStage } from './confusion'

import type { Observation, StageMetrics } from './confusion'
import type { FunctionPair, PairSet } from './types'

/** §11.1's third instrument. Named so a report cannot confuse it with a model stage. */
export const RULE_TIER_STAGE = 'rules'

export const RULE_HALVES: ReadonlyArray<'vulnerable' | 'patched'> = ['vulnerable', 'patched']

/** One half as the engine sees it. */
export interface RuleHalfInput {
  /** Stable identity, so a batch result can be tied back to a pair. Opaque to the runner. */
  key: string
  /** The corpus path, used to choose a file extension the engine can read. */
  filePath: string
  source: string
}

/**
 * What the rule set said about one half.
 *
 * `firedRuleIds` is `null` exactly when the engine produced no verdict for it, and
 * that is not interchangeable with an empty array: an engine that failed must
 * never look like an engine that found nothing (§18, and the reason
 * `parseSemgrepOutput` warns rather than returning an empty result set).
 */
export interface RuleHalfOutcome {
  firedRuleIds: readonly string[] | null
  /** Why there is no verdict. Required when `firedRuleIds` is null. */
  failureReason?: string
}

export interface RuleBatchResult {
  /**
   * One entry per half the engine decided. A key the map does not carry is
   * treated as *no verdict for that half*, never as a clear — dropping a half
   * silently would shrink the denominator by exactly the halves the engine
   * choked on, which is the recall loss hiding itself.
   */
  outcomes: ReadonlyMap<string, RuleHalfOutcome>
  /**
   * Engine-level messages a reader needs before trusting the numbers: a partial
   * parse, a per-file timeout, a rule that failed to compile.
   *
   * Carried rather than logged, because a warning that appears only on the
   * operator's terminal is absent from the recorded figure, and the figure is
   * what gets compared across runs.
   */
  notes: readonly string[]
}

/** Run the rule set over every half at once. */
export type RuleBatchRunner = (
  halves: readonly RuleHalfInput[],
) => Promise<RuleBatchResult>

/** How one rule behaved across the corpus. Says which of them earn their place. */
export interface RuleAttribution {
  ruleId: string
  /** Pairs where it fired on the half known to contain the defect. */
  vulnerable: number
  /** Pairs where it fired on the half known to be fixed. Noise, when the fix was real. */
  patched: number
}

/** What the rule set did with one pair, so a reader can check the figure by hand. */
export interface RulePairOutcome {
  pairId: string
  cve: string | null
  filePath: string | null
  /** Rules that fired on the half containing the defect. */
  vulnerableRules: string[]
  /** Rules that fired on the half known to be fixed. */
  patchedRules: string[]
  /**
   * `discriminated` is the only outcome that counts as catching the defect;
   * `false-alarm` is a rule reacting to code the fix did not touch.
   */
  verdict: 'discriminated' | 'missed' | 'false-alarm' | 'no-fire' | 'undecided'
}

export interface RuleTierReport {
  corpus: string
  pairs: number
  metrics: StageMetrics
  rules: RuleAttribution[]
  /**
   * One row per pair, so `discrimination` is auditable rather than taken on trust.
   *
   * A rate of 0.011 is a claim about three pairs out of 267, and a number whose
   * evidence cannot be read is the same problem this tier exists to fix: a
   * figure produced by the person who wrote the rules, about the rules, with
   * nothing behind it to check.
   */
  outcomes: RulePairOutcome[]
  /** Halves the engine could not decide. In neither side of the matrix. */
  unscoreable: number
  /** What the engine said about the run itself. Empty when it said nothing. */
  engineNotes: string[]
}

export interface RunRuleTierOptions {
  pairSet: PairSet
  runBatch: RuleBatchRunner
  log?: (line: string) => void
}

export const halfKey = (pairId: string, half: 'vulnerable' | 'patched'): string =>
  `${pairId}\u0000${half}`

/** The text of one half. */
export const halfSource = (
  pair: FunctionPair,
  half: 'vulnerable' | 'patched',
): string => (half === 'vulnerable' ? pair.vulnerable : pair.patched)

export const runRuleTier = async (options: RunRuleTierOptions): Promise<RuleTierReport> => {
  const log = options.log ?? (() => {})

  const inputs: RuleHalfInput[] = []
  for (const pair of options.pairSet.pairs) {
    for (const half of RULE_HALVES) {
      inputs.push({
        key: halfKey(pair.id, half),
        filePath: pair.filePath ?? `${pair.id}.c`,
        source: halfSource(pair, half),
      })
    }
  }

  const batch =
    inputs.length === 0
      ? { outcomes: new Map<string, RuleHalfOutcome>(), notes: [] }
      : await options.runBatch(inputs)
  const outcomes = batch.outcomes

  const observations: Observation[] = []
  const fired = new Map<string, RuleAttribution>()
  let decided = 0
  let unscoreable = 0

  const bump = (ruleId: string, half: 'vulnerable' | 'patched'): void => {
    const entry = fired.get(ruleId) ?? { ruleId, vulnerable: 0, patched: 0 }
    entry[half] += 1
    fired.set(ruleId, entry)
  }

  for (const pair of options.pairSet.pairs) {
    for (const half of RULE_HALVES) {
      const key = halfKey(pair.id, half)
      const outcome = outcomes.get(key)

      if (outcome === undefined) {
        unscoreable += 1
        observations.push({
          pairId: pair.id,
          half,
          outcome: 'unscoreable',
          detail: 'the rule set reported no result for this half',
        })
        continue
      }

      if (outcome.firedRuleIds === null) {
        unscoreable += 1
        observations.push({
          pairId: pair.id,
          half,
          outcome: 'unscoreable',
          detail: outcome.failureReason ?? 'the rule set produced no verdict',
        })
        continue
      }

      decided += 1

      if (outcome.firedRuleIds.length === 0) {
        observations.push({ pairId: pair.id, half, outcome: 'cleared', detail: 'no rule fired' })
        continue
      }

      const ruleIds = [...new Set(outcome.firedRuleIds)].sort()
      for (const ruleId of ruleIds) bump(ruleId, half)

      observations.push({
        pairId: pair.id,
        half,
        outcome: 'flagged',
        detail: `${ruleIds.join(', ')} fired`,
      })
    }
  }

  log(
    `[rules] ${options.pairSet.pairs.length} pair(s): ${decided} half/halves decided, ` +
      `${unscoreable} without a verdict`,
  )

  // Every half failing is not a score of zero: it is a measurement that did not
  // happen, and §18 requires the two to stay distinguishable.
  const metrics =
    decided === 0
      ? scoreStage({
          stage: RULE_TIER_STAGE,
          label: 'detector rule set',
          pairs: options.pairSet.pairs,
          observations: [],
          notRunReason:
            options.pairSet.pairs.length === 0
              ? 'the corpus has no pairs to score'
              : 'the rule set produced no verdict for any half, so nothing was measured',
        })
      : scoreStage({
          stage: RULE_TIER_STAGE,
          label: 'detector rule set',
          pairs: options.pairSet.pairs,
          observations,
        })

  const rulesFor = (pairId: string, half: 'vulnerable' | 'patched'): string[] | null => {
    const outcome = outcomes.get(halfKey(pairId, half))
    if (outcome === undefined || outcome.firedRuleIds === null) return null
    return [...new Set(outcome.firedRuleIds)].sort()
  }

  const pairOutcomes: RulePairOutcome[] = options.pairSet.pairs.map((pair) => {
    const vulnerableRules = rulesFor(pair.id, 'vulnerable')
    const patchedRules = rulesFor(pair.id, 'patched')

    const verdict: RulePairOutcome['verdict'] = (() => {
      if (vulnerableRules === null || patchedRules === null) return 'undecided'
      if (vulnerableRules.length === 0) return 'no-fire'
      return patchedRules.length === 0 ? 'discriminated' : 'false-alarm'
    })()

    return {
      pairId: pair.id,
      cve: pair.cve,
      filePath: pair.filePath,
      vulnerableRules: vulnerableRules ?? [],
      patchedRules: patchedRules ?? [],
      verdict,
    }
  })

  return {
    corpus: options.pairSet.corpus,
    pairs: options.pairSet.pairs.length,
    metrics,
    rules: [...fired.values()].sort(
      (left, right) =>
        right.vulnerable - left.vulnerable ||
        left.patched - right.patched ||
        left.ruleId.localeCompare(right.ruleId),
    ),
    outcomes: pairOutcomes,
    unscoreable,
    engineNotes: [...batch.notes],
  }
}
