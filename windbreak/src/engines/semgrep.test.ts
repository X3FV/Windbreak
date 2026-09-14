import { describe, expect, test } from 'bun:test'

import { buildSemgrepArgv, parseSemgrepOutput } from './semgrep'

describe('buildSemgrepArgv', () => {
  test('pins the offline-determinism flags and keeps targets last', () => {
    const argv = buildSemgrepArgv({
      rulePaths: ['/rules/security.yaml'],
      targetPaths: ['.'],
    })

    expect(argv[0]).toBe('semgrep')
    expect(argv).toContain('--metrics')
    expect(argv[argv.indexOf('--metrics') + 1]).toBe('off')
    expect(argv).toContain('--disable-version-check')
    expect(argv).toContain('--sarif')
    expect(argv.at(-1)).toBe('.')
  })

  test('disables rule-id rewriting so ids stay stable across machines', () => {
    const argv = buildSemgrepArgv({
      rulePaths: ['/home/someone/windbreak/rules/security.yaml'],
      targetPaths: ['.'],
    })

    // Without this, Semgrep prefixes rule ids with the config path, and
    // `pattern_id` would differ per checkout location.
    expect(argv).toContain('--no-rewrite-rule-ids')
  })

  test('adds one --config per rule path, extra paths included', () => {
    const argv = buildSemgrepArgv({
      rulePaths: ['/rules/a.yaml'],
      extraRulePaths: ['/rules/b.yaml'],
      targetPaths: ['.'],
    })

    const configs = argv.flatMap((arg, index, all) =>
      arg === '--config' ? [all[index + 1]] : [],
    )
    expect(configs).toEqual(['/rules/a.yaml', '/rules/b.yaml'])
  })

  test('emits one --exclude per excluded directory', () => {
    const argv = buildSemgrepArgv({
      rulePaths: ['/rules/a.yaml'],
      targetPaths: ['.'],
      excludedDirectories: ['node_modules', '.git'],
    })

    const excludes = argv.flatMap((arg, index, all) =>
      arg === '--exclude' ? [all[index + 1]] : [],
    )
    expect(excludes).toEqual(['node_modules', '.git'])
  })

  test('applies the timeouts and jobs it was given', () => {
    const argv = buildSemgrepArgv({
      rulePaths: ['/rules/a.yaml'],
      targetPaths: ['src'],
      jobs: 1,
      timeoutSeconds: 5,
      maxTargetBytes: 1234,
    })

    expect(argv[argv.indexOf('--jobs') + 1]).toBe('1')
    expect(argv[argv.indexOf('--timeout') + 1]).toBe('5')
    expect(argv[argv.indexOf('--max-target-bytes') + 1]).toBe('1234')
    expect(argv.at(-1)).toBe('src')
  })
})

describe('parseSemgrepOutput', () => {
  test('reads findings out of a SARIF document', () => {
    const stdout = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'Semgrep OSS', rules: [{ id: 'r1' }] } },
          results: [
            {
              ruleId: 'r1',
              message: { text: 'a problem' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/a.c', uriBaseId: '%SRCROOT%' },
                    region: { startLine: 4, endLine: 4 },
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    const result = parseSemgrepOutput(stdout)

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      engine: 'semgrep',
      ruleId: 'r1',
      filePath: 'src/a.c',
      startLine: 4,
      message: 'a problem',
    })
  })

  test('reports empty output as a warning, not as no findings', () => {
    const result = parseSemgrepOutput('   \n')

    expect(result.findings).toEqual([])
    expect(result.warnings[0]).toMatch(/no output/)
  })

  test('reports unparseable output as a warning', () => {
    const result = parseSemgrepOutput('Traceback (most recent call last): ...')

    expect(result.findings).toEqual([])
    expect(result.warnings[0]).toMatch(/not valid JSON/)
  })
})
