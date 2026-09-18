/**
 * Scoring §4.4.1's shape detectors over a corpus (spec §11.1, §20.43).
 *
 * §20.40 scored the committed **semgrep** rule set and found 0.011 discrimination —
 * it fires on the shape and not on the defect. That raised the question this tier
 * exists to answer, and §20.40.6 names it as an open item: *nothing scores the
 * TOCTOU FSMs, the signal machine or patch mining this way.* Patch mining is the
 * project's designated recall investment (D5), it has a five-item shape taxonomy
 * with its own validation rule, and until now no number had ever been produced for
 * any of it.
 * This scores the five shape detectors, subject-free — the reading
 * `patchmine/shapes.ts` explicitly *rejects* for a sweep, on the argument that a
 * shape with no portable operation "would be shape-only and far too broad".
 *
 * ## Why the rejection is worth measuring rather than assuming
 *
 * That argument is a claim about precision, and §20.40's whole lesson is that a
 * claim about a detector is worth exactly as much as its number. There are also two
 * things the argument does not cover:
 *
 * 1. **Two of the five shapes cannot be swept subject-free at all.** `guard` and
 *    `lock` return `[]` when no operation is known, so on a checkout with no fix
 *    history — every new project, and most small ones — the patch-mined stage emits
 *    *nothing*. Not a weak signal: zero candidates. That is the recall question for
 *    the "less-popular codebase" case stated exactly.
 * 2. **Discrimination is not the only number, and for a *generator* it is not the
 *    first one.** §2.4's funnel assumes the raw static layer has a ~0.9
 *    false-positive rate and exists to be filtered by §4.6 and §5 — §4.3 says so in
 *    its own words ("judged by whether triage can cheaply discard what they
 *    surface, not by their raw precision"). So the question for a candidate
 *    generator is **containment**: of the functions that really contain a defect,
 *    how many did it put in front of the filter? That is `sensitivity` here, and
 *    §20.40's headline number (`discrimination`) is the *wrong* verdict to read a
 *    generator by. Both are printed, and the report says which is which.
 *
 * ## What it deliberately shares with the rule tier
 *
 * The same corpus, the same `scoreStage`, the same two-sided ground truth, the same
 * three honesty rules: a half with no verdict is `unscoreable` rather than
 * `cleared`; a stage that decided nothing reports `not-run` with its reason and
 * metrics of `null` rather than zero; and the per-shape table is printed beside the
 * aggregate, because the only actionable output is *which shapes fire at all*.
 *
 * The one structural difference is that **detection is injected**. The rule tier
 * injects execution because semgrep is a subprocess whose version moves the
 * numbers; this tier injects detection for a different reason — the sweep is a pure
 * function over text, so injecting it lets the tier be driven by a fixture, and
 * lets a figure stay comparable after the detectors change underneath it.
 */

import { detectAll } from '../patchmine/shapes'
import { FIX_SHAPES } from '../patchmine/types'

import { scoreStage } from './confusion'
import { halfKey, halfSource, RULE_HALVES } from './rule-tier'

import type { FixShape } from '../patchmine/types'
import type { Observation, StageMetrics } from './confusion'
import type { FunctionPair, PairSet } from './types'

/** Named so a report cannot confuse it with a model stage or with the rule tier. */
export const SHAPE_TIER_STAGE = 'shapes'

export const SHAPE_HALVES = RULE_HALVES

/** One half as the sweep sees it. */
export interface ShapeHalfInput {
  /** Stable identity, so a detector result can be tied back to a pair. */
  key: string
  /** The corpus path, for a report row. */
  filePath: string
  source: string
}

/**
 * What the sweep found in one half.
 *
 * `null` means no verdict, and it is not interchangeable with `[]`: an empty array
 * is a completed sweep that found nothing, and a `null` is a sweep that did not
 * happen. Collapsing the two is the §18 substitution this tier inherits from the
 * rule tier by design.
 */
export interface ShapeHalfOutcome {
  firedShapes: readonly FixShape[] | null
  /** How many sites were emitted, which is what a downstream filter has to eat. */
  findings?: number
  /** Why there is no verdict. Required when `firedShapes` is null. */
  failureReason?: string
}

/**
 * Run the sweep over one half.
 *
 * Synchronous, because the sweep is pure text work with no subprocess behind it —
 * which is also why this tier needs no engine, no provider and no network, and can
 * therefore run in the test suite where §20.40's rule tier cannot.
 */
export type ShapeDetector = (half: ShapeHalfInput) => ShapeHalfOutcome

/**
 * Every shape finding in a function, subject-free.
 *
 * The default detector. `detectAll` is called with an empty hint, which is the
 * subject-free reading: `null-check` uses the function's own pointer parameters,
 * `bounds-check` uses every identifier-indexed access, and `lifetime` uses every
 * release. `guard` and `lock` return nothing without an operation, and that is
 * reported rather than hidden — a shape that cannot fire shows as zero fires in the
 * per-shape table, exactly as §20.40 printed four rules that never fired.
 */
export const sweepShapes = (source: string): ShapeHalfOutcome => {
  const lines = source.split('\n')
  const fired: FixShape[] = []
  let findings = 0

  for (const shape of FIX_SHAPES) {
    const found = detectAll(lines, shape, {})
    if (found.length > 0) fired.push(shape)
    findings += found.length
  }

  return { firedShapes: fired, findings }
}

/** How one shape behaved across the corpus. Says which of them fire at all. */
export interface ShapeAttribution {
  shape: FixShape
  /** Halves known to contain the defect where it fired. */
  vulnerable: number
  /** Halves known to be fixed where it fired. */
  patched: number
}

/** What the sweep did with one pair, so the figure can be checked by hand. */
export interface ShapePairOutcome {
  pairId: string
  cve: string | null
  filePath: string | null
  vulnerableShapes: FixShape[]
  patchedShapes: FixShape[]
  /** Sites emitted on each half — the candidate volume a filter would receive. */
  vulnerableFindings: number
  patchedFindings: number
  verdict: 'discriminated' | 'missed' | 'false-alarm' | 'no-fire' | 'undecided'
}

export interface ShapeTierReport {
  corpus: string
  pairs: number
  metrics: StageMetrics
  shapes: ShapeAttribution[]
  outcomes: ShapePairOutcome[]
  unscoreable: number
  /** Sites the sweep emitted on each half across the whole corpus. */
  emitted: { vulnerable: number; patched: number }
  /** Shapes that cannot fire subject-free, named rather than left to be inferred. */
  inertShapes: FixShape[]
}

export interface RunShapeTierOptions {
  pairSet: PairSet
  detector: ShapeDetector
  log?: (line: string) => void
}

export const runShapeTier = (options: RunShapeTierOptions): ShapeTierReport => {
  const log = options.log ?? (() => {})

  const outcomes = new Map<string, ShapeHalfOutcome>()
  let emittedVulnerable = 0
  let emittedPatched = 0

  for (const pair of options.pairSet.pairs) {
    for (const half of SHAPE_HALVES) {
      const key = halfKey(pair.id, half)
      const result = options.detector({
        key,
        filePath: pair.filePath ?? `${pair.id}.c`,
        source: halfSource(pair, half),
      })
      outcomes.set(key, result)
      if (half === 'vulnerable') emittedVulnerable += result.findings ?? 0
      else emittedPatched += result.findings ?? 0
    }
  }

  const observations: Observation[] = []
  const fired = new Map<FixShape, ShapeAttribution>()
  let decided = 0
  let unscoreable = 0

  for (const pair of options.pairSet.pairs) {
    for (const half of SHAPE_HALVES) {
      const result = outcomes.get(halfKey(pair.id, half))

      if (result === undefined || result.firedShapes === null) {
        unscoreable += 1
        observations.push({
          pairId: pair.id,
          half,
          outcome: 'unscoreable',
          detail: result?.failureReason ?? 'the sweep produced no verdict for this half',
        })
        continue
      }

      decided += 1

      if (result.firedShapes.length === 0) {
        observations.push({
          pairId: pair.id,
          half,
          outcome: 'cleared',
          detail: 'no shape fired',
        })
        continue
      }

      const shapes = [...new Set(result.firedShapes)].sort()
      for (const shape of shapes) {
        const entry = fired.get(shape) ?? { shape, vulnerable: 0, patched: 0 }
        entry[half] += 1
        fired.set(shape, entry)
      }

      observations.push({
        pairId: pair.id,
        half,
        outcome: 'flagged',
        detail: `${shapes.join(', ')} fired`,
      })
    }
  }

  log(
    `[shapes] ${options.pairSet.pairs.length} pair(s): ${decided} half/halves decided, ` +
      `${unscoreable} without a verdict`,
  )

  const metrics =
    decided === 0
      ? scoreStage({
          stage: SHAPE_TIER_STAGE,
          label: 'patch-mined shape sweep',
          pairs: options.pairSet.pairs,
          observations: [],
          notRunReason:
            options.pairSet.pairs.length === 0
              ? 'the corpus has no pairs to score'
              : 'the sweep produced no verdict for any half, so nothing was measured',
        })
      : scoreStage({
          stage: SHAPE_TIER_STAGE,
          label: 'patch-mined shape sweep',
          pairs: options.pairSet.pairs,
          observations,
        })

  const shapesFor = (pairId: string, half: 'vulnerable' | 'patched'): FixShape[] | null => {
    const result = outcomes.get(halfKey(pairId, half))
    if (result === undefined || result.firedShapes === null) return null
    return [...new Set(result.firedShapes)].sort()
  }

  const pairOutcomes: ShapePairOutcome[] = options.pairSet.pairs.map((pair) => {
    const vulnerableShapes = shapesFor(pair.id, 'vulnerable')
    const patchedShapes = shapesFor(pair.id, 'patched')

    const verdict: ShapePairOutcome['verdict'] = (() => {
      if (vulnerableShapes === null || patchedShapes === null) return 'undecided'
      if (vulnerableShapes.length === 0) return 'no-fire'
      return patchedShapes.length === 0 ? 'discriminated' : 'false-alarm'
    })()

    return {
      pairId: pair.id,
      cve: pair.cve,
      filePath: pair.filePath,
      vulnerableShapes: vulnerableShapes ?? [],
      patchedShapes: patchedShapes ?? [],
      vulnerableFindings: outcomes.get(halfKey(pair.id, 'vulnerable'))?.findings ?? 0,
      patchedFindings: outcomes.get(halfKey(pair.id, 'patched'))?.findings ?? 0,
      verdict,
    }
  })

  // A shape with no fires anywhere is the same fact §20.40 reported for four rules,
  // and it is worth naming here for a sharper reason: `guard` and `lock` *cannot*
  // fire without an operation, so their zero is structural rather than empirical.
  // Reading it as "these detectors are weak" would be reading a design boundary as
  // a measurement.
  const inertShapes = FIX_SHAPES.filter((shape) => fired.get(shape) === undefined)

  return {
    corpus: options.pairSet.corpus,
    pairs: options.pairSet.pairs.length,
    metrics,
    shapes: [...fired.values()].sort(
      (left, right) =>
        right.vulnerable - left.vulnerable ||
        left.patched - right.patched ||
        left.shape.localeCompare(right.shape),
    ),
    outcomes: pairOutcomes,
    unscoreable,
    emitted: { vulnerable: emittedVulnerable, patched: emittedPatched },
    inertShapes,
  }
}
