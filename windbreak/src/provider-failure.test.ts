import { describe, expect, test } from 'bun:test'

import {
  classifyProviderFailure,
  describeProviderFailure,
  findProviderFailure,
  providerFailureFix,
  providerFailureLabel,
  statusCodeOf,
} from './provider-failure'

/**
 * The two refusals below are the live ones, verbatim.
 *
 * Taken from a real run against the backend rather than invented: the credit message is
 * what a depleted account gets back on the role agents' path, and `Authentication failed`
 * is what the SDK throws (and the investigator turns into `investigator run failed: ...`)
 * for a token the backend rejects. A test written from a paraphrase would pass while the
 * classification missed the real wording.
 */
const LIVE_CREDIT_REFUSAL =
  'Out of credits. Please add credits at https://www.codebuff.com/usage.'
const LIVE_AUTH_REFUSAL = 'investigator run failed: Authentication failed'

describe('classifyProviderFailure', () => {
  test('recognises the billing refusal, and keeps the provider’s own words', () => {
    const failure = classifyProviderFailure({ message: `investigator: ${LIVE_CREDIT_REFUSAL}` })

    expect(failure?.kind).toBe('credits')
    expect(failure?.detail).toBe(`investigator: ${LIVE_CREDIT_REFUSAL}`)
  })

  test('recognises the auth refusal, including the wrapped form the agent produces', () => {
    expect(classifyProviderFailure({ message: LIVE_AUTH_REFUSAL })?.kind).toBe('auth')
    expect(classifyProviderFailure({ message: 'Unauthorized' })?.kind).toBe('auth')
    expect(
      classifyProviderFailure({ message: 'No Freebuff credentials found. Run `freebuff` to log in.' })
        ?.kind,
    ).toBe('auth')
  })

  test('reads a status code when the caller has one', () => {
    expect(classifyProviderFailure({ message: 'refused', statusCode: 402 })?.kind).toBe('credits')
    expect(classifyProviderFailure({ message: 'refused', statusCode: 401 })?.kind).toBe('auth')
    expect(classifyProviderFailure({ message: 'refused', statusCode: 403 })?.kind).toBe('auth')
  })

  test('leaves an ordinary model failure alone', () => {
    // The classification must not swallow the failures that are about one call. A
    // pattern loose enough to catch these would turn every schema mismatch into an
    // account problem.
    const ordinary = [
      'triage returned no structured value: the agent ended its turn without calling `set_output`',
      'proposer output did not match verdict: expected string at verdict',
      'the investigator produced no answer, which means it ran out of steps before finishing its turn',
      'cand-7: triage failed (triage call failed: fetch failed); left untriaged.',
    ]

    for (const message of ordinary) {
      expect(classifyProviderFailure({ message })).toBeNull()
    }
  })

  test('does not match the word credentials on its own', () => {
    // A candidate's evidence can contain anything, and a warning quotes it.
    expect(
      classifyProviderFailure({ message: 'cand-3: schema mismatch at credentials field' }),
    ).toBeNull()
  })

  test('collapses and bounds a multi-line provider body', () => {
    const failure = classifyProviderFailure({
      message: `Out of credits.\n\n  Please add credits\n${'x'.repeat(500)}`,
    })

    expect(failure?.detail).not.toContain('\n')
    expect(failure?.detail.length).toBeLessThanOrEqual(241)
    expect(failure?.detail.endsWith('…')).toBe(true)
  })
})

describe('findProviderFailure', () => {
  test('finds the refusal among a stage’s warnings', () => {
    const failure = findProviderFailure([
      'cand-1: triage failed (triage call failed: fetch failed); left untriaged.',
      `cand-2: triage failed (triage: ${LIVE_CREDIT_REFUSAL}); left untriaged.`,
    ])

    expect(failure?.kind).toBe('credits')
  })

  test('is null when nothing was refused for the account', () => {
    expect(findProviderFailure(['everything ran'])).toBeNull()
    expect(findProviderFailure([])).toBeNull()
  })
})

describe('statusCodeOf', () => {
  test('reads both spellings the SDKs use, and refuses anything else', () => {
    expect(statusCodeOf({ statusCode: 402 })).toBe(402)
    expect(statusCodeOf({ status: 401 })).toBe(401)
    expect(statusCodeOf({ statusCode: '402' })).toBeUndefined()
    expect(statusCodeOf(new Error('plain'))).toBeUndefined()
    expect(statusCodeOf(null)).toBeUndefined()
    expect(statusCodeOf('402')).toBeUndefined()
  })
})

describe('the copy', () => {
  const credits = classifyProviderFailure({ message: LIVE_CREDIT_REFUSAL })
  const auth = classifyProviderFailure({ message: LIVE_AUTH_REFUSAL })

  test('names what was refused, what the provider said, and what to do', () => {
    const sentence = describeProviderFailure(credits!)

    expect(sentence).toContain('billing')
    expect(sentence).toContain(LIVE_CREDIT_REFUSAL)
    expect(sentence).toContain('codebuff.com/usage')

    const authSentence = describeProviderFailure(auth!)
    expect(authSentence).toContain('authentication')
    expect(authSentence).toContain('CODEBUFF_API_KEY')
  })

  test('the short label is short enough for one row of chrome', () => {
    expect(providerFailureLabel(credits!)).toBe('out of credits')
    expect(providerFailureLabel(auth!)).toBe('not authenticated')
  })

  test('the fix is one clause, and the long description contains it verbatim', () => {
    // One source of advice: a pane that told a researcher to top up while the summary
    // told them to log in would be the two surfaces disagreeing about the same refusal.
    for (const [failure, fragment] of [
      [credits!, 'codebuff.com/usage'],
      [auth!, 'CODEBUFF_API_KEY'],
    ] as const) {
      expect(providerFailureFix(failure)).toContain(fragment)
      expect(describeProviderFailure(failure)).toContain(providerFailureFix(failure))
    }
  })
})
