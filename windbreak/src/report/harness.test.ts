import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import path from 'path'

import { generateHarness } from './harness'

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
  evidence: 'Produced by: semgrep',
  suggestedFix: 'Bound the copy.',
  modelsUsed: [],
  verdicts: [],
  injectionSignals: [],
  rediscovery: null,
  modelProposed: false,
  ...overrides,
})

const generate = (overrides: Partial<Finding> = {}) =>
  generateHarness({
    finding: finding(overrides),
    targetLocation: '/src/target',
    functionName: 'parse_header',
    buildSteps: [
      { description: 'configure', command: ['cmake', '-S', '/src/target', '-B', '/tmp/b'] },
    ],
    compileCommandsPath: '/tmp/b/compile_commands.json',
  })

describe('generateHarness', () => {
  test('emits a PoC skeleton and a run script', () => {
    const harness = generate()

    expect(harness.files.map((file) => file.name)).toEqual(['poc.c', 'build-and-run.sh'])
    expect(harness.files[1]!.executable).toBe(true)
  })

  test('the skeleton is honest that it is a skeleton', () => {
    const poc = generate().files[0]!.contents

    expect(poc).toContain('SKELETON, not a working exploit')
    expect(poc).toContain('TODO: build the input this function mishandles')
    expect(poc).toContain('TODO: call the function the way the real caller does')
    expect(poc).toContain('WindBreak did not run this')
  })

  test('the skeleton names the function and the flagged location', () => {
    const poc = generate().files[0]!.contents

    expect(poc).toContain('parse_header')
    expect(poc).toContain('src/handler.c:13')
    expect(poc).toContain('Evidence tier: statically-verified')
  })

  test('carries the target build steps into the instructions', () => {
    const harness = generate()

    expect(harness.buildInstructions.join('\n')).toContain(
      'cmake -S /src/target -B /tmp/b',
    )
    expect(harness.buildInstructions.join('\n')).toContain('/tmp/b/compile_commands.json')
  })

  test('tells the researcher nothing has been executed', () => {
    const harness = generate()

    expect(harness.buildInstructions[0]).toMatch(/did not build or run it/)
    expect(harness.researcherInstructions).toContain('never runs it (spec D21)')
  })

  test('recommends sanitizers so the failure is observable', () => {
    const harness = generate()
    expect(harness.buildInstructions.join('\n')).toContain('-fsanitize=address,undefined')
  })

  test('states a class-specific expected failure', () => {
    expect(generate({ cwe: 'CWE-120' }).expectedFailure).toMatch(/AddressSanitizer/)
    expect(generate({ cwe: 'CWE-476' }).expectedFailure).toMatch(/SIGSEGV/)
    expect(generate({ cwe: 'CWE-416' }).expectedFailure).toMatch(/use-after-free/)
  })

  test('warns that a single run does not disprove a race', () => {
    const race = generate({ cwe: 'CWE-362' })
    expect(race.expectedFailure).toContain('A single run does NOT disprove this class')
    expect(race.buildInstructions.join('\n')).toContain('non-determinism')
  })

  test('is honest when no class signature is known', () => {
    const unknown = generate({ cwe: null })
    expect(unknown.expectedFailure).toMatch(/no class-specific signature is known/)
  })

  test('tells the researcher how to record a reproduction', () => {
    expect(generate().researcherInstructions).toContain(
      'windbreak report --reproduced cand-1',
    )
  })

  test('falls back to a placeholder when the function is unknown', () => {
    const harness = generateHarness({
      finding: finding(),
      targetLocation: '/src/target',
      functionName: null,
    })

    expect(harness.files[0]!.contents).toContain('TARGET_FUNCTION')
  })
})

describe('harness generation never executes anything (D21)', () => {
  test('the reporting modules contain no process-spawning call', () => {
    const reportDir = path.dirname(new URL(import.meta.url).pathname)

    const offenders: string[] = []
    for (const file of fs.readdirSync(reportDir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = fs.readFileSync(path.join(reportDir, file), 'utf8')
      // Strip comments so prose about not executing is not mistaken for code.
      const code = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n')
      if (/\b(child_process|spawnSync|execFile|execSync|Bun\.spawn|\.spawn\()/.test(code)) {
        offenders.push(file)
      }
    }

    expect(offenders).toEqual([])
  })
})
