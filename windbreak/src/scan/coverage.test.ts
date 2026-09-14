import { beforeEach, describe, expect, test } from 'bun:test'

import { formatLanguageCoverage, readLanguageCoverage } from './coverage'
import { SCAN_TARGET_ID, scanDatabase, seedScanTarget } from './test-support'

import type { Database } from 'bun:sqlite'
import type { DetectorCapability, DetectorId } from '../detectors/capability'
import type { LanguageCoverage, LanguageCoverageEntry } from './coverage'

let db: Database

/**
 * The shipped matrix, written out.
 *
 * Hard-coded rather than imported from `DETECTOR_IDS`: if a detector is added, these
 * assertions should fail and make someone decide what the new one does to coverage,
 * instead of the test following the code into whatever it now says.
 */
const ALL_DETECTORS: DetectorId[] = ['patch-shape', 'toctou', 'signal-handler']

const seedSymbol = (input: {
  name: string
  language: string
  kind?: string
}): void => {
  const kind = input.kind ?? 'function'
  db.prepare(
    `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
     VALUES (?, ?, ?, ?, NULL, ?, 1, 2, ?)`,
  ).run(
    `${input.language}:${kind}:${input.name}`,
    SCAN_TARGET_ID,
    `src/${input.name}`,
    input.name,
    kind,
    input.language,
  )
}

/** An entry for a language every detector covers. */
const sweptEntry = (language: string, callables: number): LanguageCoverageEntry => ({
  language,
  callables,
  detectors: [...ALL_DETECTORS],
  missingDetectors: [],
  swept: true,
})

/** An entry for a language no detector covers. */
const unsweptEntry = (language: string, callables: number): LanguageCoverageEntry => ({
  language,
  callables,
  detectors: [],
  missingDetectors: [...ALL_DETECTORS],
  swept: false,
})

beforeEach(() => {
  db = scanDatabase()
  seedScanTarget({ db })
})

describe('readLanguageCoverage', () => {
  test('partitions the model into swept and unswept callables by language', () => {
    // The pin's cost, as a number: a target that is mostly Python reports mostly
    // unswept, which is the honest reading of a near-empty candidate list.
    seedSymbol({ name: 'a', language: 'c' })
    seedSymbol({ name: 'b', language: 'c' })
    seedSymbol({ name: 'c', language: 'c' })
    seedSymbol({ name: 'd', language: 'python', kind: 'method' })
    seedSymbol({ name: 'e', language: 'python', kind: 'method' })
    seedSymbol({ name: 'f', language: 'rust' })

    const coverage = readLanguageCoverage(db, SCAN_TARGET_ID)

    expect(coverage.sweptCallables).toBe(3)
    expect(coverage.partiallySweptCallables).toBe(0)
    expect(coverage.unsweptCallables).toBe(3)
    // The detectors are named on the entry, not only counted, so a reader can tell
    // *which* ones read the language rather than trusting a boolean.
    expect(coverage.languages).toEqual([
      sweptEntry('c', 3),
      unsweptEntry('python', 2),
      unsweptEntry('rust', 1),
    ])
    db.close()
  })

  test('counts callables only, so containers are not reported as swept regions', () => {
    // `symbols` holds classes, structs and modules too, and none of them is a
    // region a sweep walks. Counting them would make a Python repo look partly
    // covered when nothing in it was looked at.
    seedSymbol({ name: 'only_fn', language: 'c' })
    for (const name of ['A', 'B', 'C', 'D']) {
      seedSymbol({ name, language: 'python', kind: 'class' })
    }

    const coverage = readLanguageCoverage(db, SCAN_TARGET_ID)

    expect(coverage.sweptCallables).toBe(1)
    expect(coverage.unsweptCallables).toBe(0)
    expect(coverage.languages).toEqual([sweptEntry('c', 1)])
    db.close()
  })

  test('orders by callable count, then language, so the line is deterministic', () => {
    // Python is inserted first and ties with C at two callables, so the row order
    // alone would put python first. Only the `language` tiebreak makes this pass,
    // which is the point: the summary line must not depend on SQLite's tie order.
    seedSymbol({ name: 'p', language: 'python' })
    seedSymbol({ name: 'p2', language: 'python' })
    seedSymbol({ name: 'r', language: 'ruby' })
    seedSymbol({ name: 'c', language: 'c' })
    seedSymbol({ name: 'c2', language: 'c' })

    const coverage = readLanguageCoverage(db, SCAN_TARGET_ID)

    expect(coverage.languages.map((entry) => entry.language)).toEqual(['c', 'python', 'ruby'])
    db.close()
  })

  test('a language only some detectors cover is partly swept, and names the missing ones', () => {
    // The case the matrix introduced, and the reason it is not a boolean. This target
    // has grown a detector for Java and not the other two, so Java's callables were
    // *partly* read: rounding them to swept would claim checks that never ran, and
    // rounding them to unswept would hide the detector that did.
    seedSymbol({ name: 'j', language: 'java' })
    const diverged: readonly DetectorCapability[] = [
      { id: 'patch-shape', label: 'shapes', languages: ['c', 'cpp', 'java'] },
      { id: 'toctou', label: 'fsms', languages: ['c', 'cpp'] },
      { id: 'signal-handler', label: 'signals', languages: ['c', 'cpp'] },
    ]

    const coverage = readLanguageCoverage(db, SCAN_TARGET_ID, diverged)

    expect(coverage.sweptCallables).toBe(0)
    expect(coverage.partiallySweptCallables).toBe(1)
    expect(coverage.unsweptCallables).toBe(0)
    expect(coverage.languages).toEqual([
      {
        language: 'java',
        callables: 1,
        detectors: ['patch-shape'],
        missingDetectors: ['toctou', 'signal-handler'],
        swept: false,
      },
    ])
    db.close()
  })

  test('an empty program model reports no callables rather than zero swept', () => {
    const coverage = readLanguageCoverage(db, SCAN_TARGET_ID)
    expect(coverage).toEqual({
      sweptCallables: 0,
      partiallySweptCallables: 0,
      unsweptCallables: 0,
      languages: [],
    })
    db.close()
  })

  test('a target with no symbols row at all is empty, not an error', () => {
    const coverage = readLanguageCoverage(db, 'target-that-never-ran-recon')
    expect(coverage.languages).toEqual([])
    db.close()
  })
})

describe('formatLanguageCoverage', () => {
  test('names both sides with their counts', () => {
    const coverage: LanguageCoverage = {
      sweptCallables: 12,
      partiallySweptCallables: 0,
      unsweptCallables: 4,
      languages: [
        sweptEntry('c', 10),
        sweptEntry('cpp', 2),
        unsweptEntry('python', 3),
        unsweptEntry('rust', 1),
      ],
    }

    expect(formatLanguageCoverage(coverage)).toBe(
      'language coverage: 12 callable(s) swept (c 10, cpp 2); 4 not swept (python 3, rust 1)',
    )
  })

  test('an all-C model still prints the not-swept side, as zero', () => {
    // `0 not swept` is a claim the reader can check against the capability matrix.
    // Omitting the side would make the same output mean "nothing was skipped" and
    // "nobody measured", which is the ambiguity the line exists to remove.
    const coverage: LanguageCoverage = {
      sweptCallables: 40,
      partiallySweptCallables: 0,
      unsweptCallables: 0,
      languages: [sweptEntry('c', 40)],
    }

    expect(formatLanguageCoverage(coverage)).toBe(
      'language coverage: 40 callable(s) swept (c 40); 0 not swept',
    )
  })

  test('a partly swept language names the detectors it lacks', () => {
    // Where the matrix shows through the report. `java 3` alone would not say whether
    // three detectors found nothing or one detector ran, which is the same ambiguity
    // the unswept side exists to remove — one level down.
    const coverage: LanguageCoverage = {
      sweptCallables: 10,
      partiallySweptCallables: 3,
      unsweptCallables: 1,
      languages: [
        sweptEntry('c', 10),
        {
          language: 'java',
          callables: 3,
          detectors: ['patch-shape'],
          missingDetectors: ['toctou', 'signal-handler'],
          swept: false,
        },
        unsweptEntry('rust', 1),
      ],
    }

    expect(formatLanguageCoverage(coverage)).toBe(
      'language coverage: 10 callable(s) swept (c 10); ' +
        '3 partly swept: java 3 (missing toctou, signal-handler); 1 not swept (rust 1)',
    )
  })

  test('no indexed callables is a statement about the model, not a clean result', () => {
    expect(
      formatLanguageCoverage({
        sweptCallables: 0,
        partiallySweptCallables: 0,
        unsweptCallables: 0,
        languages: [],
      }),
    ).toBe('language coverage: no indexed callables to sweep')
  })
})
