import { describe, expect, test } from 'bun:test'

import { deriveFindings, findingId, humanClassFor } from './findings'

import type { CandidateRecord } from '../pipeline'
import type { CandidateReachability } from '../reach'
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
  // Null by default, i.e. the reachability pass never ran. That is the case every
  // pre-§4.4.4 database is in, and it must not exclude anything — the tests that want a
  // conclusion supply one.
  reachability: null,
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

describe('the reachability gate', () => {
  const reachability = (
    overrides: Partial<CandidateReachability> = {},
  ): CandidateReachability => ({
    klass: 'attacker-input',
    distance: 1,
    entry: {
      filePath: 'src/main.c',
      name: 'main',
      kind: 'main',
      reason: 'the program’s entry point',
    },
    incomplete: [],
    path: [
      { filePath: 'src/main.c', name: 'main', line: null },
      { filePath: 'src/handler.c', name: 'parse_header', line: 12 },
    ],
    definition: { filePath: 'src/handler.c', name: 'parse_header', startLine: 10, endLine: 20 },
    coverage: { entries: 1, externalCallees: 0, noEntries: false },
    ...overrides,
  })

  test('a site no entry point reaches is excluded rather than reported', () => {
    const { findings, excluded } = deriveFindings({
      candidates: [
        entry({
          reachability: reachability({
            klass: 'unreachable',
            distance: null,
            entry: null,
            path: [],
          }),
        }),
      ],
    })

    expect(findings).toEqual([])
    expect(excluded).toHaveLength(1)
    expect(excluded[0]!.reason).toMatch(/no entry point reaches it/)
    expect(excluded[0]!.reason).toMatch(/§4.4.4/)
  })

  test('a candidate whose reachability was never computed is still reported', () => {
    // A scan from before the pass existed leaves NULL, and a run that did not look is not
    // a run that found no path. This is the case that keeps the gate from silently
    // emptying every older database.
    const { findings, excluded } = deriveFindings({ candidates: [entry()] })

    expect(findings).toHaveLength(1)
    expect(excluded).toEqual([])
  })

  test('unknown reports: absence of evidence is not exclusion', () => {
    const { findings } = deriveFindings({
      candidates: [
        entry({
          reachability: reachability({
            klass: 'unknown',
            distance: null,
            entry: null,
            path: [],
            incomplete: ['1 call site(s) naming it sit outside every indexed callable'],
          }),
        }),
      ],
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toContain(
      '1 call site(s) naming it sit outside every indexed callable',
    )
  })

  test('exposed-api reports, because for a library the caller is the attacker', () => {
    const { findings } = deriveFindings({
      candidates: [
        entry({
          reachability: reachability({
            klass: 'exposed-api',
            distance: 0,
            entry: null,
            path: [],
          }),
        }),
      ],
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]!.evidence).toMatch(/reachable from outside the indexed program/)
  })

  test('the evidence states the path an attacker takes to a reached site', () => {
    const { findings } = deriveFindings({
      candidates: [entry({ reachability: reachability() })],
    })

    expect(findings[0]!.evidence).toContain(
      'Reachability: an attacker can reach this — a call path exists from main (src/main.c)',
    )
    expect(findings[0]!.evidence).toContain('main (src/main.c) -> parse_header (src/handler.c:12)')
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
