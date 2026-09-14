/**
 * Host-side engine resolution (spec §6.3, `prepare`).
 *
 * The sandbox binds neither `$HOME` nor `/opt`, so a tool installed under
 * either is invisible inside it. Rather than loosen the sandbox for everyone,
 * `prepare` resolves each engine *on the host* — where the engine legitimately
 * lives — and records exactly which directories and environment it needs. The
 * stage then binds those read-only, and nothing else.
 *
 * This runs before any sandbox exists and executes trusted, host-installed
 * binaries only. It never touches target content.
 */

import { dirname } from 'path'

import type { EngineUnavailable, ResolvedEngine } from './types'

export interface HostCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type HostRunner = (argv: string[]) => Promise<HostCommandResult>
export type Which = (binary: string) => string | null

export const defaultHostRunner: HostRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } catch (cause) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export const defaultWhich: Which = (binary) => Bun.which(binary) ?? null

export interface ResolveEnginesOptions {
  /** Engines to resolve. Defaults to the engines this build drives. */
  engines?: readonly string[]
  which?: Which
  run?: HostRunner
  log?: (line: string) => void
}

export interface ResolveEnginesResult {
  resolved: ResolvedEngine[]
  unavailable: EngineUnavailable[]
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? ''

/**
 * Semgrep is a Python entry-point script, so its binary directory is not enough
 * to make it run: the interpreter resolves `semgrep` from site-packages, which
 * for a `pip install --user` lives under `$HOME` and is therefore not bound by
 * default. Ask the interpreter itself for the package root rather than guessing
 * a `python3.14`-style path.
 *
 * The result is returned as both a read-only bind *and* `PYTHONPATH`, because
 * the sandbox's scratch `HOME` moves Python's user-site away from the bound
 * directory. Only one of the two leaves the engine unable to import itself.
 */
export const resolveSemgrep = async (
  options: ResolveEnginesOptions,
): Promise<ResolvedEngine | EngineUnavailable> => {
  const which = options.which ?? defaultWhich
  const run = options.run ?? defaultHostRunner

  const binary = which('semgrep')
  if (!binary) {
    return {
      engine: 'semgrep',
      reason: 'not found on PATH',
    }
  }

  const versionResult = await run([binary, '--version'])
  const version =
    versionResult.exitCode === 0 && firstLine(versionResult.stdout).length > 0
      ? firstLine(versionResult.stdout)
      : 'unknown'

  // `dirname(dirname(semgrep.__file__))` is the site-packages directory that
  // contains the package. A failure here is not fatal: a system-wide install
  // needs no extra root, since `/usr` is already bound.
  const packageRootResult = await run([
    'python3',
    '-c',
    'import os, semgrep; print(os.path.dirname(os.path.dirname(semgrep.__file__)))',
  ])
  const packageRoot =
    packageRootResult.exitCode === 0
      ? firstLine(packageRootResult.stdout)
      : null

  const readOnlyRoots = [dirname(binary)]
  if (packageRoot && packageRoot.startsWith('/')) readOnlyRoots.push(packageRoot)

  return {
    engine: 'semgrep',
    version,
    binary,
    readOnlyRoots: dedupePaths(readOnlyRoots),
    pathEntries: dedupePaths([dirname(binary)]),
    environment: {
      SEMGREP_SEND_METRICS: 'off',
      // Pinned so engine output is byte-comparable between runs (spec §8.4).
      SEMGREP_ENABLE_VERSION_CHECK: '0',
      ...(packageRoot && packageRoot.startsWith('/')
        ? {
            // Binding site-packages is not enough. The sandbox sets HOME to a
            // scratch directory, so Python's *user site* becomes
            // `<scratch>/home/.local/...` and the bound package is never on
            // `sys.path` — the engine then dies with ModuleNotFoundError
            // despite the bind being correct. Naming the root explicitly is
            // what makes the bind reachable.
            PYTHONPATH: packageRoot,
          }
        : {}),
    },
  }
}

/** Drop nested duplicates: binding `/a` makes `/a/b` redundant. */
export const dedupePaths = (paths: readonly string[]): string[] => {
  const unique = [...new Set(paths.filter((entry) => entry.length > 0))]
  return unique.filter(
    (candidate) =>
      !unique.some(
        (other) =>
          other !== candidate &&
          (candidate === other || candidate.startsWith(`${other}/`)),
      ),
  )
}

export const resolveEngines = async (
  options: ResolveEnginesOptions = {},
): Promise<ResolveEnginesResult> => {
  const engines = options.engines ?? ['semgrep']
  const log = options.log ?? (() => {})

  const resolved: ResolvedEngine[] = []
  const unavailable: EngineUnavailable[] = []

  for (const engine of engines) {
    if (engine === 'semgrep') {
      const result = await resolveSemgrep(options)
      if ('reason' in result) {
        log(`[prepare] semgrep unavailable: ${result.reason}`)
        unavailable.push(result as EngineUnavailable)
      } else {
        log(
          `[prepare] semgrep ${result.version} at ${result.binary} ` +
            `(roots: ${result.readOnlyRoots.join(', ')})`,
        )
        resolved.push(result)
      }
      continue
    }

    unavailable.push({
      engine,
      reason: 'recognized, but WindBreak does not drive this engine yet',
      unimplemented: true,
    })
  }

  return { resolved, unavailable }
}

/** Resolve the engines this stage will actually run, failing closed. */
export interface RequireEnginesOptions extends ResolveEnginesOptions {
  /** Engines the caller demands. A missing one is an error, not a skip. */
  required: readonly string[]
}

export class EngineUnavailableError extends Error {
  constructor(readonly missing: EngineUnavailable[]) {
    super(
      `Required engine(s) unavailable: ` +
        missing.map((entry) => `${entry.engine} (${entry.reason})`).join('; ') +
        `. Refusing to run with a thinner detection net than configured (spec §4.3).`,
    )
    this.name = 'EngineUnavailableError'
  }
}

/**
 * Resolve required engines or throw.
 *
 * Fail-closed by decision: a silently thinner detection net is exactly the §3
 * recall failure this stage exists to attack, so a configured-but-missing
 * engine stops the stage rather than being skipped with a warning.
 */
export const requireEngines = async (
  options: RequireEnginesOptions,
): Promise<{ resolved: ResolvedEngine[]; unavailable: EngineUnavailable[] }> => {
  const result = await resolveEngines({
    ...options,
    engines: options.required,
  })

  const unavailableByName = new Map(
    result.unavailable.map((entry) => [entry.engine, entry]),
  )
  const missing = options.required.flatMap((engine) => {
    const entry = unavailableByName.get(engine)
    return entry ? [entry] : []
  })

  if (missing.length > 0) throw new EngineUnavailableError(missing)

  return result
}
