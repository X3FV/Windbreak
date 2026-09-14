import { describe, expect, test } from 'bun:test'

import { normalizeArtifactUri, parseSarif } from './sarif'

const result = (overrides: Record<string, unknown> = {}) => ({
  ruleId: 'r1',
  message: { text: 'boom' },
  locations: [
    {
      physicalLocation: {
        artifactLocation: { uri: 'src/a.c' },
        region: { startLine: 7, endLine: 9 },
      },
    },
  ],
  ...overrides,
})

describe('normalizeArtifactUri', () => {
  test('strips SARIF root and file-url prefixes', () => {
    expect(normalizeArtifactUri('%SRCROOT%/src/a.c')).toBe('src/a.c')
    expect(normalizeArtifactUri('file:///abs/a.c')).toBe('/abs/a.c')
    expect(normalizeArtifactUri('./src/a.c')).toBe('src/a.c')
  })
})

describe('parseSarif', () => {
  test('returns findings with a null cwe when the rule has no tag', () => {
    const { findings } = parseSarif(
      { runs: [{ tool: { driver: { rules: [{ id: 'r1' }] } }, results: [result()] }] },
      'semgrep',
    )

    expect(findings[0]).toMatchObject({
      engine: 'semgrep',
      ruleId: 'r1',
      filePath: 'src/a.c',
      startLine: 7,
      endLine: 9,
      cwe: null,
    })
  })

  test('reads a CWE out of rule tags, however it is spelled', () => {
    const { findings } = parseSarif(
      {
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  { id: 'r1', properties: { tags: ['security', 'cwe-120'] } },
                  { id: 'r2', properties: { cwe: 'CWE-78' } },
                ],
              },
            },
            results: [result(), result({ ruleId: 'r2' })],
          },
        ],
      },
      'semgrep',
    )

    expect(findings[0]!.cwe).toBe('CWE-120')
    expect(findings[1]!.cwe).toBe('CWE-78')
  })

  test('prefers the rule default level but lets a result override it', () => {
    const { findings } = parseSarif(
      {
        runs: [
          {
            tool: {
              driver: {
                rules: [
                  { id: 'r1', defaultConfiguration: { level: 'warning' } },
                  { id: 'r2', defaultConfiguration: { level: 'error' } },
                ],
              },
            },
            results: [result(), result({ ruleId: 'r2', level: 'note' })],
          },
        ],
      },
      'semgrep',
    )

    expect(findings[0]!.level).toBe('warning')
    expect(findings[1]!.level).toBe('note')
  })

  test('skips malformed results and says how many', () => {
    const { findings, warnings } = parseSarif(
      {
        runs: [
          {
            tool: { driver: { rules: [{ id: 'r1' }] } },
            results: [
              result(),
              { message: { text: 'no rule id' } },
              { ruleId: 'r1', locations: [] },
            ],
          },
        ],
      },
      'semgrep',
    )

    expect(findings).toHaveLength(1)
    expect(warnings[0]).toMatch(/skipped 2 result/)
  })

  test('reports a document with no runs rather than returning silently empty', () => {
    const { findings, warnings } = parseSarif({ version: '2.1.0' }, 'semgrep')

    expect(findings).toEqual([])
    expect(warnings[0]).toMatch(/no runs array/)
  })

  test('handles a non-object document', () => {
    expect(parseSarif(null, 'semgrep').warnings[0]).toMatch(/not an object/)
  })

  test('surfaces an execution failure hidden in an empty-looking run', () => {
    // The exact shape Semgrep emits when semgrep-core is killed: exit-nonzero
    // in the process, but syntactically valid SARIF with no results. Without
    // reading invocations this is indistinguishable from a clean scan.
    const parsed = parseSarif(
      {
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'Semgrep OSS', rules: [{ id: 'r1' }] } },
            invocations: [
              {
                executionSuccessful: false,
                toolExecutionNotifications: [
                  {
                    level: 'error',
                    message: { text: 'semgrep-core exited with code -9 (out of memory)' },
                  },
                ],
              },
            ],
            results: [],
          },
        ],
      },
      'semgrep',
    )

    expect(parsed.findings).toEqual([])
    expect(parsed.executionFailed).toBe(true)
    expect(parsed.warnings.join(' ')).toMatch(/out of memory/)
  })

  test('does not flag a clean run, and ignores non-error notifications', () => {
    const parsed = parseSarif(
      {
        version: '2.1.0',
        runs: [
          {
            tool: { driver: { name: 'Semgrep OSS', rules: [{ id: 'r1' }] } },
            invocations: [
              {
                executionSuccessful: true,
                toolExecutionNotifications: [
                  { level: 'note', message: { text: 'scanned 3 files' } },
                ],
              },
            ],
            results: [result()],
          },
        ],
      },
      'semgrep',
    )

    expect(parsed.executionFailed).toBe(false)
    expect(parsed.warnings).toEqual([])
    expect(parsed.findings).toHaveLength(1)
  })

  test('carries the engine precision field through', () => {
    const { findings } = parseSarif(
      {
        runs: [
          {
            tool: {
              driver: {
                rules: [{ id: 'r1', properties: { precision: 'very-high' } }],
              },
            },
            results: [result()],
          },
        ],
      },
      'semgrep',
    )

    expect(findings[0]!.precision).toBe('very-high')
  })
})
