import fs from 'fs'
import path from 'path'

import { SANDBOX_BACKEND_PREFERENCE } from './types'

import type { SandboxBackendName } from './types'

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `${reason} WindBreak never runs target code unsandboxed (spec §18), so this is a hard stop. ` +
        `Install nsjail or bubblewrap, or run on a Linux host that permits unprivileged user namespaces.`,
    )
    this.name = 'SandboxUnavailableError'
  }
}

export interface DetectOptions {
  platform?: NodeJS.Platform
  pathEnv?: string
  /** Injected for tests; defaults to a real PATH lookup + X_OK check. */
  isExecutable?: (name: string) => string | null
}

const defaultIsExecutable = (
  name: string,
  pathEnv: string,
): string | null => {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      // A directory named like the binary would pass accessSync.
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return null
}

const resolveIsExecutable = (
  options: DetectOptions,
): ((name: string) => string | null) => {
  if (options.isExecutable) return options.isExecutable
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  return (name) => defaultIsExecutable(name, pathEnv)
}

/**
 * Which sandbox backends are usable, as absolute paths.
 *
 * Returns `{ nsjail: null, bwrap: '/usr/bin/bwrap' }`-style data rather than
 * throwing so `sandbox check` can report everything it found at once.
 */
export const detectBackends = (
  options: DetectOptions = {},
): Record<SandboxBackendName, string | null> => {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    return { nsjail: null, bwrap: null }
  }

  const isExecutable = resolveIsExecutable(options)

  return {
    nsjail: isExecutable('nsjail'),
    bwrap: isExecutable('bwrap'),
  }
}

export interface ResolvedBackend {
  name: SandboxBackendName
  /** Absolute path to the backend binary. */
  binary: string
}

/**
 * Pick a backend, or throw.
 *
 * `preferred` pins one explicitly (CLI `--backend`); otherwise the documented
 * preference order applies. Requesting a backend that is not installed is an
 * error rather than a silent fallback — a caller who asked for nsjail should
 * not quietly get weaker isolation.
 */
export const resolveBackend = (
  options: DetectOptions & { preferred?: SandboxBackendName } = {},
): ResolvedBackend => {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux') {
    throw new SandboxUnavailableError(
      `The sandbox requires Linux (detected "${platform}").`,
    )
  }

  const available = detectBackends(options)

  if (options.preferred) {
    const binary = available[options.preferred]
    if (!binary) {
      throw new SandboxUnavailableError(
        `Requested sandbox backend "${options.preferred}" is not installed or not executable.`,
      )
    }
    return { name: options.preferred, binary }
  }

  for (const name of SANDBOX_BACKEND_PREFERENCE) {
    const binary = available[name]
    if (binary) return { name, binary }
  }

  throw new SandboxUnavailableError(
    'Neither nsjail nor bubblewrap was found on PATH.',
  )
}
