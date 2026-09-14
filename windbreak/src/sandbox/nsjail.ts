import type { SandboxRequest } from './types'

/**
 * Build the nsjail argv (spec §6.1, primary backend).
 *
 * nsjail enforces limits natively, so unlike the bwrap path there is no shell
 * wrapper: `--time_limit`, `--rlimit_as` (MiB), and `--rlimit_cpu` are all
 * handled by the backend itself.
 *
 * Isolation notes:
 * - No `--share_net` is emitted, so nsjail's default new network namespace
 *   stands and the sandbox has no route off the host (spec §6.3).
 * - No `--keep_env`: only the policy's `--env` entries exist, so the host
 *   environment does not leak in.
 * - `no_new_privs` is nsjail's default and is not disabled here.
 * - Destinations are emitted as `src:dst` rather than nsjail's single-path
 *   shorthand so a bind can never silently change meaning if nsjail's default
 *   dest inference changes.
 */
export const buildNsjailArgv = (
  request: SandboxRequest,
  backendPath: string,
): string[] => {
  const { policy } = request
  const cwd = request.workingDirectory ?? policy.workingDirectory
  const timeLimit = request.timeLimitSeconds ?? policy.timeLimitSeconds

  const argv: string[] = [
    backendPath,
    '--mode',
    'o',
    '--quiet',
    '--time_limit',
    String(timeLimit),
    '--rlimit_as',
    String(policy.memoryLimitMiB),
    '--rlimit_cpu',
    String(policy.cpuLimitSeconds),
    '--hostname',
    policy.hostname,
    '--cwd',
    cwd,
  ]

  if (policy.mountPseudoFilesystems) {
    argv.push('--tmpfsmount', '/tmp')
  } else {
    argv.push('--disable_proc')
  }

  for (const bind of policy.readOnlyBinds) {
    argv.push('--bindmount_ro', `${bind.source}:${bind.dest}`)
  }

  for (const bind of policy.writableBinds) {
    argv.push('--bindmount', `${bind.source}:${bind.dest}`)
  }

  for (const [key, value] of Object.entries(policy.environment)) {
    argv.push('--env', `${key}=${value}`)
  }

  argv.push('--', ...request.command)

  return argv
}
