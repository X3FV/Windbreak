import fs from 'fs'
import path from 'path'

import { runInSandbox } from '../sandbox/run'
import { parseSemgrepOutput } from './semgrep'

import type { DetectOptions } from '../sandbox/backends'
import type { SandboxSpawn } from '../sandbox/run'
import type { SandboxBackendName, BindMount } from '../sandbox/types'
import type { EngineExecution, EngineInvocation, ResolvedEngine } from './types'

/**
 * Run one baseline engine inside the sandbox (spec §6).
 *
 * The engine is bound *in*, not loosened around: §6.3 says engine setup happens
 * host-side (`prepare`), and the stage binds exactly the roots `prepare`
 * resolved. The target checkout is bound read-only as always — an engine has no
 * reason to write to it.
 */

export interface RunEngineOptions {
  engine: ResolvedEngine
  invocation: EngineInvocation
  /** Target checkout, bound read-only at the same absolute path. */
  checkoutDir: string
  /** Per-run scratch: the only writable path, and the engine's HOME. */
  scratchDir: string
  /** Extra read-only binds, e.g. the rules directory. */
  extraReadOnlyBinds?: BindMount[]
  preferredBackend?: SandboxBackendName
  detect?: DetectOptions
  spawn?: SandboxSpawn
}

/** Engine runs get a writable HOME inside scratch, never the host's. */
export const engineScratchDirs = (
  scratchDir: string,
): { home: string; tmp: string } => ({
  home: path.join(scratchDir, 'home'),
  tmp: path.join(scratchDir, 'tmp'),
})

export const buildEnginePolicy = (options: RunEngineOptions) => {
  const { home, tmp } = engineScratchDirs(options.scratchDir)

  const readOnlyBinds: BindMount[] = [
    { source: options.checkoutDir, dest: options.checkoutDir },
    ...options.engine.readOnlyRoots.map((root) => ({ source: root, dest: root })),
    ...(options.extraReadOnlyBinds ?? []),
  ]

  const pathEntries = [
    ...options.engine.pathEntries,
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]

  return {
    readOnlyBinds,
    writableBinds: [{ source: options.scratchDir, dest: options.scratchDir }],
    workingDirectory: options.checkoutDir,
    timeLimitSeconds: options.invocation.timeLimitSeconds,
    // The engine needs somewhere to write its own caches, and `$HOME` is
    // deliberately not the host's. A scratch HOME is writable and cannot reach
    // anything outside the sandbox.
    environment: {
      ...options.engine.environment,
      PATH: [...new Set(pathEntries)].join(':'),
      HOME: home,
      TMPDIR: tmp,
      XDG_CACHE_HOME: path.join(home, '.cache'),
    },
    hostname: 'windbreak-engine',
  }
}

export const runEngine = async (
  options: RunEngineOptions,
): Promise<EngineExecution> => {
  const { home, tmp } = engineScratchDirs(options.scratchDir)
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })

  const policyInput = buildEnginePolicy(options)

  // Imported lazily so the pure argv/policy composition above stays testable
  // without pulling the sandbox module into every test.
  const { createSandboxPolicy } = await import('../sandbox/policy')

  const result = await runInSandbox(
    {
      policy: createSandboxPolicy(policyInput),
      command: options.invocation.argv,
      workingDirectory: options.checkoutDir,
      timeLimitSeconds: options.invocation.timeLimitSeconds,
    },
    {
      ...(options.preferredBackend ? { preferred: options.preferredBackend } : {}),
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    },
  )

  const warnings: string[] = []
  const execution: EngineExecution = {
    engine: options.invocation.engine,
    argv: result.argv,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    findings: [],
    warnings,
    failed: false,
  }

  if (result.timedOut) {
    warnings.push(
      `${options.invocation.engine} was killed at its ${options.invocation.timeLimitSeconds}s limit; ` +
        'its findings are partial.',
    )
    execution.failed = true
  }

  // Semgrep exits 1 on a fatal error and 0 with findings, so a non-zero exit is
  // an engine failure, not a "found something" signal.
  if (result.exitCode !== 0) {
    execution.failed = true
    const detail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    warnings.push(
      `${options.invocation.engine} exited ${result.exitCode}${detail ? `: ${detail}` : ''}`,
    )
  }

  if (!execution.failed || result.stdout.trim().length > 0) {
    const parsed = parseSemgrepOutput(result.stdout)
    execution.findings = parsed.findings
    warnings.push(...parsed.warnings)
    // A run can exit 0 while reporting `executionSuccessful: false`, and can
    // exit non-zero with valid SARIF. Either way the run is not trustworthy.
    if (parsed.executionFailed) execution.failed = true
  }

  if (execution.failed && execution.findings.length === 0 && result.stdout.trim().length > 0) {
    warnings.push(
      `${options.invocation.engine} failed and produced no readable findings; ` +
        'this is not a clean result.',
    )
  }

  return execution
}
