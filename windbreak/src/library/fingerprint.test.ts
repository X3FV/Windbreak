import { describe, expect, test } from 'bun:test'

import {
  canonicalFingerprintJson,
  describeFingerprint,
  InvalidFingerprintError,
  parseFingerprint,
  toFingerprint,
} from './fingerprint'
import { unboundedCopyFingerprint } from './test-support'

describe('parseFingerprint', () => {
  test('accepts a well-formed fingerprint', () => {
    const parsed = parseFingerprint(unboundedCopyFingerprint)

    expect(parsed.requireCalls).toEqual(['strcpy'])
    expect(parsed.forbidCalls).toEqual(['strncpy', 'snprintf', 'strlcpy'])
  })

  test('refuses a fingerprint with no positive predicate', () => {
    // Without a required call this would match every function in a target,
    // which is the cross-target form of the §3 recall failure.
    expect(() =>
      parseFingerprint({ ...unboundedCopyFingerprint, requireCalls: [] }),
    ).toThrow(InvalidFingerprintError)
  })

  test('accepts requireAnyCalls as the positive predicate', () => {
    expect(() =>
      parseFingerprint({
        ...unboundedCopyFingerprint,
        requireCalls: [],
        requireAnyCalls: ['strcpy', 'strcat'],
      }),
    ).not.toThrow()
  })

  test('refuses a language with no program model', () => {
    expect(() =>
      parseFingerprint({ ...unboundedCopyFingerprint, languages: ['php'] }),
    ).toThrow(/no program model/)
  })

  test('accepts the languages added with the multi-language program model', () => {
    expect(() =>
      parseFingerprint({
        ...unboundedCopyFingerprint,
        languages: ['go', 'python', 'javascript', 'typescript', 'tsx', 'java', 'ruby', 'rust', 'csharp'],
      }),
    ).not.toThrow()
  })

  test('refuses a call that is both required and forbidden', () => {
    expect(() =>
      parseFingerprint({
        ...unboundedCopyFingerprint,
        requireCalls: ['strcpy'],
        forbidCalls: ['strcpy'],
      }),
    ).toThrow(/both required and forbidden/)
  })

  test('refuses an ordering pair with identical sides', () => {
    expect(() =>
      parseFingerprint({
        ...unboundedCopyFingerprint,
        order: [{ before: 'socket', after: 'socket' }],
      }),
    ).toThrow(/must differ/)
  })

  test('refuses a malformed CWE', () => {
    expect(() =>
      parseFingerprint({ ...unboundedCopyFingerprint, cwe: 'CWE-abc' }),
    ).toThrow(InvalidFingerprintError)
  })

  test('refuses unknown fields, so a hallucinated predicate cannot no-op', () => {
    expect(() =>
      parseFingerprint({ ...unboundedCopyFingerprint, requireTypes: ['char[64]'] }),
    ).toThrow(InvalidFingerprintError)
  })

  test('toFingerprint attaches the discriminator', () => {
    const { kind, ...body } = unboundedCopyFingerprint
    void kind

    expect(toFingerprint(body).kind).toBe('function-shape')
  })
})

describe('describeFingerprint', () => {
  test('states the predicates as a claim', () => {
    const text = describeFingerprint(parseFingerprint(unboundedCopyFingerprint))

    expect(text).toContain('unbounded copy into a fixed-size buffer')
    expect(text).toContain('calls strcpy')
    expect(text).toContain('none of strncpy/snprintf/strlcpy')
    expect(text).toContain('CWE-120')
  })

  test('includes ordering when present', () => {
    const text = describeFingerprint(
      parseFingerprint({
        ...unboundedCopyFingerprint,
        order: [{ before: 'open', after: 'read' }],
      }),
    )

    expect(text).toContain('open before read')
  })
})

describe('canonicalFingerprintJson', () => {
  test('does not move when list order moves', () => {
    const a = parseFingerprint(unboundedCopyFingerprint)
    const b = parseFingerprint({
      ...unboundedCopyFingerprint,
      forbidCalls: [...unboundedCopyFingerprint.forbidCalls].reverse(),
      languages: ['c'],
    })

    expect(canonicalFingerprintJson(a)).toBe(canonicalFingerprintJson(b))
  })

  test('does move when a predicate changes', () => {
    const a = parseFingerprint(unboundedCopyFingerprint)
    const b = parseFingerprint({ ...unboundedCopyFingerprint, requireCalls: ['strcat'] })

    expect(canonicalFingerprintJson(a)).not.toBe(canonicalFingerprintJson(b))
  })
})
