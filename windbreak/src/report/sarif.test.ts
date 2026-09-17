import { describe, expect, test } from 'bun:test'

import { parseSarif } from '../engines/sarif'
import { buildSarifDocument, isSarifDocument, serializeSarif } from './sarif'

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
  hypothesis: 'the caller passes attacker data',
  evidence: 'Produced by: semgrep\nLocation: src/handler.c:13',
  suggestedFix: 'Bound the copy to the destination size.',
  modelsUsed: [
    { role: 'proposer', modelId: 'deepseek/deepseek-v4-flash', provider: 'deepseek' },
    { role: 'refuter', modelId: 'z-ai/glm-5.3-flash', provider: 'z-ai' },
  ],
  verdicts: [],
  injectionSignals: [],
  rediscovery: null,
  modelProposed: false,
  ...overrides,
})

const build = (findings: Finding[]) =>
  buildSarifDocument({
    targetLocation: '/tmp/target',
    commitSha: 'abc123',
    runId: 'run-1',
    findings,
    version: '0.0.1',
  })

describe('buildSarifDocument', () => {
  test('emits a 2.1.0 document with one run', () => {
    const document = build([finding()])

    expect(document.version).toBe('2.1.0')
    expect(document.$schema).toContain('sarif-schema-2.1.0.json')
    expect(isSarifDocument(document)).toBe(true)
  })

  test('names WindBreak as the driver and roots paths at the target', () => {
    const run = (build([finding()]).runs as Array<Record<string, unknown>>)[0]!
    const tool = run.tool as { driver: { name: string; version: string } }

    expect(tool.driver.name).toBe('WindBreak')
    expect(tool.driver.version).toBe('0.0.1')
    expect(run.originalUriBaseIds).toEqual({
      SRCROOT: { uri: 'file:///tmp/target/' },
    })
  })

  test('carries the tier and models used in result properties (§13.1)', () => {
    const run = (build([finding()]).runs as Array<Record<string, unknown>>)[0]!
    const result = (run.results as Array<Record<string, unknown>>)[0]!

    expect(result.ruleId).toBe('wb-c-unbounded-string-op')
    expect(result.properties).toMatchObject({
      evidenceTier: 'statically-verified',
      cwe: 'CWE-120',
      findingId: 'find_1',
      candidateId: 'cand-1',
    })
    expect((result.properties as { modelsUsed: unknown[] }).modelsUsed).toEqual([
      { role: 'proposer', modelId: 'deepseek/deepseek-v4-flash', provider: 'deepseek' },
      { role: 'refuter', modelId: 'z-ai/glm-5.3-flash', provider: 'z-ai' },
    ])
  })

  test('maps the tier onto a SARIF level, with contested at note', () => {
    const levelOf = (tier: Finding['evidenceTier']) => {
      const run = (build([finding({ evidenceTier: tier })]).runs as Array<
        Record<string, unknown>
      >)[0]!
      const result = (run.results as Array<Record<string, unknown>>)[0]!
      return result.level
    }

    expect(levelOf('human-reproduced')).toBe('error')
    expect(levelOf('statically-verified')).toBe('warning')
    expect(levelOf('contested')).toBe('note')
    // §20.35: a defect that demonstrably manifested is an error, like the human
    // tier — the finer distinction lives in `properties`, not in a SARIF level.
    expect(levelOf('dynamically-confirmed')).toBe('error')
  })

  test('emits one deduplicated rule per pattern', () => {
    const document = build([
      finding({ id: 'find_1' }),
      finding({ id: 'find_2', candidateId: 'cand-2', startLine: 4 }),
    ])
    const run = (document.runs as Array<Record<string, unknown>>)[0]!
    const driver = (run.tool as { driver: { rules: unknown[] } }).driver

    expect(driver.rules).toHaveLength(1)
    expect((run.results as unknown[]).length).toBe(2)
  })

  test('omits locations rather than inventing one when there is no line', () => {
    const document = build([finding({ filePath: null, startLine: null })])
    const run = (document.runs as Array<Record<string, unknown>>)[0]!
    const result = (run.results as Array<Record<string, unknown>>)[0]!

    expect(result.locations).toBeUndefined()
  })

  test('handles a finding with no cwe or pattern', () => {
    const document = build([finding({ cwe: null, patternId: null })])
    const run = (document.runs as Array<Record<string, unknown>>)[0]!
    const result = (run.results as Array<Record<string, unknown>>)[0]!

    expect(result.ruleId).toBe('semgrep')
    expect((result.properties as { cwe?: string }).cwe).toBeUndefined()
  })

  test('is byte-stable for the same input, which §2.1.3 needs', () => {
    expect(serializeSarif(build([finding()]))).toBe(serializeSarif(build([finding()])))
  })

  test('serializes to valid JSON', () => {
    expect(() => JSON.parse(serializeSarif(build([finding()])))).not.toThrow()
  })
})

describe('interop: our own SARIF reader can read our SARIF writer', () => {
  test('round-trips rule id, location, and class through parseSarif', () => {
    const document = build([finding()])

    // The strongest available check that the output is real SARIF rather than
    // something only WindBreak understands: feed it to the reader the baseline
    // engines stage already uses.
    const parsed = parseSarif(document, 'semgrep')

    expect(parsed.executionFailed).toBe(false)
    expect(parsed.warnings).toEqual([])
    expect(parsed.findings).toHaveLength(1)

    expect(parsed.findings[0]).toMatchObject({
      engine: 'semgrep',
      ruleId: 'wb-c-unbounded-string-op',
      filePath: 'src/handler.c',
      startLine: 13,
      endLine: 13,
      cwe: 'CWE-120',
      message: 'Unbounded copy in parse_header',
    })
  })

  test('round-trips a multi-finding document', () => {
    const document = build([
      finding({ id: 'find_1' }),
      finding({ id: 'find_2', candidateId: 'cand-2', startLine: 4 }),
    ])

    const parsed = parseSarif(document, 'semgrep')
    expect(parsed.findings.map((entry) => entry.startLine)).toEqual([13, 4])
  })
})
