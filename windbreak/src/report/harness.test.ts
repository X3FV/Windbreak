import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { COMMITTED_RULE_FILES, DEFAULT_RULES_DIR } from '../engines/rules'

import { CLASS_NAMES } from './findings'
import { EXPECTED_FAILURE, generateHarness, hasFailureSignature } from './harness'

import type { Finding, HarnessFile } from './types'

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

/**
 * Compiler discovery for the compile check below.
 *
 * The check shells out to a C compiler, which is why it lives in this test and not
 * in `harness.ts`: D21 keeps generation pure, and the guard at the bottom of this
 * file asserts that no module in `report/` spawns anything. The template is
 * verified here, on every run, rather than at report time on someone's target.
 */
const COMPILER_NAMES = ['cc', 'gcc', 'clang'] as const

const findCompiler = (): string | null => {
  for (const name of COMPILER_NAMES) {
    const found = Bun.which(name)
    if (found !== null) return found
  }
  return null
}

const compiler = findCompiler()
const inCi =
  process.env.CI === 'true' || process.env.CODEBUFF_GITHUB_ACTIONS === 'true'

/**
 * A toolchain is a local prerequisite, so its absence skips with a reason — but it
 * must not skip in CI, where a runner without one would report the template as
 * verified. Same rule as the DB suites in `docs/testing.md`, and the same
 * distinction the live sandbox probes draw between "cannot start" and "not
 * isolated".
 */
if (compiler === null && inCi) {
  throw new Error(
    `no C compiler on PATH (tried ${COMPILER_NAMES.join(', ')}), so the harness skeletons ` +
      'cannot be compiled. Install a toolchain (e.g. apt-get install build-essential); ' +
      'this check must not be skipped in CI.',
  )
}
if (compiler === null) {
  console.warn(
    `[windbreak] skipping the harness compile check: no C compiler on PATH ` +
      `(tried ${COMPILER_NAMES.join(', ')}).`,
  )
}

/** Compile artifacts go to a directory unique per run, never a shared fixed path. */
const compileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-harness-'))

afterAll(() => {
  fs.rmSync(compileDir, { recursive: true, force: true })
})

interface CompileDiagnostic {
  file: string
  output: string
}

/**
 * Compile every emitted source file, returning one diagnostic per problem.
 *
 * `-fsyntax-only` is the honest scope. The skeleton declares its own prototype, so
 * there is nothing to link and the target's real signature is unknown by design —
 * that decision belongs to the researcher (spec §4.7). What this proves is that
 * what WindBreak hands over is valid source. `-Wall -Wextra` is strict on purpose:
 * the researcher will likely build with those flags, so a warning here is a
 * warning they would have to read.
 */
const compileHarness = (
  files: readonly HarnessFile[],
  label: string,
): CompileDiagnostic[] => {
  if (compiler === null) return []

  const diagnostics: CompileDiagnostic[] = []

  for (const file of files) {
    if (!/\.(c|cc|cpp|cxx)$/.test(file.name)) continue

    const cpp = /\.(cc|cpp|cxx)$/.test(file.name)
    const filePath = path.join(compileDir, `${label}-${file.name}`)
    fs.writeFileSync(filePath, file.contents)

    const proc = Bun.spawnSync(
      [compiler, '-fsyntax-only', cpp ? '-std=c++17' : '-std=c11', '-Wall', '-Wextra', filePath],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const output = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim()

    if (proc.exitCode !== 0) {
      diagnostics.push({ file: file.name, output: `did not compile:\n${output}` })
    } else if (/warning:/i.test(output)) {
      diagnostics.push({ file: file.name, output: `compiled with warnings:\n${output}` })
    }
  }

  return diagnostics
}

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
    // A placeholder with no explanation is indistinguishable from a harness that
    // found the right function and named it oddly.
    expect(harness.files[0]!.contents).toContain(
      'TODO: No enclosing function was resolved for this location.',
    )
  })

  test('refuses a C keyword, which cannot be declared or called', () => {
    const poc = generateHarness({
      finding: finding(),
      targetLocation: '/src/target',
      functionName: 'for',
    }).files[0]!.contents

    expect(poc).not.toContain('extern int for(void);')
    expect(poc).toContain('is a C keyword')
  })
})

/**
 * The emitted `poc.c` is the one artifact a researcher is expected to build, so it
 * is compiled rather than only string-matched: every assertion above passes on a
 * file that does not parse.
 */
describe('the emitted skeleton compiles', () => {
  const shapes: Array<{
    label: string
    functionName: string | null
    overrides?: Partial<Finding>
  }> = [
    { label: 'c-function', functionName: 'parse_header' },
    { label: 'unresolved', functionName: null },
    { label: 'qualified', functionName: 'Handler::parse' },
    { label: 'destructor', functionName: '~Handler' },
    { label: 'operator', functionName: 'operator=' },
    { label: 'keyword', functionName: 'for' },
    {
      label: 'no-location',
      functionName: 'parse_header',
      overrides: { filePath: null, startLine: null, endLine: null, cwe: null },
    },
  ]

  for (const shape of shapes) {
    test.skipIf(compiler === null)(`poc.c compiles: ${shape.label}`, () => {
      const harness = generateHarness({
        finding: finding(shape.overrides ?? {}),
        targetLocation: '/src/target',
        functionName: shape.functionName,
      })

      expect(compileHarness(harness.files, shape.label)).toEqual([])
    })
  }

  test('uses a resolved symbol name as-is', () => {
    const poc = generate().files[0]!.contents

    expect(poc).toContain('extern int parse_header(void);')
    expect(poc).toContain('int result = parse_header();')
    expect(poc).not.toContain('The symbol index name')
  })

  test('degrades an unusable symbol name to a placeholder, and says why', () => {
    const poc = generateHarness({
      finding: finding(),
      targetLocation: '/src/target',
      functionName: 'Handler::parse',
    }).files[0]!.contents

    // The name is quoted in the explanation, so assert on the declaration rather
    // than on absence of the string.
    expect(poc).not.toContain('Handler::parse(void)')
    expect(poc).toContain('extern int TARGET_FUNCTION(void);')
    expect(poc).toContain('is not a C identifier')
  })
})

describe('the expected-failure table', () => {
  /**
   * The classes the shipped Semgrep rules declare, read from the committed rule
   * file rather than restated. A hand-written copy is the thing that goes stale —
   * which is how CWE-377 and CWE-338 came to be emitted by the engine without a
   * class name or a reproduction signature.
   */
  const ruleSetCwes = (): string[] => {
    const cwes = new Set<string>()
    for (const name of COMMITTED_RULE_FILES) {
      const text = fs.readFileSync(path.join(DEFAULT_RULES_DIR, name), 'utf8')
      for (const match of text.matchAll(/^\s*cwe:\s*(CWE-\d+)\s*$/gm)) cwes.add(match[1]!)
    }
    return [...cwes].sort()
  }

  test('every key is a well-formed CWE id', () => {
    const malformed = Object.keys(EXPECTED_FAILURE).filter((key) => !/^CWE-\d+$/.test(key))
    expect(malformed).toEqual([])
  })

  test('every class the report can name has a signature', () => {
    const missing = Object.keys(CLASS_NAMES).filter((cwe) => !hasFailureSignature(cwe))
    expect(missing).toEqual([])
  })

  test('every class the committed rules can emit is a class the report can name', () => {
    const declared = ruleSetCwes()

    // A rule file this regex cannot read would make the guard below pass vacuously.
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.filter((cwe) => !(cwe in CLASS_NAMES))).toEqual([])
  })

  test('a class with no signature degrades instead of guessing', () => {
    expect(hasFailureSignature('cwe-120')).toBe(true)
    expect(hasFailureSignature('CWE-99999')).toBe(false)
    expect(hasFailureSignature(null)).toBe(false)
    expect(generate({ cwe: 'CWE-99999' }).expectedFailure).toMatch(/no class-specific signature/)
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
