import { describe, expect, test } from 'bun:test'

import { buildFunnel, stageSurvivors } from './funnel'

import type { EvalCandidate, Fixture, FixtureSite, FunnelRow } from './types'

const site = (filePath: string, startLine: number, endLine: number): FixtureSite => ({
  filePath,
  startLine,
  endLine,
  functionName: null,
})

const fixture = (bugCount: number): Fixture => ({
  id: 'fx-1',
  project: 'p',
  commitSha: 'abc1234',
  note: null,
  bugs: Array.from({ length: bugCount }, (_, index) => ({
    id: `bug-${index + 1}`,
    cwe: null,
    cve: null,
    files: [site(`src/bug${index + 1}.c`, 10, 20)],
    fixCommit: null,
    note: null,
  })),
})

let counter = 0
const candidate = (overrides: Partial<EvalCandidate> = {}): EvalCandidate => {
  counter += 1
  return {
    id: `cand-${counter}`,
    source: 'semgrep',
    filePath: 'src/bug1.c',
    startLine: 15,
    endLine: 15,
    state: 'new',
    triage: null,
    rediscovery: false,
    // The default a test should get unless it says otherwise: an engine's finding. A
    // test that wants a model proposal sets `source` and this together, which is the
    // pairing §20.29.4 is about.
    modelProposed: false,
    queuedForAdjudication: false,
    adjudication: null,
    ...overrides,
  }
}

const row = (rows: FunnelRow[], stage: FunnelRow['stage']): FunnelRow => {
  const found = rows.find((entry) => entry.stage === stage)
  if (!found) throw new Error(`no ${stage} row`)
  return found
}

describe('stageSurvivors', () => {
  test('raw keeps everything, including rediscoveries', () => {
    const candidates = [
      candidate({ state: 'rediscovery', rediscovery: true }),
      candidate({ state: 'dropped' }),
    ]
    expect(stageSurvivors(candidates, 'raw')).toHaveLength(2)
  })

  test('post-triage keeps §4.6\'s two surviving labels and drops noise', () => {
    const candidates = [
      candidate({ triage: 'likely-real' }),
      candidate({ triage: 'needs-context' }),
      candidate({ triage: 'likely-noise' }),
      // A NULL label is not a survivor: `readCandidatesForVerification` selects
      // only the two labelled values, so a failed call never reached it.
      candidate({ triage: null }),
    ]
    expect(stageSurvivors(candidates, 'post-triage').map((entry) => entry.triage)).toEqual([
      'likely-real',
      'needs-context',
    ])
  })

  test('post-verification keeps §5.3\'s two non-dropped outcomes', () => {
    const candidates = [
      candidate({ state: 'confirmed' }),
      candidate({ state: 'escalated' }),
      candidate({ state: 'dropped' }),
      candidate({ state: 'new' }),
    ]
    expect(stageSurvivors(candidates, 'post-verification')).toHaveLength(2)
  })

  test('post-adjudication keeps only confirmed', () => {
    const candidates = [
      candidate({ state: 'confirmed' }),
      candidate({ state: 'escalated' }),
      candidate({ state: 'dropped' }),
    ]
    expect(stageSurvivors(candidates, 'post-adjudication').map((entry) => entry.state)).toEqual([
      'confirmed',
    ])
  })
})

describe('buildFunnel', () => {
  test('a stage that never ran carries no numbers at all', () => {
    const rows = buildFunnel(fixture(1), [candidate()])
    const triage = row(rows, 'post-triage')

    expect(triage.status).toBe('not-run')
    expect(triage.reason).toContain('never ran')
    // The whole point: not zeroes. A zero would read as "ran and killed
    // everything", which is the most interesting row in the report.
    expect(triage.candidates).toBeNull()
    expect(triage.truePositives).toBeNull()
    expect(triage.falsePositives).toBeNull()
    expect(triage.precision).toBeNull()
    expect(triage.recall).toBeNull()
    expect(triage.bugsFound).toBeNull()
    expect(triage.targetMet).toBeNull()
  })

  test('raw always has numbers, even with no candidates', () => {
    const rows = buildFunnel(fixture(2), [])
    const raw = row(rows, 'raw')
    expect(raw.status).toBe('scored')
    expect(raw.candidates).toBe(0)
    expect(raw.recall).toBe(0)
    expect(raw.precision).toBeNull()
  })

  test('post-verification is not-run when nothing reached an outcome', () => {
    const rows = buildFunnel(fixture(1), [candidate({ triage: 'likely-real' })])
    expect(row(rows, 'post-verification').status).toBe('not-run')
    expect(row(rows, 'post-verification').reason).toContain('§5 never ran')
  })

  test('post-verification is scored when a candidate was dropped', () => {
    // A stage that ran and killed everything is a result, not an absence.
    const rows = buildFunnel(fixture(1), [
      candidate({ triage: 'likely-real', state: 'dropped' }),
    ])
    const verified = row(rows, 'post-verification')
    expect(verified.status).toBe('scored')
    expect(verified.candidates).toBe(0)
    expect(verified.recall).toBe(0)
  })

  test('post-adjudication is not-run when nothing was queued', () => {
    // `confirmed` alone cannot mean the human stage ran: §5.3 sets it for two
    // agreeing models too. Without a queue row this row must not appear.
    const rows = buildFunnel(fixture(1), [
      candidate({ triage: 'likely-real', state: 'confirmed' }),
    ])
    const adjudicated = row(rows, 'post-adjudication')
    expect(adjudicated.status).toBe('not-run')
    expect(adjudicated.reason).toContain('had no human decision to make')
  })

  test('post-adjudication is scored once a queue row exists', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({
        triage: 'likely-real',
        state: 'confirmed',
        queuedForAdjudication: true,
        adjudication: 'real',
      }),
    ])
    expect(row(rows, 'post-adjudication').status).toBe('scored')
  })

  test('a pending decision makes the adjudication row provisional', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ state: 'escalated', queuedForAdjudication: true, adjudication: null }),
    ])
    const adjudicated = row(rows, 'post-adjudication')
    expect(adjudicated.notes.join(' ')).toContain('no recorded decision yet')
  })

  test('scores precision from true and false positives', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ filePath: 'src/bug1.c', startLine: 12, endLine: 12 }),
      candidate({ filePath: 'src/bug1.c', startLine: 500, endLine: 500 }),
      candidate({ filePath: 'src/elsewhere.c', startLine: 1, endLine: 2 }),
    ])
    const raw = row(rows, 'raw')
    expect(raw.truePositives).toBe(1)
    expect(raw.falsePositives).toBe(2)
    expect(raw.precision).toBeCloseTo(1 / 3, 5)
  })

  test('an unlocatable candidate is in neither side of precision', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ filePath: null, startLine: null, endLine: null }),
      candidate({ filePath: 'src/bug1.c', startLine: 12, endLine: 12 }),
    ])
    const raw = row(rows, 'raw')
    expect(raw.candidates).toBe(2)
    expect(raw.unscored).toBe(1)
    expect(raw.truePositives).toBe(1)
    expect(raw.falsePositives).toBe(0)
    // Not 0.5, which would be the number if the unlocatable hit were counted as
    // noise — a broken recon reported as a noisy detector.
    expect(raw.precision).toBe(1)
    expect(raw.notes.join(' ')).toContain('neither side of precision')
  })

  test('reports which seeded bugs stopped being represented', () => {
    // §11.4's interpretation guide depends on this: "a recall drop between
    // triage and verification means the Refuter is over-killing", which needs
    // the ids rather than the count.
    const rows = buildFunnel(fixture(2), [
      candidate({ filePath: 'src/bug1.c', startLine: 15, endLine: 15, triage: 'likely-real' }),
      candidate({ filePath: 'src/bug2.c', startLine: 15, endLine: 15, triage: 'likely-noise' }),
      candidate({
        filePath: 'src/bug1.c',
        startLine: 15,
        endLine: 15,
        triage: 'likely-real',
        state: 'confirmed',
      }),
    ])
    expect(row(rows, 'raw').bugsFound).toEqual(['bug-1', 'bug-2'])
    expect(row(rows, 'post-triage').bugsLost).toEqual(['bug-2'])
    expect(row(rows, 'post-triage').bugsFound).toEqual(['bug-1'])
    expect(row(rows, 'post-verification').bugsLost).toEqual([])
  })

  test('recall falls across the stages as §11.4 shows', () => {
    const rows = buildFunnel(fixture(2), [
      candidate({ filePath: 'src/bug1.c', startLine: 15, endLine: 15, triage: 'likely-real', state: 'confirmed' }),
      candidate({ filePath: 'src/bug2.c', startLine: 15, endLine: 15 }),
    ])
    expect(row(rows, 'raw').recall).toBe(1)
    expect(row(rows, 'post-triage').recall).toBe(0.5)
  })

  test('discovery recall excludes a bug surfaced only by correlation', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ state: 'rediscovery', rediscovery: true }),
    ])
    const raw = row(rows, 'raw')
    expect(raw.recall).toBe(1)
    // Correlation found a bug the fixture list already knew about, which says
    // nothing about the engines — so the discovery figure must stay at zero.
    expect(raw.discoveryRecall).toBe(0)
    expect(raw.notes.join(' ')).toContain('came from §4.2 correlation')
  })

  test('recall is undefined, not zero, on a negative-control fixture', () => {
    const rows = buildFunnel(fixture(0), [candidate({ filePath: 'src/anywhere.c' })])
    const raw = row(rows, 'raw')
    expect(raw.recall).toBeNull()
    expect(raw.discoveryRecall).toBeNull()
    expect(raw.notes.join(' ')).toContain('negative control')
  })

  test('meets §2.4\'s target only when the false-positive rate is at or under it', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ filePath: 'src/bug1.c', startLine: 15, endLine: 15 }),
      candidate({ filePath: 'src/other.c' }),
    ])
    const raw = row(rows, 'raw')
    expect(raw.targetFpRate).toBe(0.9)
    expect(raw.targetMet).toBe(true)

    const tight = buildFunnel(fixture(1), [
      candidate({ filePath: 'src/bug1.c', startLine: 15, endLine: 15 }),
      candidate({ filePath: 'src/other.c', triage: 'likely-real', state: 'confirmed' }),
      candidate({ filePath: 'src/other2.c', triage: 'likely-real', state: 'confirmed' }),
    ])
    const verified = row(tight, 'post-verification')
    expect(verified.targetFpRate).toBe(0.25)
    expect(verified.targetMet).toBe(false)
  })

  test('flags a row that is not a subset of the one above it', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ triage: 'likely-noise', state: 'confirmed' }),
    ])
    const verified = row(rows, 'post-verification')
    expect(verified.candidates).toBe(1)
    expect(verified.notes.join(' ')).toContain('not a subset of the one above it')
  })
})

/**
 * §20.29.4: a model's proposal is a different kind of discovery from a detector's.
 *
 * It stays inside `discoveryRecall` — it is not a lookup against a known advisory, which
 * is why `rediscovery` is excluded and this is not — but the funnel has to say it
 * happened, because a chat-then-confirm loop and an engine-then-verify loop fail in
 * completely different ways and a row that pooled them could not be compared against a
 * run that did not use the investigator at all.
 */
describe('model-proposed candidates (§20.29.4)', () => {
  test('a proposal is counted, and counted toward discovery', () => {
    const rows = buildFunnel(fixture(1), [
      candidate({ source: 'investigator', modelProposed: true }),
    ])
    const raw = row(rows, 'raw')

    expect(raw.modelProposed).toBe(1)
    // Not excluded the way a rediscovery is: the model read the code and found the bug,
    // which is discovery. Correlation "finding" a bug the fixture list already knew about
    // is not.
    expect(raw.recall).toBe(1)
    expect(raw.discoveryRecall).toBe(1)
    expect(raw.notes.join(' ')).toContain('proposed by §20.29')
  })

  test('an engine finding alone leaves the count at zero', () => {
    const rows = buildFunnel(fixture(1), [candidate()])
    const raw = row(rows, 'raw')

    expect(raw.modelProposed).toBe(0)
    // No note: an ordinary run should not carry a sentence about a mode it did not use.
    expect(raw.notes.join(' ')).not.toContain('proposed by §20.29')
  })

  test('it says whether a proposal added recall or merely relocated it', () => {
    // The question a reader actually has. Saying only "1 model-proposed" invites the
    // reading that the investigator found something the detectors could not, and here it
    // did not: an engine reached the same bug.
    const rows = buildFunnel(fixture(1), [
      candidate(),
      candidate({ source: 'investigator', modelProposed: true }),
    ])

    const raw = row(rows, 'raw')
    expect(raw.modelProposed).toBe(1)
    expect(raw.notes.join(' ')).toContain('Every one of them was also reached by a detector')
  })

  test('and when no detector reached the bug, it names which one', () => {
    const rows = buildFunnel(fixture(2), [
      candidate({ filePath: 'src/bug1.c', startLine: 15 }),
      candidate({
        source: 'investigator',
        modelProposed: true,
        filePath: 'src/bug2.c',
        startLine: 15,
      }),
    ])

    const raw = row(rows, 'raw')
    // bug-2 was reached by the proposal and by nothing else, and the report says so
    // rather than leaving the reader to derive it from a total.
    expect(raw.notes.join(' ')).toContain('Reached by no detector: bug-2')
  })
})
