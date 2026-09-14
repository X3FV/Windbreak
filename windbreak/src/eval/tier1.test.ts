import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { createFakeInvoker } from '../pipeline/test-support'
import { applySchema } from '../state/db'
import { parsePairSet } from './pairs'
import { runTier1 } from './tier1'

import type { FakeInvoker } from '../pipeline/test-support'
import type { StageMetrics } from './confusion'

/**
 * The corpus is written so the *snippet* decides the answer: the fake resolves
 * each call by looking for the vulnerable or patched call in the prompt text.
 * That makes the fake a stand-in for a stage that can actually tell the
 * difference, and it fails loudly if the evidence never reaches the model.
 */
const corpus = () =>
  parsePairSet({
    kind: 'function-pairs',
    version: 1,
    description: 'two pairs',
    corpus: 'primevul-test',
    pairs: [1, 2].map((index) => ({
      id: `p-${index}`,
      project: 'demo',
      cwe: 'CWE-120',
      vulnerable: `void vuln_${index}(char *s) { char b[8]; strcpy(b, s); }`,
      patched: `void vuln_${index}(char *s) { char b[8]; strncpy(b, s, 7); }`,
    })),
  })

/** The right answer, keyed off the text actually in the prompt. */
const discriminatingInvoker = (): FakeInvoker =>
  createFakeInvoker({
    respond: ({ userPrompt, role }) => {
      const vulnerable = userPrompt.includes('strcpy(')
      if (role === 'triage') {
        return { label: vulnerable ? 'likely-real' : 'likely-noise', rationale: 'fixture' }
      }
      return {
        verdict: vulnerable ? 'real' : 'benign',
        reasoning: 'fixture',
        preconditions: [],
      }
    },
  })

/** Calls everything a bug, which is the failure a single accuracy number hides. */
const flaggingEverythingInvoker = (): FakeInvoker =>
  createFakeInvoker({
    respond: ({ role }) =>
      role === 'triage'
        ? { label: 'likely-real', rationale: 'fixture' }
        : { verdict: 'real', reasoning: 'fixture', preconditions: [] },
  })

const freshDb = (): Database => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  return db
}

const stage = (stages: StageMetrics[], name: StageMetrics['stage']): StageMetrics => {
  const found = stages.find((entry) => entry.stage === name)
  if (!found) throw new Error(`no ${name} stage`)
  return found
}

describe('runTier1', () => {
  test('drives the real stages and scores a discriminating answer perfectly', async () => {
    const db = freshDb()
    const report = await runTier1({
      db,
      pairSet: corpus(),
      invoker: discriminatingInvoker(),
    })

    expect(report.pairs).toBe(2)

    const triage = stage(report.stages, 'triage')
    expect(triage.status).toBe('scored')
    expect(triage.truePositives).toBe(2)
    expect(triage.falsePositives).toBe(0)
    expect(triage.sensitivity).toBe(1)
    expect(triage.falseAlarmRate).toBe(0)
    expect(triage.discrimination).toBe(1)

    const verification = stage(report.stages, 'verification')
    expect(verification.truePositives).toBe(2)
    expect(verification.trueNegatives).toBe(2)
    expect(verification.discrimination).toBe(1)

    const composed = stage(report.stages, 'combined')
    expect(composed.discrimination).toBe(1)
  })

  test('a stage that calls everything a bug is caught by the patched half', async () => {
    const db = freshDb()
    const report = await runTier1({
      db,
      pairSet: corpus(),
      invoker: flaggingEverythingInvoker(),
    })

    const triage = stage(report.stages, 'triage')
    // Perfect sensitivity, and worthless: it is why both sides print together.
    expect(triage.sensitivity).toBe(1)
    expect(triage.falseAlarmRate).toBe(1)
    expect(triage.discrimination).toBe(0)
    expect(triage.precision).toBe(0.5)
  })

  test('writes real candidates, verdicts, and a run_metrics row', async () => {
    const db = freshDb()
    const report = await runTier1({
      db,
      pairSet: corpus(),
      invoker: discriminatingInvoker(),
    })

    const candidates = db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM candidates WHERE run_id = ?')
      .get(report.runId)?.n
    // One per half: four functions, not two pairs.
    expect(candidates).toBe(4)

    const verdicts = db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM verdicts')
      .get()?.n
    // 4 triage + 4 proposer + 4 refuter.
    expect(verdicts).toBe(12)

    const metrics = db
      .query<{ stage_json: string; counts_json: string }, [string]>(
        'SELECT stage_json, counts_json FROM run_metrics WHERE run_id = ?',
      )
      .get(report.runId)
    expect(metrics).not.toBeNull()
    expect(JSON.parse(metrics!.counts_json)).toEqual({ pairs: 2, halves: 4 })
    const stages = JSON.parse(metrics!.stage_json) as Array<{ stage: string }>
    expect(stages.map((entry) => entry.stage)).toEqual([
      'tier1-triage',
      'tier1-verification',
      'tier1-combined',
    ])
  })

  test('the corpus target is stable, so re-runs accumulate on one row', async () => {
    const db = freshDb()
    const first = await runTier1({ db, pairSet: corpus(), invoker: discriminatingInvoker() })
    const second = await runTier1({ db, pairSet: corpus(), invoker: discriminatingInvoker() })

    expect(second.targetId).toBe(first.targetId)
    expect(second.runId).not.toBe(first.runId)

    const targets = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM targets').get()?.n
    expect(targets).toBe(1)
  })

  test('a second run of the same corpus is answered by the §8.4 cache', async () => {
    const db = freshDb()
    const set = corpus()
    await runTier1({ db, pairSet: set, invoker: discriminatingInvoker() })

    const second = await runTier1({ db, pairSet: set, invoker: discriminatingInvoker() })
    // One answer per candidate for triage...
    expect(second.cached.triageCandidates).toBe(4)
    // ...and one per role call for verification, because Proposer and Refuter
    // are asked separately. The units differ on purpose and are labelled.
    expect(second.cached.verificationCalls).toBe(8)
    // Fully cached, so not mixed — which is what makes re-scoring comparable.
    expect(second.mixedCache).toBe(false)
  })

  test('a run that is partly cached says so rather than being silently incomparable', async () => {
    const db = freshDb()
    const set = corpus()
    await runTier1({ db, pairSet: set, invoker: discriminatingInvoker() })
    const second = await runTier1({ db, pairSet: set, invoker: discriminatingInvoker() })

    expect(second.caveats.join(' ')).not.toContain('mixed')
    // The flag tracks the *reported* state; a fresh run must not claim mixing.
    const fresh = await runTier1({
      db: freshDb(),
      pairSet: set,
      invoker: discriminatingInvoker(),
    })
    expect(fresh.cached.triageCandidates).toBe(0)
    expect(fresh.mixedCache).toBe(false)
  })

  test('a failed call is unscoreable, never a verdict that the code is clean', async () => {
    const db = freshDb()
    const invoker = createFakeInvoker({
      respond: ({ userPrompt, role }) => {
        const vulnerable = userPrompt.includes('strcpy(')
        // Every patched half's call fails.
        if (!vulnerable) return new Error('provider unavailable')
        return role === 'triage'
          ? { label: 'likely-real', rationale: 'fixture' }
          : { verdict: 'real', reasoning: 'fixture', preconditions: [] }
      },
    })

    const report = await runTier1({ db, pairSet: corpus(), invoker })

    const triage = stage(report.stages, 'triage')
    expect(triage.unscoreable).toBe(2)
    expect(triage.trueNegatives).toBe(0)
    expect(triage.falsePositives).toBe(0)
    expect(triage.notes.join(' ')).toContain('in no side of the matrix')
    // The run is narrower than the one requested.
    expect(
      db.query<{ status: string }, [string]>('SELECT status FROM runs WHERE id = ?').get(report.runId)
        ?.status,
    ).toBe('partial')
  })

  test('reports not-run when nothing answered at all', async () => {
    const db = freshDb()
    const invoker = createFakeInvoker({ respond: () => new Error('no provider') })
    const report = await runTier1({ db, pairSet: corpus(), invoker })

    for (const entry of report.stages) {
      expect(entry.status).toBe('not-run')
      expect(entry.sensitivity).toBeNull()
    }
  })

  test('needs-context counts as kept, and cannot be enriched on a corpus', async () => {
    const db = freshDb()
    const invoker = createFakeInvoker({
      respond: ({ userPrompt, role }) => {
        if (role !== 'triage') {
          return { verdict: 'real', reasoning: 'fixture', preconditions: [] }
        }
        return {
          label: userPrompt.includes('strcpy(') ? 'needs-context' : 'likely-noise',
          rationale: 'fixture',
        }
      },
    })

    const report = await runTier1({ db, pairSet: corpus(), invoker })

    // §4.6 forwards needs-context to verification, so it is a kept half.
    expect(stage(report.stages, 'triage').truePositives).toBe(2)
    expect(report.warnings.join(' ')).toContain('no program model')
  })

  test('states what a function-level number is not evidence for', async () => {
    const db = freshDb()
    const report = await runTier1({ db, pairSet: corpus(), invoker: discriminatingInvoker() })
    expect(report.caveats[0]).toContain('not repo-scale detection evidence')
    expect(report.caveats.join(' ')).toContain('enrichment pass cannot run')
  })

  test('drives verification over every half, and says the composed row is production', async () => {
    const db = freshDb()
    const invoker = discriminatingInvoker()
    const report = await runTier1({ db, pairSet: corpus(), invoker })

    const proposerCalls = invoker.calls.filter((call) => call.role === 'proposer').length
    expect(proposerCalls).toBe(4)
    expect(report.caveats.join(' ')).toContain('composed row is the production number')
  })
})
