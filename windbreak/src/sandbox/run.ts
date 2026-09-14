import { resolveBackend } from './backends'
import { buildBwrapArgv } from './bwrap'
import { buildNsjailArgv } from './nsjail'

import type { DetectOptions, ResolvedBackend } from './backends'
import type {
  SandboxBackendName,
  SandboxRequest,
  SandboxRunResult,
} from './types'

/** Raw process outcome, separated from `SandboxRunResult` so it can be faked. */
export interface SandboxSpawnResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SandboxSpawn = (
  argv: string[],
  timeoutMs: number,
) => Promise<SandboxSpawnResult>

export interface RunInSandboxOptions {
  /** Pin a backend instead of using the preference order. */
  preferred?: SandboxBackendName
  detect?: DetectOptions
  /** Injected for tests. */
  spawn?: SandboxSpawn
}

/**
 * Choose the argv for a resolved backend.
 *
 * Both builders are pure, so `buildSandboxArgv` is what tests exercise and what
 * `--dry-run` prints.
 */
export const buildSandboxArgv = (
  request: SandboxRequest,
  backend: ResolvedBackend,
): string[] =>
  backend.name === 'nsjail'
    ? buildNsjailArgv(request, backend.binary)
    : buildBwrapArgv(request, backend.binary)

/**
 * Spawn argv with a hard wall-clock limit.
 *
 * bubblewrap cannot enforce its own time limit, so the runner does it for every
 * backend: if the process is still alive at the deadline it is SIGKILLed and
 * the result is flagged `timedOut` rather than being reported as a normal
 * non-zero exit.
 */
export const spawnWithTimeout: SandboxSpawn = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      proc.kill(9)
    } catch {
      // Already gone; `exited` below still resolves.
    }
  }, timeoutMs)

  try {
    const exitCode = await proc.exited
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

export const runInSandbox = async (
  request: SandboxRequest,
  options: RunInSandboxOptions = {},
): Promise<SandboxRunResult> => {
  const backend = resolveBackend({
    ...options.detect,
    ...(options.preferred ? { preferred: options.preferred } : {}),
  })

  const argv = buildSandboxArgv(request, backend)
  const timeoutMs =
    (request.timeLimitSeconds ?? request.policy.timeLimitSeconds) * 1000

  const startedAt = Date.now()
  const result = await (options.spawn ?? spawnWithTimeout)(argv, timeoutMs)

  return {
    backend: backend.name,
    argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
    timedOut: result.timedOut,
  }
}
