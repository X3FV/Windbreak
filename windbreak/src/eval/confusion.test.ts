import { describe, expect, test } from 'bun:test'

import { composeObservations, scoreStage } from './confusion'

import type { HalfOutcome, Observation } from './confusion'
import type { FunctionPair } from './types'

const pair = (id: string): FunctionPair => ({
  id,
  project: 'p',
  cwe: null,
  cve: null,
  commitSha: null,
  fixCommit: null,
  vulnerable: `vulnerable-${id}`,
  patched: `patched-${id}`,
  filePath: null,
  note: null,
})

const pairs = (count: number): FunctionPair[] =>
  Array.from({ length: count }, (_, index) => pair(`p-${index + 1}`))

const observe = (
  outcomes: Array<[string, 'vulnerable' | 'patched', HalfOutcome]>,
): Observation[] =>
  outcomes.map(([pairId, half, outcome]) => ({
    pairId,
    half,
    outcome,
    detail: outcome === 'flagged' ? 'flagged-detail' : null,
  }))

const score = (observations: Observation[], pairList = pairs(1)) =>
  scoreStage({ stage: 'triage', label: 'triage', pairs: pairList, observations })

describe('scoreStage', () => {
  test('a stage that keeps everything has perfect sensitivity and no discrimination', () => {
    const metrics = score(observe([['p-1', 'vulnerable', 'flagged'], ['p-1', 'patched', 'flagged']]))

    expect(metrics.truePositives).toBe(1)
    expect(metrics.falsePositives).toBe(1)
    expect(metrics.sensitivity).toBe(1)
    expect(metrics.falseAlarmRate).toBe(1)
    expect(metrics.specificity).toBe(0)
    expect(metrics.precision).toBe(0.5)
    // The number that catches it: it kept the bug and the fix alike.
    expect(metrics.discrimination).toBe(0)
  })

  test('a stage that kills everything has perfect specificity and no sensitivity', () => {
    const metrics = score(observe([['p-1', 'vulnerable', 'cleared'], ['p-1', 'patched', 'cleared']]))

    expect(metrics.sensitivity).toBe(0)
    expect(metrics.falseAlarmRate).toBe(0)
    expect(metrics.discrimination).toBe(0)
    expect(metrics.precision).toBeNull()
    expect(metrics.f1).toBeNull()
  })

  test('a stage that distinguishes the bug from its fix scores everywhere', () => {
    const metrics = score(observe([['p-1', 'vulnerable', 'flagged'], ['p-1', 'patched', 'cleared']]))

    expect(metrics.truePositives).toBe(1)
    expect(metrics.trueNegatives).toBe(1)
    expect(metrics.sensitivity).toBe(1)
    expect(metrics.falseAlarmRate).toBe(0)
    expect(metrics.discrimination).toBe(1)
    expect(metrics.biasRatio).toBeNull()
  })

  test('an undecided half is in no side of the matrix', () => {
    // A provider outage must not read as "the stage called this clean".
    const metrics = score(observe([['p-1', 'vulnerable', 'flagged'], ['p-1', 'patched', 'unscoreable']]))

    expect(metrics.unscoreable).toBe(1)
    expect(metrics.trueNegatives).toBe(0)
    expect(metrics.falsePositives).toBe(0)
    // The denominator counts the pair, so a lost half lowers discrimination
    // rather than quietly raising specificity.
    expect(metrics.discrimination).toBe(0)
    expect(metrics.notes.join(' ')).toContain('in no side of the matrix')
  })

  test('rates the false-negative bias against the false-alarm rate', () => {
    // 2 of 4 bugs missed (FNR 0.5), 0 of 4 false alarms — undefined, not infinite.
    const missed = score(
      observe([
        ['p-1', 'vulnerable', 'cleared'],
        ['p-2', 'vulnerable', 'cleared'],
        ['p-3', 'vulnerable', 'flagged'],
        ['p-4', 'vulnerable', 'flagged'],
        ['p-1', 'patched', 'cleared'],
        ['p-2', 'patched', 'cleared'],
        ['p-3', 'patched', 'cleared'],
        ['p-4', 'patched', 'cleared'],
      ]),
      pairs(4),
    )

    expect(missed.sensitivity).toBe(0.5)
    expect(missed.falseAlarmRate).toBe(0)
    expect(missed.biasRatio).toBeNull()
    expect(missed.notes.join(' ')).toContain('undefined rather than infinite')

    // With one false alarm the ratio becomes real: FNR 0.5 over FPR 0.5 = 1x.
    const mixed = score(
      observe([
        ['p-1', 'vulnerable', 'cleared'],
        ['p-2', 'vulnerable', 'flagged'],
        ['p-1', 'patched', 'flagged'],
        ['p-2', 'patched', 'cleared'],
      ]),
      pairs(2),
    )
    expect(mixed.falseAlarmRate).toBe(0.5)
    expect(mixed.biasRatio).toBe(1)
  })

  test('flags the §15 failure shape: high precision with low sensitivity', () => {
    const metrics = score(
      observe([
        ['p-1', 'vulnerable', 'flagged'],
        ['p-2', 'vulnerable', 'cleared'],
        ['p-3', 'vulnerable', 'cleared'],
        ['p-4', 'vulnerable', 'cleared'],
        ['p-1', 'patched', 'cleared'],
        ['p-2', 'patched', 'cleared'],
        ['p-3', 'patched', 'cleared'],
        ['p-4', 'patched', 'cleared'],
      ]),
      pairs(4),
    )
    expect(metrics.precision).toBe(1)
    expect(metrics.sensitivity).toBe(0.25)
    expect(metrics.notes.join(' ')).toContain('high precision with low sensitivity')
  })

  test('a stage that did not answer carries no numbers', () => {
    const metrics = scoreStage({
      stage: 'verification',
      label: 'verification',
      pairs: pairs(3),
      observations: [],
      notRunReason: 'no half reached an outcome',
    })

    expect(metrics.status).toBe('not-run')
    expect(metrics.sensitivity).toBeNull()
    expect(metrics.falseAlarmRate).toBeNull()
    expect(metrics.discrimination).toBeNull()
    expect(metrics.truePositives).toBeNull()
    expect(metrics.byDetail).toEqual([])
  })

  test('reports the raw answer breakdown, so an aggregate is never the only view', () => {
    const metrics = score(
      observe([
        ['p-1', 'vulnerable', 'flagged'],
        ['p-2', 'vulnerable', 'flagged'],
        ['p-1', 'patched', 'cleared'],
        ['p-2', 'patched', 'cleared'],
      ]),
      pairs(2),
    )
    expect(metrics.byDetail).toEqual([{ detail: 'flagged-detail', count: 2 }])
  })
})

describe('composeObservations', () => {
  test('a half survives only if both stages kept it', () => {
    const composed = composeObservations(
      observe([['p-1', 'vulnerable', 'flagged'], ['p-1', 'patched', 'flagged']]),
      observe([['p-1', 'vulnerable', 'flagged'], ['p-1', 'patched', 'cleared']]),
    )

    const vulnerable = composed.find((entry) => entry.half === 'vulnerable')!
    const patched = composed.find((entry) => entry.half === 'patched')!

    expect(vulnerable.outcome).toBe('flagged')
    expect(patched.outcome).toBe('cleared')
  })

  test('a half triage cleared never reaches verification, so its verdict stands', () => {
    const composed = composeObservations(
      observe([['p-1', 'vulnerable', 'cleared']]),
      // Verification was driven over the half anyway; production would not have.
      observe([['p-1', 'vulnerable', 'flagged']]),
    )
    expect(composed[0]!.outcome).toBe('cleared')
  })

  test('the composed detail is a chain only where a hand-off happens', () => {
    const [cleared, chained] = composeObservations(
      observe([
        ['p-1', 'vulnerable', 'cleared'],
        ['p-1', 'patched', 'flagged'],
      ]),
      observe([
        ['p-1', 'vulnerable', 'flagged'],
        ['p-1', 'patched', 'flagged'],
      ]),
    )

    // Reporting a chain here would read as if the verifier had confirmed a half
    // the triager killed, describing a transition the pipeline never performs.
    expect(cleared!.detail).toBeNull()
    expect(chained!.detail).toContain('→')
  })

  test('a verification with no answer leaves the composed verdict unscoreable, not cleared', () => {
    // Reading a failed call as a kill would turn an outage into a
    // better-looking pipeline.
    const composed = composeObservations(
      observe([['p-1', 'vulnerable', 'flagged']]),
      observe([['p-1', 'vulnerable', 'unscoreable']]),
    )
    expect(composed[0]!.outcome).toBe('unscoreable')
  })

  test('a half with no verification observation is unscoreable, so the stage row decides not-run', () => {
    // The composed *stage* has no numbers when verification never answered; that
    // is `scoreStage`'s notRunReason, not a per-half verdict. A half here is
    // unscoreable rather than cleared, which is the safe direction.
    const composed = composeObservations(observe([['p-1', 'vulnerable', 'flagged']]), [])
    expect(composed[0]!.outcome).toBe('unscoreable')
  })
})
