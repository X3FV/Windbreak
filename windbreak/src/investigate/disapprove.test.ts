import { describe, expect, test } from 'bun:test'

import {
  DISAPPROVAL_RULE,
  INVALIDITY_CLASSES,
  buildDisapprovalPrompt,
  buildReviewPrompt,
  deriveDisapproval,
  describeDisapproval,
  gateReview,
  invalidityClass,
  isInvalidityClassId,
  judgeCheck,
  requiredClassesFor,
} from './disapprove'

import type { CheckResult, FalsificationAttempt, WorkProduct } from './disapprove'

const product = (flags: WorkProduct['flags'], claim = 'it crashes'): WorkProduct => ({
  claim,
  flags,
})

const attempt = (
  klass: string,
  overrides: Partial<FalsificationAttempt> = {},
): FalsificationAttempt => ({
  klass,
  argv: ['/bin/sh', '-c', 'true'],
  describes: 'a check',
  marker: null,
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides,
})

/** A clean pass for one class, so a test can vary the one it is about. */
const passing = (klass: string): FalsificationAttempt => {
  const entry = invalidityClass(klass)!
  const needsMarker = entry.expects.kind !== 'marker-absent' && entry.expects.marker === 'required'
  const outcomeKind = entry.expects.kind

  return attempt(klass, {
    marker: needsMarker ? 'MARKER' : null,
    exitCode: outcomeKind === 'succeeds' || outcomeKind === 'marker-absent' ? 0 : 1,
    stdout: needsMarker ? 'MARKER' : '',
  })
}

const everythingPassing = (flags: WorkProduct['flags']): FalsificationAttempt[] =>
  requiredClassesFor(product(flags)).map(passing)

describe('the table', () => {
  test('every class carries an origin, because a doubt with no origin is a guess', () => {
    for (const klass of INVALIDITY_CLASSES) {
      expect(klass.origin.length).toBeGreaterThan(20)
      expect(klass.doubt.length).toBeGreaterThan(10)
      expect(klass.settles.length).toBeGreaterThan(20)
    }
  })

  test('ids are unique, and every id resolves', () => {
    const ids = INVALIDITY_CLASSES.map((klass) => klass.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isInvalidityClassId(id)).toBe(true)
    expect(isInvalidityClassId('looks-good-to-me')).toBe(false)
  })

  test('a reproduction claim owes the reproduction doubts and the run doubts', () => {
    const required = requiredClassesFor(product(['asserts-reproduction', 'rests-on-a-run']))
    expect(required).toContain('reproduced-twice')
    expect(required).toContain('defect-not-the-harness')
    expect(required).toContain('behavior-still-present')
    expect(required).toContain('fired-in-the-named-code')
    expect(required).toContain('success-is-the-targets')
    expect(required).toContain('check-can-fail')
    expect(required).toContain('precondition-established')
    expect(required).not.toContain('input-reaches-the-sink')
    expect(required).not.toContain('subject-is-the-targets')
  })

  test('the sets are a union, not an intersection', () => {
    const required = requiredClassesFor(
      product([
        'asserts-reproduction',
        'asserts-reachability',
        'wrote-to-subject',
        'rests-on-a-run',
      ]),
    )
    expect(new Set(required).size).toBe(INVALIDITY_CLASSES.length)
  })

  test('a claim that rests on nothing executable owes nothing', () => {
    expect(requiredClassesFor(product([]))).toEqual([])
  })
})

describe('judging one check (§20.42.3)', () => {
  const fails = invalidityClass('defect-not-the-harness')!
  const succeeds = invalidityClass('precondition-established')!
  const absent = invalidityClass('success-is-the-targets')!

  const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({
    exitCode: 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  })

  test('a check required to fail is invalidated by a zero exit', () => {
    const judged = judgeCheck(fails, { marker: 'heap-buffer-overflow' }, result({ exitCode: 0 }))
    expect(judged.outcome).toBe('invalidated')
    expect(judged.detail).toContain('requires it to fail')
  })

  test('a check required to fail survives only when the marker matches', () => {
    const hit = judgeCheck(
      fails,
      { marker: 'heap-buffer-overflow' },
      result({ stderr: 'heap-buffer-overflow on address' }),
    )
    expect(hit.outcome).toBe('survived')

    // §20.35.1: a failure that is not this class's category is not reassurance.
    const missed = judgeCheck(
      fails,
      { marker: 'heap-buffer-overflow' },
      result({ stderr: 'SEGV on unknown address' }),
    )
    expect(missed.outcome).toBe('inconclusive')
    expect(missed.detail).toContain('different failure does not settle this doubt')
  })

  test('a required marker that was never given cannot settle the doubt', () => {
    const judged = judgeCheck(fails, { marker: null }, result({ stderr: 'heap-buffer-overflow' }))
    expect(judged.outcome).toBe('inconclusive')
    expect(judged.detail).toContain('no marker was given')
  })

  test('a check required to succeed is invalidated by a nonzero exit', () => {
    const judged = judgeCheck(succeeds, { marker: null }, result({ exitCode: 2 }))
    expect(judged.outcome).toBe('invalidated')
    expect(judged.detail).toContain('requires it to succeed')
  })

  test('marker-absent needs a completed run before the absence counts', () => {
    const crashed = judgeCheck(absent, { marker: 'VULNERABLE' }, result({ exitCode: 139 }))
    expect(crashed.outcome).toBe('inconclusive')
    expect(crashed.detail).toContain('failed to start is not a run that found nothing')
  })

  test('marker-absent is invalidated by the marker and survives a clean absence', () => {
    expect(
      judgeCheck(absent, { marker: 'VULNERABLE' }, result({ exitCode: 0, stdout: 'VULNERABLE' }))
        .outcome,
    ).toBe('invalidated')
    expect(
      judgeCheck(absent, { marker: 'VULNERABLE' }, result({ exitCode: 0 })).outcome,
    ).toBe('survived')
  })

  test('a timeout is never a pass, for any expectation', () => {
    for (const klass of [fails, succeeds, absent]) {
      const judged = judgeCheck(klass, { marker: 'x' }, result({ timedOut: true, exitCode: 0 }))
      expect(judged.outcome).toBe('inconclusive')
      expect(judged.detail).toContain('timed out')
    }
  })
})

describe('the disposition, which defaults to refusal (§20.42.4)', () => {
  const flags: WorkProduct['flags'] = ['asserts-reproduction', 'rests-on-a-run']

  test('no attempts at all disapproves, and names every doubt that was owed', () => {
    const record = deriveDisapproval({ product: product(flags), attempts: [] })
    expect(record.disposition).toBe('disapproved')
    expect(record.missing).toEqual(record.required)
    expect(record.missing).toContain('defect-not-the-harness')
    expect(record.reasons.join(' ')).toContain('An unattempted doubt is not a pass')
  })

  test('everything that is owed, attempted and survived, is the only route to approval', () => {
    const attempts = everythingPassing(flags)
    const record = deriveDisapproval({ product: product(flags), attempts })
    expect(record.disposition).toBe('approved')
    expect(record.missing).toEqual([])
    expect(record.inconclusive).toEqual([])
    expect(record.invalidated).toEqual([])
    expect(record.reasons.join(' ')).toContain('attempted and survived')
  })

  test('one unattempted doubt keeps the work disapproved beside surviving ones', () => {
    const attempts = everythingPassing(flags).filter(
      (entry) => entry.klass !== 'defect-not-the-harness',
    )
    const record = deriveDisapproval({ product: product(flags), attempts })
    expect(record.disposition).toBe('disapproved')
    expect(record.missing).toEqual(['defect-not-the-harness'])
  })

  test('one invalidating check outranks a surviving one for the same doubt', () => {
    const attempts = everythingPassing(flags).filter(
      (entry) => entry.klass !== 'reproduced-twice',
    )
    // A check that ran clean, beside a second run that did not fail the way it must.
    const survived = passing('reproduced-twice')
    const invalidated = attempt('reproduced-twice', {
      exitCode: 0,
      describes: 'the same command, run again',
    })

    const record = deriveDisapproval({
      product: product(flags),
      attempts: [...attempts, survived, invalidated],
    })

    expect(record.disposition).toBe('disapproved')
    expect(record.invalidated).toEqual(['reproduced-twice'])
    // And the aggregation reports both attempts, so re-running until it agrees is visible.
    expect(record.judged.find((entry) => entry.klass === 'reproduced-twice')?.attempts).toBe(2)
  })

  test('an unjudgeable check outranks a surviving one, so a flaky pass is not a pass', () => {
    const attempts = everythingPassing(flags).filter(
      (entry) => entry.klass !== 'check-can-fail',
    )
    const survived = passing('check-can-fail')
    // A failure, but not with the marker this check named — so the run happened and
    // settled nothing, which outranks the run that agreed with the model.
    const inconclusive = attempt('check-can-fail', {
      exitCode: 1,
      marker: 'EXPECTED-MARKER',
      stderr: 'something else went wrong',
    })

    const record = deriveDisapproval({
      product: product(flags),
      attempts: [...attempts, survived, inconclusive],
    })

    expect(record.disposition).toBe('disapproved')
    expect(record.inconclusive).toEqual(['check-can-fail'])
  })

  test('nothing executable means unverified, which is not an approval', () => {
    const record = deriveDisapproval({ product: product([]), attempts: [] })
    expect(record.disposition).toBe('unverified')
    expect(record.required).toEqual([])
    expect(record.reasons.join(' ')).toContain('not an approval')
  })

  test('a doubt the table does not know is recorded, and counted neither way', () => {
    const attempts = [...everythingPassing(flags), attempt('smells-fine')]
    const record = deriveDisapproval({ product: product(flags), attempts })

    expect(record.unknown).toEqual(['smells-fine'])
    expect(record.disposition).toBe('approved')
    expect(record.reasons.join(' ')).toContain('not counted either way')
  })

  test('surplus checks are recorded and cannot buy an approval', () => {
    // A product that owes the two run doubts, with every reproduction doubt checked
    // anyway. Extra work is visible, and the disposition is unchanged either way.
    const lean = product(['rests-on-a-run'])
    const record = deriveDisapproval({
      product: lean,
      attempts: [passing('check-can-fail'), passing('precondition-established'), passing('reproduced-twice')],
    })

    expect(record.disposition).toBe('approved')
    expect(record.surplus.map((entry) => entry.klass)).toEqual(['reproduced-twice'])
    expect(record.judged.map((entry) => entry.klass)).not.toContain('reproduced-twice')

    // And the same surplus cannot rescue a product that owes something it did not check.
    const owes = deriveDisapproval({
      product: product(['asserts-reachability', 'rests-on-a-run']),
      attempts: [passing('check-can-fail'), passing('precondition-established')],
    })
    expect(owes.disposition).toBe('disapproved')
    expect(owes.missing).toEqual(['input-reaches-the-sink'])
  })
})

describe('the order, enforced (§20.42.6)', () => {
  test('no record is refused, in the words of the rule', () => {
    const gate = gateReview(null)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.reason).toContain('disapprove first')
  })

  test('unverified work cannot be reviewed either', () => {
    const record = deriveDisapproval({ product: product([]), attempts: [] })
    const gate = gateReview(record)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.reason).toContain('unverified')
  })

  test('disapproved work cannot be reviewed, and the reason carries the record', () => {
    const record = deriveDisapproval({
      product: product(['asserts-reproduction', 'rests-on-a-run']),
      attempts: [],
    })
    const gate = gateReview(record)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.reason).toContain('disapproved')
    expect(gate.reason).toContain('reproduced-twice')
  })

  test('only an approved record opens the review', () => {
    const record = deriveDisapproval({
      product: product(['asserts-reproduction', 'rests-on-a-run']),
      attempts: everythingPassing(['asserts-reproduction', 'rests-on-a-run']),
    })
    expect(gateReview(record)).toEqual({ ok: true })
  })
})

describe('the two phases (§20.42.7)', () => {
  test('the disapproval prompt names every doubt the claim owes, with its check', () => {
    const claim = product(['asserts-reproduction', 'rests-on-a-run'], 'a heap overflow')
    const prompt = buildDisapprovalPrompt({ product: claim })

    expect(prompt).toContain('PHASE: DISAPPROVE')
    expect(prompt).toContain('Do not argue for this work in this phase')
    expect(prompt).toContain('CLAIM: a heap overflow')
    expect(prompt).toContain(DISAPPROVAL_RULE)
    for (const id of requiredClassesFor(claim)) expect(prompt).toContain(id)

    // It asks for commands, not for confidence.
    expect(prompt).toContain('record_falsification_check')
    expect(prompt).toContain('say plainly that you could not check it, and why')
  })

  test('the review is handed the record before it is handed the claim', () => {
    const claim = product(['asserts-reproduction', 'rests-on-a-run'], 'a heap overflow')
    const record = deriveDisapproval({
      product: claim,
      attempts: everythingPassing(claim.flags),
    })
    const prompt = buildReviewPrompt({ product: claim, record, question: 'is it reachable?' })

    const recordAt = prompt.indexOf(describeDisapproval(record))
    const claimAt = prompt.indexOf('CLAIM:')
    expect(recordAt).toBeGreaterThanOrEqual(0)
    expect(recordAt).toBeLessThan(claimAt)
    expect(prompt).toContain('QUESTION: is it reachable?')
    expect(prompt).toContain('A review that confirms disapproved')
  })
})

describe('describing the record', () => {
  test('each disposition has its own sentence, and approval states its basis', () => {
    const claim = product(['rests-on-a-run'])

    const approved = deriveDisapproval({
      product: claim,
      attempts: [passing('check-can-fail'), passing('precondition-established')],
    })
    expect(describeDisapproval(approved)).toContain('APPROVED')
    expect(describeDisapproval(approved)).toContain('2/2 doubt(s) survived')

    expect(describeDisapproval(deriveDisapproval({ product: claim, attempts: [] })))
      .toContain('DISAPPROVED')
    expect(describeDisapproval(deriveDisapproval({ product: product([]), attempts: [] })))
      .toContain('UNVERIFIED')
  })
})
