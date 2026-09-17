/**
 * Running one confirmation attempt (spec §20.35).
 *
 * Two sandboxed commands, and nothing outside the sandbox: the compile and the
 * fuzz run. The target checkout is bound **read-only** and only per-run scratch is
 * writable, so a generated target can neither change the tree a finding cites nor
 * reach the network (§6.3, D20). Everything this module does to the host is
 * create a directory under scratch and write two files into it.
 *
 * ## Why the compile is sandboxed too
 *
 * A compiler is a program that reads attacker-shaped input — the target's own
 * source — so `recon` and `build` already run theirs inside the sandbox, and this
 * follows them rather than making an exception for "just a compile". It also
 * keeps the failure honest: a target that cannot compile inside the sandbox is a
 * fact about the sandbox's view of the world, which is the view the rest of the
 * pipeline works in.
 *
 * ## The three ways this says no
 *
 * `ineligible` (nothing ran — the class is undecidable or the code is C++),
 * `build-failed` (it did not compile) and `run-failed` (it compiled but produced
 * nothing intelligible). Each is kept apart from `not-reproduced` on purpose: a
 * missing header is not evidence about a defect, and a record that blurred the
 * two would let a broken machine read as a clean finding.
 */

import fs from 'node:fs'
import path from 'node:path'

import { createSandboxPolicy, resolveBackend, runInSandbox } from '../sandbox'
import { attributeReport, parseSanitizerReport } from './attribute'
import { enrichReport } from './symbolize'
import { planFuzzTarget } from './target'

import type { DetectOptions, SandboxBackendName, SandboxRequest, SandboxRunResult } from '../sandbox'
import type { ConfirmationResult } from './types'

/** Default time given to the fuzzer, per finding. */
export const DEFAULT_FUZZ_SECONDS = 60

/**
 * A fixed seed by default.
 *
 * §8.4 wants stage outputs to be reproducible, and a fuzz run is the least
 * reproducible thing in the pipeline. Pinning the seed does not make a run
 * deterministic — the search still depends on timing — but it makes two runs
 * explore the *same* sequence, so "it found nothing" is a repeatable answer
 * rather than a coin flip.
 */
export const DEFAULT_FUZZ_SEED = 1

/** Seconds allowed for the compile. Generous; a single translation unit is quick. */
const COMPILE_TIME_LIMIT_SECONDS = 300

/**
 * Memory this stage allows, MiB.
 *
 * Expressed two different ways on purpose. The **compile** is ordinary code, so it
 * keeps the sandbox's address-space cap. The **fuzz run** cannot: the binary is
 * sanitized, and ASan reserves terabytes of virtual address space for shadow
 * memory that it never actually uses, so an `RLIMIT_AS` in the megabytes makes it
 * abort before the fuzzer starts. The run therefore leaves `RLIMIT_AS` unset and
 * passes this number to libFuzzer's own `-rss_limit_mb`, which caps the resident
 * set — the memory that is actually consumed. See `sandbox/types.ts`.
 */
const CONFIRM_MEMORY_LIMIT_MIB = 2048

/** Wall-clock slack over the fuzzer's own budget, so its own limit fires first. */
const FUZZ_WALL_CLOCK_SLACK_SECONDS = 30

const SANITIZER_FLAGS = [
  // Pinned so the generated target's empty parameter list keeps the meaning this
  // stage relies on. Before C23, `f()` declares *unspecified* parameters, so
  // calling it with one is well-defined; under C23 it means `f(void)` and the call
  // is undefined behaviour that clang only tolerates as a deprecated extension.
  // Declaring the callee is the only option — the symbol index holds no parameter
  // list — so the standard that makes that sound is the standard to compile with.
  '-std=gnu17',
  '-g',
  // **Unoptimized on purpose, and this is not a tuning knob.** ASan can only
  // report accesses that still exist, and the optimizer removes exactly the ones
  // a defect consists of when nothing reads their result: a `strcpy(buf, line)`
  // into a buffer no one subsequently reads is an unobservable store, so at -O1
  // it is deleted and the sanitizer has nothing to catch. Measured on clang 22
  // against the fixture in `run.integration.test.ts` — at -O0 the run reports
  // `stack-buffer-overflow`; at -O1 and -O2 it executes millions of inputs and
  // reports nothing, which would have been recorded as "did not reproduce".
  // Fuzzing throughput is worth far less here than the defect surviving to be
  // observed.
  '-O0',
  // **DWARF 4 on purpose.** ASan cannot find `llvm-symbolizer` here (it ships with
  // LLVM's tooling, not with clang), so the report arrives as
  // `(/scratch/bin+0x52bf0d)` and `symbolize.ts` resolves it with `addr2line`.
  // clang 22's default debug level is newer than the installed binutils reads — it
  // fails with "mangled line number section (bad file number)" — and DWARF 4 is
  // what it parses. Measured, not preferred.
  '-gdwarf-4',
  '-fno-omit-frame-pointer',
  '-fsanitize=fuzzer,address,undefined',
]

export interface ConfirmFindingInput {
  candidateId: string
  /** Repository-relative path of the file the finding cites. */
  filePath: string | null
  startLine: number | null
  endLine: number | null
  /** Enclosing function from the symbol index, when one was resolved. */
  functionName: string | null
  language: string | null
  cwe: string | null
}

export interface ConfirmFindingOptions {
  finding: ConfirmFindingInput
  /** Absolute path of the target checkout. Bound read-only. */
  checkoutDir: string
  /** Absolute writable scratch root. */
  scratchDir: string
  fuzzSeconds?: number
  seed?: number
  compiler?: string
  preferredBackend?: SandboxBackendName
  detect?: DetectOptions
  /** Injected for tests. */
  run?: (request: SandboxRequest, options?: unknown) => Promise<SandboxRunResult>
  log?: (line: string) => void
}

/** Keep a candidate id usable as a directory name without mangling its identity. */
const directoryNameFor = (candidateId: string): string =>
  candidateId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'candidate'

/** The first few compiler diagnostics, which is where the actionable line is. */
const firstDiagnostics = (text: string, limit = 6): string =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(0, limit)
    .join('\n')

export const confirmFinding = async (
  options: ConfirmFindingOptions,
): Promise<ConfirmationResult> => {
  const { finding } = options
  const fuzzSeconds = options.fuzzSeconds ?? DEFAULT_FUZZ_SECONDS
  const seed = options.seed ?? DEFAULT_FUZZ_SEED
  const compiler = options.compiler ?? 'clang'
  const run = options.run ?? (runInSandbox as ConfirmFindingOptions['run'])!
  const log = options.log ?? (() => {})
  const startedAt = Date.now()

  const refused = (outcome: 'ineligible', detail: string): ConfirmationResult => ({
    candidateId: finding.candidateId,
    outcome,
    detail,
    signature: null,
    location: null,
    fuzzSeconds,
    durationMs: Date.now() - startedAt,
    compileCommand: [],
    fuzzCommand: [],
    workspaceDir: null,
  })

  const plan = planFuzzTarget({
    functionName: finding.functionName,
    language: finding.language,
    cwe: finding.cwe,
    filePath: finding.filePath,
  })
  if (!plan.ok) return refused('ineligible', plan.reason)

  const checkoutDir = path.resolve(options.checkoutDir)
  const scratchDir = path.resolve(options.scratchDir)
  const workDir = path.join(scratchDir, 'confirm', directoryNameFor(finding.candidateId))
  fs.mkdirSync(workDir, { recursive: true })

  const generatedPath = path.join(workDir, plan.fileName)
  fs.writeFileSync(generatedPath, plan.source, 'utf8')

  // The finding names a repository-relative path; the compile needs the real one.
  const sourcePath = path.join(checkoutDir, finding.filePath!)
  const binaryPath = path.join(workDir, 'windbreak_fuzz_binary')

  const compileCommand = [
    compiler,
    ...SANITIZER_FLAGS,
    // The finding's own file may include headers next to itself or at the root.
    `-I${checkoutDir}`,
    `-I${path.dirname(sourcePath)}`,
    generatedPath,
    sourcePath,
    '-o',
    binaryPath,
  ]

  const policyFor = (addressSpaceLimitMiB: number | null) =>
    createSandboxPolicy({
      readOnlyBinds: [{ source: checkoutDir, dest: checkoutDir }],
      writableBinds: [{ source: scratchDir, dest: scratchDir }],
      workingDirectory: workDir,
      timeLimitSeconds: COMPILE_TIME_LIMIT_SECONDS,
      cpuLimitSeconds: fuzzSeconds + COMPILE_TIME_LIMIT_SECONDS,
      memoryLimitMiB: CONFIRM_MEMORY_LIMIT_MIB,
      addressSpaceLimitMiB,
    })

  const sandboxOptions = {
    ...(options.preferredBackend ? { preferred: options.preferredBackend } : {}),
    ...(options.detect ? { detect: options.detect } : {}),
  }

  log(`[confirm] compiling a fuzz target for ${finding.candidateId}`)
  const compiled: SandboxRunResult = await run(
    {
      policy: policyFor(CONFIRM_MEMORY_LIMIT_MIB),
      command: compileCommand,
      timeLimitSeconds: COMPILE_TIME_LIMIT_SECONDS,
    },
    sandboxOptions,
  )

  if (compiled.exitCode !== 0) {
    return {
      candidateId: finding.candidateId,
      outcome: 'build-failed',
      detail:
        `the generated fuzz target did not compile (\`${compiler}\` exited ${compiled.exitCode}` +
        `${compiled.timedOut ? ' after being killed at the compile time limit' : ''}). ` +
        `This says nothing about the finding; it needs headers or flags this stage does not have.\n` +
        firstDiagnostics(compiled.stderr || compiled.stdout),
      signature: null,
      location: null,
      fuzzSeconds,
      durationMs: Date.now() - startedAt,
      compileCommand,
      fuzzCommand: [],
      workspaceDir: workDir,
    }
  }

  const fuzzCommand = [
    binaryPath,
    `-max_total_time=${fuzzSeconds}`,
    `-seed=${seed}`,
    // The memory bound the policy cannot express as an rlimit here.
    `-rss_limit_mb=${CONFIRM_MEMORY_LIMIT_MIB}`,
    // Crashes land in scratch with the rest of the run, never in the checkout.
    `-artifact_prefix=${workDir}${path.sep}`,
  ]

  log(`[confirm] fuzzing ${finding.candidateId} for ${fuzzSeconds}s`)
  const fuzzed: SandboxRunResult = await run(
    {
      // `null`: a sanitized binary cannot run under `RLIMIT_AS`. `-rss_limit_mb`
      // above is the bound that applies instead.
      policy: policyFor(null),
      command: fuzzCommand,
      timeLimitSeconds: fuzzSeconds + FUZZ_WALL_CLOCK_SLACK_SECONDS,
    },
    sandboxOptions,
  )

  const output = `${fuzzed.stdout}\n${fuzzed.stderr}`
  const parsed = parseSanitizerReport(output)
  // ASan's own locations are used when it managed to produce them; when it did
  // not, the offsets it printed are resolved here. Without this every real crash
  // would fail the location gate and be recorded as `unattributed`.
  const report = parsed
    ? await enrichReport(parsed, { binaryPath })
    : null
  const verdict = attributeReport({
    report,
    timedOut: fuzzed.timedOut,
    cwe: finding.cwe,
    filePath: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    functionName: finding.functionName,
  })

  const base = {
    candidateId: finding.candidateId,
    fuzzSeconds,
    durationMs: Date.now() - startedAt,
    compileCommand,
    fuzzCommand,
    workspaceDir: workDir,
  }

  if (verdict.outcome === 'confirmed') {
    return {
      ...base,
      outcome: 'confirmed',
      detail: verdict.detail,
      signature: verdict.signature,
      location: verdict.location,
    }
  }

  if (verdict.outcome === 'unattributed') {
    return {
      ...base,
      outcome: 'unattributed',
      detail: verdict.detail,
      signature: verdict.signature || null,
      location: null,
    }
  }

  // No sanitizer report. Distinguish "the fuzzer died on its own terms" from "the
  // binary never ran", because only the second is a fact about this machine.
  const libFuzzerError = /libFuzzer:\s*(.+)/.exec(output)
  if (!fuzzed.timedOut && fuzzed.exitCode !== 0 && libFuzzerError) {
    return {
      ...base,
      outcome: 'unattributed',
      detail:
        `the fuzzer stopped on \`${libFuzzerError[1]!.trim()}\`, which is not one of the ` +
        'categories this stage can check against a class. A crash it cannot classify is not ' +
        'evidence for a specific defect.',
      signature: null,
      location: null,
    }
  }

  if (!fuzzed.timedOut && fuzzed.exitCode !== 0) {
    return {
      ...base,
      outcome: 'run-failed',
      detail:
        `the compiled fuzz target exited ${fuzzed.exitCode} without a sanitizer report or a ` +
        'libFuzzer diagnosis, so it could not be run. This says nothing about the finding.\n' +
        firstDiagnostics(fuzzed.stderr || fuzzed.stdout),
      signature: null,
      location: null,
    }
  }

  return {
    ...base,
    outcome: 'not-reproduced',
    detail: verdict.detail,
    signature: null,
    location: null,
  }
}

/** Whether the sandbox can actually be used here, before anything is attempted. */
export const resolveConfirmBackend = (options: {
  preferred?: SandboxBackendName
  detect?: DetectOptions
}): { ok: boolean; name: SandboxBackendName | null; reason: string | null } => {
  try {
    const backend = resolveBackend({
      ...options.detect,
      ...(options.preferred ? { preferred: options.preferred } : {}),
    })
    return { ok: true, name: backend.name, reason: null }
  } catch (error) {
    return {
      ok: false,
      name: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
