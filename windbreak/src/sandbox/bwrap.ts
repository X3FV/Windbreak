import type { SandboxRequest } from './types'

/**
 * Apply rlimits before exec, because bubblewrap has no rlimit flags.
 *
 * Passed as `sh -c <script> windbreak-sandbox <memKiB> <cpuSec> <cmd...>` so the
 * real command arrives as positionals and never needs shell quoting.
 */
export const RLIMIT_WRAPPER_SCRIPT =
  'ulimit -v "$1" 2>/dev/null || true; ulimit -t "$2" 2>/dev/null || true; shift 2; exec "$@"'

export const RLIMIT_WRAPPER_NAME = 'windbreak-sandbox'

/**
 * The command bubblewrap actually executes: the rlimit wrapper around the
 * caller's command.
 */
export const wrapCommandWithRlimits = (request: SandboxRequest): string[] => {
  const { policy } = request

  return [
    '/bin/sh',
    '-c',
    RLIMIT_WRAPPER_SCRIPT,
    RLIMIT_WRAPPER_NAME,
    String(policy.memoryLimitMiB * 1024),
    String(policy.cpuLimitSeconds),
    ...request.command,
  ]
}

/**
 * Build the bubblewrap argv (spec §6.2).
 *
 * Isolation is all namespaces at once: `--unshare-all` gives new user, PID,
 * UTS, IPC, cgroup, and — the one that matters for §6.3 — **net** namespaces,
 * so the sandbox has no route off the host. `--die-with-parent` makes an
 * abandoned sandbox exit rather than linger. `--clearenv` means the only
 * environment is the policy's.
 */
export const buildBwrapArgv = (
  request: SandboxRequest,
  backendPath: string,
): string[] => {
  const { policy } = request
  const cwd = request.workingDirectory ?? policy.workingDirectory

  const argv: string[] = [
    backendPath,
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--cap-drop',
    'ALL',
  ]

  if (policy.mountPseudoFilesystems) {
    argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  }

  for (const bind of policy.readOnlyBinds) {
    argv.push('--ro-bind', bind.source, bind.dest)
  }

  for (const bind of policy.writableBinds) {
    argv.push('--bind', bind.source, bind.dest)
  }

  argv.push('--chdir', cwd)

  for (const [key, value] of Object.entries(policy.environment)) {
    argv.push('--setenv', key, value)
  }

  argv.push('--', ...wrapCommandWithRlimits(request))

  return argv
}
