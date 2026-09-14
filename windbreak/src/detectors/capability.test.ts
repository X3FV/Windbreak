import { describe, expect, test } from 'bun:test'

import {
  ALL_DETECTOR_IDS,
  DETECTOR_CAPABILITIES,
  DETECTOR_IDS,
  detectorCapability,
  detectorsForLanguage,
  detectorsMissingFor,
  languageFilterSql,
  languagesForDetectors,
} from './capability'

import type { DetectorCapability, DetectorId } from './capability'

/**
 * A matrix whose detectors *diverge*, which the shipped one does not.
 *
 * This is the shape the module exists for: one detector has grown a language the others
 * have not. Every partial-coverage behaviour is only reachable through a matrix like this,
 * so testing it against the shipped list would leave the new branches unrun.
 */
const DIVERGENT: readonly DetectorCapability[] = [
  { id: 'patch-shape', label: 'shapes', languages: ['c', 'cpp', 'java'] },
  { id: 'toctou', label: 'fsms', languages: ['c', 'cpp'] },
  { id: 'signal-handler', label: 'signals', languages: ['c', 'cpp'] },
]

describe('the detector capability matrix', () => {
  test('every detector id has a row, a label and at least one language', () => {
    // A detector with no row is one whose languages cannot be asked for, and the
    // `detectorCapability` guard would throw at the first sweep that ran it. Asserting
    // the shape here makes a half-added detector fail in a test rather than in a scan.
    expect([...DETECTOR_CAPABILITIES.map((capability) => capability.id)].sort()).toEqual(
      [...DETECTOR_IDS].sort(),
    )
    for (const capability of DETECTOR_CAPABILITIES) {
      expect(capability.label.length).toBeGreaterThan(0)
      expect(capability.languages.length).toBeGreaterThan(0)
    }
  })

  test('ALL_DETECTOR_IDS is the ids in declaration order, not a second list', () => {
    expect(ALL_DETECTOR_IDS).toEqual([...DETECTOR_IDS])
  })

  test('an unknown detector throws rather than sweeping nothing', () => {
    // The failure this prevents: a widened `DetectorId` whose row was forgotten would
    // otherwise produce an empty language set and a `0 = 1` filter — a sweep that runs,
    // reports success, and reads nothing.
    //
    // Deliberately outside the union; that is the case being guarded.
    expect(() => detectorCapability('nope' as DetectorId)).toThrow('unknown detector')
  })
})

describe('languagesForDetectors', () => {
  test('unions and sorts, so one language cannot appear twice', () => {
    expect(languagesForDetectors(['patch-shape', 'signal-handler'])).toEqual(['c', 'cpp'])
  })

  test('an empty detector set covers nothing, rather than everything', () => {
    expect(languagesForDetectors([])).toEqual([])
  })

  test('a language on one detector is in the union', () => {
    expect(languagesForDetectors(['patch-shape'], DIVERGENT)).toEqual([
      'c',
      'cpp',
      'java',
    ])
    // The other detectors have not grown java, so the union over all of them is the
    // same set — a language is not added to a detector by being added to another.
    expect(
      languagesForDetectors(['patch-shape', 'toctou', 'signal-handler'], DIVERGENT),
    ).toEqual(['c', 'cpp', 'java'])
  })
})

describe('languageFilterSql', () => {
  test('generates the predicate from the detectors it is given', () => {
    expect(languageFilterSql(['patch-shape'])).toBe("language IN ('c', 'cpp')")
  })

  test('an empty detector set is `0 = 1`, never an empty IN list', () => {
    // `IN ()` is a syntax error, so a detector set that covers nothing would fail the
    // whole stage instead of returning no rows. The predicate has to *mean* nothing.
    const sql = languageFilterSql([], [
      { id: 'patch-shape', label: 'shapes', languages: [] },
    ])
    expect(sql).toBe('0 = 1')
    expect(sql).not.toContain('IN ()')
  })

  test('the generated predicate is what the divergence produces', () => {
    expect(languageFilterSql(['patch-shape'], DIVERGENT)).toBe(
      "language IN ('c', 'cpp', 'java')",
    )
  })
})

describe('detectorsForLanguage / detectorsMissingFor', () => {
  test('ship the same answer today, because every detector is C and C++', () => {
    expect(detectorsForLanguage('c')).toEqual([...DETECTOR_IDS])
    expect(detectorsMissingFor('c')).toEqual([])
    expect(detectorsForLanguage('cpp')).toEqual([...DETECTOR_IDS])
  })

  test('a language no detector covers is missing all of them, not unknown', () => {
    // The distinction the coverage report rests on: `unknown` here means "no tables",
    // which is a counted fact, not an absent one.
    expect(detectorsForLanguage('python')).toEqual([])
    expect(detectorsMissingFor('python')).toEqual([...DETECTOR_IDS])
    expect(detectorsForLanguage('unknown')).toEqual([])
  })

  test('a partly-covered language names exactly the detectors it lacks', () => {
    expect(detectorsForLanguage('java', DIVERGENT)).toEqual(['patch-shape'])
    expect(detectorsMissingFor('java', DIVERGENT)).toEqual(['toctou', 'signal-handler'])
  })

  test('the two lists partition the matrix, whatever the matrix is', () => {
    for (const language of ['c', 'java', 'python']) {
      const covering = detectorsForLanguage(language, DIVERGENT)
      const missing = detectorsMissingFor(language, DIVERGENT)
      expect([...covering, ...missing].sort()).toEqual([...DETECTOR_IDS].sort())
    }
  })
})
