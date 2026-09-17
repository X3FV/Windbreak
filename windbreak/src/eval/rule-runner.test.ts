import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createSemgrepBatchRunner, extensionFor, halfFileName } from './rule-runner'

import type { RuleHalfInput } from './rule-tier'

const scratchDirs: string[] = []

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-rules-test-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const halves = (filePaths: string[]): RuleHalfInput[] =>
  filePaths.map((filePath, index) => ({
    key: `pair${index}\u0000vulnerable`,
    filePath,
    source: 'int f(void) { return 0; }',
  }))

interface SarifResult {
  ruleId: string
  file: string
  line: number
}

const sarif = (
  results: SarifResult[],
  options: { executionSuccessful?: boolean; rules?: string[] } = {},
): string =>
  JSON.stringify({
    runs: [
      {
        tool: {
          driver: {
            rules: (options.rules ?? results.map((result) => result.ruleId)).map((id) => ({ id })),
          },
        },
        results: results.map((result) => ({
          ruleId: result.ruleId,
          message: { text: result.ruleId },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: result.file },
                region: { startLine: result.line },
              },
            },
          ],
        })),
        invocations: [{ executionSuccessful: options.executionSuccessful ?? true }],
      },
    ],
  })

const runnerWith = (
  stdout: string,
  options: { exitCode?: number; stderr?: string; present?: boolean } = {},
) =>
  createSemgrepBatchRunner({
    scratchDir: scratch(),
    which: () => (options.present === false ? null : '/usr/bin/semgrep'),
    run: async () => ({
      exitCode: options.exitCode ?? 0,
      stdout,
      stderr: options.stderr ?? '',
    }),
  })

describe('extensionFor', () => {
  test('maps the C family to an extension the engine will parse', () => {
    expect(extensionFor('src/a.c')).toBe('.c')
    expect(extensionFor('src/a.h')).toBe('.c')
    expect(extensionFor('src/a.cpp')).toBe('.cpp')
    expect(extensionFor('src/a.hpp')).toBe('.cpp')
    expect(extensionFor('noext')).toBe('.c')
  })
})

describe('halfFileName', () => {
  test('is unique per index so a finding can be tied back to its half', () => {
    expect(halfFileName(0, 'a.c')).toBe('wb-00000.c')
    expect(halfFileName(41, 'a.cpp')).toBe('wb-00041.cpp')
    expect(halfFileName(0, 'a.c')).not.toBe(halfFileName(1, 'a.c'))
  })
})

describe('createSemgrepBatchRunner', () => {
  test('reports every half unscoreable when the engine is not on PATH', async () => {
    const result = await runnerWith('', { present: false })(halves(['a.c']))
    expect(result.notes.join(' ')).toContain('semgrep')

    const outcome = result.outcomes.get('pair0\u0000vulnerable')!
    expect(outcome.firedRuleIds).toBeNull()
    expect(outcome.failureReason).toContain('not on PATH')
  })

  test('an empty stdout is a failure, not a clean scan', async () => {
    const result = await runnerWith('', { exitCode: 0, stderr: 'boom' })(halves(['a.c']))
    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toBeNull()
    expect(result.notes.join(' ')).toContain('no output')
  })

  test('unparseable stdout is a failure', async () => {
    const result = await runnerWith('not json at all')(halves(['a.c']))
    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toBeNull()
    expect(result.notes.join(' ')).toContain('not valid JSON')
  })

  test('executionSuccessful: false fails every half', async () => {
    // Semgrep emits valid, empty SARIF when its engine process is killed, so the
    // results alone would read as a clean run.
    const result = await runnerWith(sarif([], { executionSuccessful: false }))(halves(['a.c']))
    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toBeNull()
    expect(result.outcomes.get('pair0\u0000vulnerable')!.failureReason).toContain(
      'executionSuccessful',
    )
  })

  test('a non-zero exit with nothing read fails every half', async () => {
    const result = await runnerWith(sarif([]), { exitCode: 2 })(halves(['a.c']))
    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toBeNull()
  })

  test('a non-zero exit with valid findings is still usable', async () => {
    const file = halfFileName(0, 'a.c')
    const result = await runnerWith(sarif([{ ruleId: 'wb-a', file, line: 1 }]), {
      exitCode: 1,
    })(halves(['a.c']))

    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toEqual(['wb-a'])
  })

  test('maps findings to halves by basename and clears the rest', async () => {
    const inputs = halves(['a.c', 'b.c'])
    const result = await runnerWith(
      sarif([
        { ruleId: 'wb-a', file: `/tmp/somewhere/halves/${halfFileName(1, 'b.c')}`, line: 2 },
      ]),
    )(inputs)

    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toEqual([])
    expect(result.outcomes.get('pair1\u0000vulnerable')!.firedRuleIds).toEqual(['wb-a'])
  })

  test('a finding naming a file outside the batch is noted, not attributed', async () => {
    const result = await runnerWith(sarif([{ ruleId: 'wb-a', file: '/elsewhere/other.c', line: 1 }]))(
      halves(['a.c']),
    )

    expect(result.notes.join(' ')).toContain('could not be attributed')
    expect(result.outcomes.get('pair0\u0000vulnerable')!.firedRuleIds).toEqual([])
  })
})
