/**
 * Sandbox types.
 *
 * The policy is deliberately a plain data structure rather than a set of
 * backend flags: `nsjail` and `bubblewrap` express the same policy very
 * differently, and keeping the policy backend-agnostic is what lets the two
 * argv builders be tested independently (spec §6.2).
 */

export type SandboxBackendName = 'nsjail' | 'bwrap'

/** Preference order. First available backend wins (spec §6.1). */
export const SANDBOX_BACKEND_PREFERENCE: readonly SandboxBackendName[] = [
  'nsjail',
  'bwrap',
]

export interface BindMount {
  /** Path on the host. */
  source: string
  /** Path inside the sandbox. */
  dest: string
}

export interface SandboxPolicy {
  /**
   * Wall-clock limit. Enforced natively by nsjail and by the runner for bwrap,
   * so no backend can run unbounded (spec §6.2, §9).
   */
  timeLimitSeconds: number
  /** Address-space cap (RLIMIT_AS), MiB. */
  memoryLimitMiB: number
  /**
   * How the memory cap is expressed to the OS, in MiB — or `null` to leave
   * `RLIMIT_AS` unset entirely.
   *
   * Defaults to `memoryLimitMiB`, which is what every stage wanted until a
   * sanitized build arrived. AddressSanitizer reserves terabytes of *virtual*
   * address space for its shadow memory, and that reservation is not resident, so
   * an `RLIMIT_AS` measured in megabytes kills the process before it starts:
   *
   * ```
   * AddressSanitizer failed to allocate 0xdfff0001000 (15392894357504) bytes
   * ReserveShadowMemoryRange failed while trying to map … Perhaps you're using ulimit -v
   * ```
   *
   * A stage running sanitized code therefore says `null` here and bounds memory
   * with the runtime's own resident-set limit instead. That is a real bound on the
   * megabytes actually used; `RLIMIT_AS` on a sanitized binary is only a way to
   * fail. Stages that run ordinary code keep the default, so nothing else changes.
   */
  addressSpaceLimitMiB: number | null
  /** CPU-seconds cap (RLIMIT_CPU). */
  cpuLimitSeconds: number
  /** Paths mounted read-only. The target checkout goes here, never writable. */
  readOnlyBinds: BindMount[]
  /** Paths mounted writable. Per-run scratch only. */
  writableBinds: BindMount[]
  /** Directory to `chdir` into. Must exist inside the sandbox. */
  workingDirectory: string
  /**
   * Environment for the sandboxed process. Only these variables exist; the
   * host environment is not inherited (both backends are told to clear it).
   */
  environment: Record<string, string>
  /** Mount /proc, /dev, and a private /tmp. */
  mountPseudoFilesystems: boolean
  hostname: string
}

export interface SandboxRequest {
  policy: SandboxPolicy
  /**
   * Command to run. For bwrap this may be prefixed by the runner with a shell
   * that applies rlimits; callers pass the real command only.
   */
  command: string[]
  /** Overrides `policy.workingDirectory`. */
  workingDirectory?: string
  /** Overrides `policy.timeLimitSeconds`. */
  timeLimitSeconds?: number
}

export interface SandboxRunResult {
  backend: SandboxBackendName
  /** Full argv that was executed. Recorded so a run can be audited or replayed. */
  argv: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}
