import fs from 'fs'
import path from 'path'

import type { BindMount, SandboxPolicy } from './types'

/**
 * Host runtime paths a native build genuinely needs.
 *
 * Deliberately a list of directories and individual files rather than a blanket
 * `--ro-bind / /`: binding the whole host root would hand the target every
 * config file, credential, and other project on the machine. `/etc` is bound
 * file-by-file for the same reason — a build needs the dynamic linker cache and
 * user database, not the host's secrets.
 */
export const RUNTIME_READ_ONLY_DIRS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
] as const

export const RUNTIME_READ_ONLY_FILES = [
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/alternatives',
  '/etc/passwd',
  '/etc/group',
  '/etc/nsswitch.conf',
  '/etc/ssl/openssl.cnf',
] as const

/**
 * The public CA bundle.
 *
 * Present because tools that merely *link* a TLS stack refuse to start without
 * a trust anchor: Semgrep aborts with "Failed to create system store X509
 * authenticator" even with metrics and version checks off. A certificate store
 * holds no secrets, and the sandbox has no route (§6.3), so binding it cannot
 * enable outbound traffic — it only lets such a tool finish initializing.
 *
 * The extra candidate paths matter because the usual bundle is a **symlink**: on
 * RHEL-family hosts `/etc/ssl/certs/ca-certificates.crt` points into
 * `/etc/pki/ca-trust/`, so binding only `/etc/ssl/certs` leaves a dangling link
 * and the tool reports "no trust anchor file found" while the file looks
 * present from the host. Resolving the real target is what makes this portable.
 */
export const RUNTIME_READ_ONLY_CA_DIRS = ['/etc/ssl/certs'] as const

export const CA_BUNDLE_CANDIDATES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/etc/ssl/ca-bundle.pem',
] as const

const defaultRealpath = (candidate: string): string | null => {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

/**
 * Every directory a TLS stack may look in for a trust anchor: the standard cert
 * directory plus the resolved parent of each known bundle, so a symlinked
 * bundle's real location is bound too.
 */
export const resolveCaBinds = (
  realpath: (candidate: string) => string | null = defaultRealpath,
): string[] => {
  const dirs = new Set<string>(RUNTIME_READ_ONLY_CA_DIRS)

  for (const candidate of CA_BUNDLE_CANDIDATES) {
    const resolved = realpath(candidate)
    if (resolved) dirs.add(path.dirname(resolved))
  }

  return [...dirs]
}

/**
 * Ingestion is 10% of the 1h target budget (spec §9), so the build step gets a
 * fraction of that by default. The budget governor overrides these per run.
 */
export const DEFAULT_SANDBOX_LIMITS = {
  timeLimitSeconds: 300,
  memoryLimitMiB: 4096,
  cpuLimitSeconds: 300,
} as const

export const DEFAULT_SANDBOX_ENVIRONMENT: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  TMPDIR: '/tmp',
  // Pinned so tool output is byte-comparable between runs (spec §8.4).
  LANG: 'C',
  LC_ALL: 'C',
  TERM: 'dumb',
  NO_COLOR: '1',
}

export interface OptionalBindMount extends BindMount {
  /**
   * Skip this bind instead of failing when the host path is absent. Used for
   * runtime paths that legitimately vary between machines (`/lib64`).
   */
  optional?: boolean
}

export interface CreateSandboxPolicyOptions {
  /** Read-only binds, typically the target checkout. */
  readOnlyBinds: OptionalBindMount[]
  /** Writable binds, typically per-run scratch. */
  writableBinds: BindMount[]
  workingDirectory: string
  timeLimitSeconds?: number
  memoryLimitMiB?: number
  cpuLimitSeconds?: number
  environment?: Record<string, string>
  mountPseudoFilesystems?: boolean
  hostname?: string
  /** Injected for tests. */
  pathExists?: (path: string) => boolean
}

const defaultPathExists = (candidate: string): boolean => {
  try {
    fs.accessSync(candidate, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Drop `optional` binds whose host path is missing, and clear the flag. */
export const resolveOptionalBinds = (
  binds: OptionalBindMount[],
  pathExists: (path: string) => boolean = defaultPathExists,
): BindMount[] => {
  const resolved: BindMount[] = []

  for (const bind of binds) {
    if (bind.optional && !pathExists(bind.source)) continue
    resolved.push({ source: bind.source, dest: bind.dest })
  }

  return resolved
}

/**
 * Compose the read-only runtime binds with caller-supplied ones.
 *
 * Runtime binds come first so a caller cannot accidentally shadow `/usr` with
 * something weaker — and the checkout bind is appended last, which is the one
 * that must never be writable.
 */
export const createSandboxPolicy = (
  options: CreateSandboxPolicyOptions,
): SandboxPolicy => {
  const pathExists = options.pathExists ?? defaultPathExists

  const runtimeBinds: OptionalBindMount[] = [
    ...[...RUNTIME_READ_ONLY_DIRS, ...resolveCaBinds()].map((dir) => ({
      source: dir,
      dest: dir,
      optional: true,
    })),
    ...RUNTIME_READ_ONLY_FILES.map((file) => ({
      source: file,
      dest: file,
      optional: true,
    })),
  ]

  return {
    timeLimitSeconds:
      options.timeLimitSeconds ?? DEFAULT_SANDBOX_LIMITS.timeLimitSeconds,
    memoryLimitMiB:
      options.memoryLimitMiB ?? DEFAULT_SANDBOX_LIMITS.memoryLimitMiB,
    cpuLimitSeconds:
      options.cpuLimitSeconds ?? DEFAULT_SANDBOX_LIMITS.cpuLimitSeconds,
    readOnlyBinds: resolveOptionalBinds(
      [...runtimeBinds, ...options.readOnlyBinds],
      pathExists,
    ),
    writableBinds: [...options.writableBinds],
    workingDirectory: options.workingDirectory,
    environment: { ...DEFAULT_SANDBOX_ENVIRONMENT, ...options.environment },
    mountPseudoFilesystems: options.mountPseudoFilesystems ?? true,
    hostname: options.hostname ?? 'windbreak',
  }
}
