/**
 * Semgrep adapter (spec §4.3).
 *
 * Invoked as a subprocess, never vendored or linked: Semgrep's engine is LGPL,
 * so this module only builds argv and reads output. Output is SARIF because
 * that is the format §13 already commits to, which means the adapter needs no
 * Semgrep-specific result schema.
 */

import { parseSarif } from './sarif'

import type { SarifParseResult } from './sarif'
import type { RawFinding } from './types'

export const SEMGREP_ENGINE_ID = 'semgrep'
export const SEMGREP_BINARY = 'semgrep'

/** Semgrep's default per-file, per-rule timeout, in seconds. */
export const DEFAULT_SEMGREP_TIMEOUT_SECONDS = 30
/** Semgrep's own default; larger files are skipped rather than buffered. */
export const DEFAULT_SEMGREP_MAX_TARGET_BYTES = 1_000_000
/**
 * Defaults to a single job deliberately. `semgrep-core` is an OCaml process per
 * worker with a large address-space footprint, and the sandbox caps address
 * space per process (§6.2). With `--jobs 4` the engine was killed for memory
 * mid-scan and returned exit 2 with valid-but-empty SARIF — a silent recall
 * loss, which is the worst possible failure for this stage. Parallelism is
 * opt-in via config for targets and machines that can afford it.
 */
export const DEFAULT_SEMGREP_JOBS = 1

export interface SemgrepInvocation {
  /** Rule files or directories, as paths inside the sandbox. */
  rulePaths: readonly string[]
  /** Target files or directories, as paths inside the sandbox. */
  targetPaths: readonly string[]
  /** Directory patterns to skip, e.g. recon's ignored directories. */
  excludedDirectories?: readonly string[]
  jobs?: number
  timeoutSeconds?: number
  maxTargetBytes?: number
  /** Extra rules, e.g. a config-supplied path. Appended, not replaced. */
  extraRulePaths?: readonly string[]
}

/**
 * Build Semgrep's argv.
 *
 * `--metrics off` and `--disable-version-check` are not optional niceties: the
 * sandbox has no route (D20/§6.3), so any telemetry or update check would
 * either fail noisily or stall the stage. `--sarif` sends results to stdout,
 * which is the only channel the runner reads.
 *
 * `--no-rewrite-rule-ids` matters more than it looks: given a local `--config`
 * path, Semgrep prefixes every rule id with that path, so
 * `wb-c-unbounded-string-op` arrives as
 * `home.vx77.projects.windbreak.rules.wb-c-unbounded-string-op`. Rule ids are
 * the candidate's `pattern_id` and the key Phase A patterns and the pattern
 * library (§10) match on, so they must be stable across machines and rule-file
 * locations.
 */
export const buildSemgrepArgv = (invocation: SemgrepInvocation): string[] => {
  const argv = [SEMGREP_BINARY]

  for (const rulePath of [...invocation.rulePaths, ...(invocation.extraRulePaths ?? [])]) {
    argv.push('--config', rulePath)
  }

  argv.push(
    '--sarif',
    '--metrics',
    'off',
    '--disable-version-check',
    '--no-rewrite-rule-ids',
    '--quiet',
    '--jobs',
    String(invocation.jobs ?? DEFAULT_SEMGREP_JOBS),
    '--timeout',
    String(invocation.timeoutSeconds ?? DEFAULT_SEMGREP_TIMEOUT_SECONDS),
    '--max-target-bytes',
    String(invocation.maxTargetBytes ?? DEFAULT_SEMGREP_MAX_TARGET_BYTES),
  )

  for (const directory of invocation.excludedDirectories ?? []) {
    argv.push('--exclude', directory)
  }

  argv.push(...invocation.targetPaths)

  return argv
}

/**
 * Read Semgrep's SARIF from stdout.
 *
 * A non-JSON or empty stdout is a *warning*, not an empty result set — an
 * engine that failed must never look like an engine that found nothing.
 */
export const parseSemgrepOutput = (stdout: string): SarifParseResult => {
  const trimmed = stdout.trim()

  if (trimmed.length === 0) {
    return {
      findings: [],
      warnings: ['semgrep produced no output on stdout'],
      executionFailed: false,
    }
  }

  let document: unknown
  try {
    document = JSON.parse(trimmed)
  } catch {
    return {
      findings: [],
      warnings: ['semgrep output on stdout was not valid JSON'],
      executionFailed: false,
    }
  }

  return parseSarif(document, SEMGREP_ENGINE_ID as RawFinding['engine'])
}
