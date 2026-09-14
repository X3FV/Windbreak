import { describe, expect, test } from 'bun:test'

import { MissingEvidenceTierError, renderWriteup } from './writeup'

import type { Finding } from './types'

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'find_1',
  candidateId: 'cand-1',
  runId: 'run-1',
  targetId: 'target-1',
  evidenceTier: 'statically-verified',
  title: 'Unbounded copy in parse_header',
  cwe: 'CWE-120',
  source: 'semgrep',
  patternId: 'wb-c-unbounded-string-op',
  filePath: 'src/handler.c',
  startLine: 13,
  endLine: 13,
  hypothesis: 'the caller passes attacker data to strcpy',
  evidence: 'Produced by: semgrep\nLocation: src/handler.c:13',
  suggestedFix: 'Bound the copy to the destination size.',
  modelsUsed: [],
  verdicts: [],
  injectionSignals: [],
  rediscovery: null,
  modelProposed: false,
  ...overrides,
})

const render = (overrides: Partial<Finding> = {}) =>
  renderWriteup({
    finding: finding(overrides),
    targetLocation: '/src/target',
    commitSha: 'abc123',
  })

describe('renderWriteup (§13.2)', () => {
  test('emits the template fields in order', () => {
    const text = render({})

    expect(text.startsWith('# Unbounded copy in parse_header')).toBe(true)
    const order = [
      '**Target:** /src/target @ abc123',
      '**Class:** CWE-120 · **Evidence tier:** statically-verified',
      '**Hypothesis:**',
      '**Evidence:**',
      '**Reproduction steps:**',
      '**Suggested fix:**',
    ]

    let cursor = -1
    for (const marker of order) {
      const index = text.indexOf(marker)
      expect(index).toBeGreaterThan(cursor)
      cursor = index
    }
  })

  test('says so when no harness was generated', () => {
    expect(render({})).toContain('Not generated for this finding.')
  })

  test('embeds the harness steps when they exist', () => {
    const text = renderWriteup({
      finding: finding(),
      targetLocation: '/src/target',
      commitSha: 'abc123',
      reproductionSteps: ['Build it with ASan.', '  ./poc'],
    })

    expect(text).toContain('Build it with ASan.')
    expect(text).toContain('  ./poc')
  })

  test('marks a contested finding as recorded, not asserted', () => {
    const text = render({ evidenceTier: 'contested' })
    expect(text).toContain('**Evidence tier:** contested')
    expect(text).toContain('recorded, not asserted')
  })

  test('does not add the contested note to a verified finding', () => {
    expect(render({})).not.toContain('recorded, not asserted')
  })

  test('omits CVSS entirely when there is no estimate (D23 makes it optional)', () => {
    expect(render({})).not.toContain('CVSS')
  })

  test('renders CVSS when provided', () => {
    const text = renderWriteup({
      finding: finding(),
      targetLocation: '/src/target',
      commitSha: 'abc123',
      cvss: { vector: 'CVSS:3.1/AV:N/AC:L', score: 7.5, basis: 'network reachable' },
    })

    expect(text).toContain('**CVSS estimate:** CVSS:3.1/AV:N/AC:L · 7.5 · network reachable')
  })

  test('uses the unclassified placeholder when there is no CWE', () => {
    expect(render({ cwe: null })).toContain('**Class:** unclassified')
  })
})

describe('missing evidence tier is refused (§12.3, §2.1.5)', () => {
  test('throws rather than writing an unstated claim', () => {
    expect(() => render({ evidenceTier: undefined as never })).toThrow(
      MissingEvidenceTierError,
    )
  })

  test('throws on an unrecognized tier value', () => {
    expect(() => render({ evidenceTier: 'probably-real' as never })).toThrow(
      /never emits a claim whose evidence tier is unstated/,
    )
  })

  test('accepts every tier in the spec', () => {
    for (const tier of ['statically-verified', 'human-reproduced', 'contested'] as const) {
      expect(() => render({ evidenceTier: tier })).not.toThrow()
    }
  })
})
