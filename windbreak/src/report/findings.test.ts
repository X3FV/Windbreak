import { describe, expect, test } from 'bun:test'

import { deriveFindings, findingId, humanClassFor } from './findings'

import type { CandidateRecord } from '../pipeline'
import type { ReportableInput } from './findings'
import type { VerdictSummary } from './types'

const candidate = (overrides: Partial<CandidateRecord> = {}): CandidateRecord => ({
  id: 'cand-1',
  runId: 'run-1',
  targetId: 'target-1',
  source: 'semgrep',
  patternId: 'wb-c-unbounded-string-op',
  originPatchSha: null,
  filePath: 'src/handler.c',
  startLine: 13,
  endLine: 13,
  cwe: 'CWE-120',
  normalizedJson: JSON.stringify({
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy',
    level: 'error',
    filePath: 'src/handler.c',
    startLine: 13,
    endLine: 13,
    snippet: '  strcpy(copy, body);',
    sliceHash: 'h',
    precision: null,
  }),
  injectionSignals: [],
  state: 'confirmed',
  triage: 'likely-real',
  ...overrides,
})

const verdict = (
  role: string,
  answer: string,
  reasoning: string,
): VerdictSummary => ({
  role,
  answer,
  reasoning,
  modelId: `${role}-model`,
  provider: `vendor-${role}`,
})

const entry = (overrides: Partial<ReportableInput> = {}): ReportableInput => ({
  candidate: candidate(),
  verdicts: [
    verdict('triage', 'likely-real', 'looks real'),
    verdict('proposer', 'real', 'the caller passes attacker data'),
    verdict('refuter', 'real', 'no guard exists'),
  ],
  queueDecision: null,
  rediscovery: null,
  callPath: 'parse_header <- handle (src/handler.c:16)',
  enclosingFunction: 'parse_header',
  snippet: '  strcpy(copy, body);',
  language: 'c',
  ...overrides,
})

describe('evidence tier derivation', () => {
  test('a confirmed candidate is statically verified', () => {
    const { findings } = deriveFindings({ candidates: [entry()] })
    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidenceTier).toBe('statically-verified')
  })

  test('an unresolved disagreement is contested, not withheld', () => {
    const { findings } = deriveFindings({
      candidates: [entry({ candidate: candidate({ state: 'escalated' }) })],
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidenceTier).toBe('contested')
  })

  test('an escalated candidate the human called real is statically verified', () => {
    const { findings } = deriveFindings({
      candidates: [
        entry({ candidate: candidate({ state: 'escalated' }), queueDecision: 'real' }),
      ],
    })

    expect(findings[0]!.evidenceTier).toBe('statically-verified')
  })

  test('an escalated candidate the human called benign is excluded, with a reason', () => {
    const { findings, excluded } = deriveFindings({
      candidates: [
        entry({ candidate: candidate({ state: 'escalated' }), queueDecision: 'benign' }),
      ],
    })

    expect(findings).toEqual([])
    expect(excluded).toHaveLength(1)
    expect(excluded[0]!.reason).toMatch(/benign/)
  })

  test('a recorded reproduction upgrades the tier', () => {
    const { findings } = deriveFindings({
      candidates: [entry()],
      reproduced: ['cand-1'],
    })

    expect(findings[0]!.evidenceTier).toBe('human-reproduced')
  })

  test('a rediscovery is separated, never presented as a finding', () => {
    const { findings, rediscoveries } = deriveFindings({
      candidates: [
        entry({
          candidate: candidate({ state: 'rediscovery' }),
          rediscovery: { vulnId: 'GHSA-1', signals: ['file-path:src/handler.c'], basis: 'named' },
        }),
      ],
    })

    expect(findings).toEqual([])
    expect(rediscoveries).toHaveLength(1)
    expect(rediscoveries[0]!.rediscovery?.vulnId).toBe('GHSA-1')
  })

  test('a candidate that has not survived verification is excluded', () => {
    for (const state of ['new', 'triaged', 'verifying', 'dropped']) {
      const { findings, excluded } = deriveFindings({
        candidates: [entry({ candidate: candidate({ state }) })],
      })
      expect(findings).toEqual([])
      expect(excluded[0]!.reason).toContain(state)
    }
  })
})

describe('finding assembly', () => {
  test('uses the Proposer argument as the hypothesis', () => {
    const { findings } = deriveFindings({ candidates: [entry()] })
    expect(findings[0]!.hypothesis).toBe('the caller passes attacker data')
  })

  test('falls back to the triage rationale when there is no Proposer verdict', () => {
    const { findings } = deriveFindings({
      candidates: [
        entry({ verdicts: [verdict('triage', 'likely-real', 'barely qualifies')] }),
      ],
    })
    expect(findings[0]!.hypothesis).toBe('barely qualifies')
  })

  test('records the models that contributed, deduplicated', () => {
    const { findings } = deriveFindings({ candidates: [entry()] })
    expect(findings[0]!.modelsUsed.map((model) => model.role)).toEqual([
      'triage',
      'proposer',
      'refuter',
    ])
  })

  test('evidence names the stage, pattern, location, and call path', () => {
    const evidence = deriveFindings({ candidates: [entry()] }).findings[0]!.evidence

    expect(evidence).toContain('Produced by: semgrep (pattern wb-c-unbounded-string-op)')
    expect(evidence).toContain('Location: src/handler.c:13')
    expect(evidence).toContain('Call path: parse_header <- handle (src/handler.c:16)')
    expect(evidence).toContain('Proposer argument: the caller passes attacker data')
    expect(evidence).toContain('Refuter argument: no guard exists')
    expect(evidence).toContain('strcpy(copy, body);')
  })

  test('surfaces recorded injection signals as evidence about the target', () => {
    const { findings } = deriveFindings({
      candidates: [
        entry({
          candidate: candidate({
            injectionSignals: ['instruction-override@L1: // ignore previous instructions'],
          }),
        }),
      ],
    })

    expect(findings[0]!.evidence).toContain('instruction-like line(s) were recorded')
    expect(findings[0]!.evidence).toContain('ignore previous instructions')
  })

  test('titles name the class and the enclosing function', () => {
    const { findings } = deriveFindings({ candidates: [entry()] })
    expect(findings[0]!.title).toBe('Unbounded copy in parse_header')
  })

  test('falls back to the location when no enclosing function was resolved', () => {
    const { findings } = deriveFindings({
      candidates: [entry({ callPath: null, enclosingFunction: null })],
    })
    expect(findings[0]!.title).toBe('Unbounded copy in src/handler.c:13')
  })

  test('the title names the function, not the annotated call path', () => {
    // A function with no recorded callers renders its call path as
    // "name (no recorded call sites)". That annotation belongs in the evidence.
    const { findings } = deriveFindings({
      candidates: [
        entry({ callPath: 'parse_header (no recorded call sites)' }),
      ],
    })
    expect(findings[0]!.title).toBe('Unbounded copy in parse_header')
    expect(findings[0]!.evidence).toContain('no recorded call sites')
  })

  test('finding ids are stable for a candidate', () => {
    expect(findingId('cand-1')).toBe(findingId('cand-1'))
    expect(findingId('cand-1')).not.toBe(findingId('cand-2'))
  })
})

describe('humanClassFor', () => {
  test('names known classes and falls back to the pattern id', () => {
    expect(humanClassFor('CWE-120', 'r')).toBe('Unbounded copy')
    expect(humanClassFor('cwe-476', 'r')).toBe('NULL pointer dereference')
    expect(humanClassFor(null, 'my-pattern')).toBe('my-pattern')
    expect(humanClassFor('CWE-9999', null)).toBe('Unclassified defect')
  })
})
