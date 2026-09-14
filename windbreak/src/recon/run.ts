import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import { runBuild } from '../build'
import { resolveBackend } from '../sandbox/backends'
import { createSandboxPolicy } from '../sandbox/policy'
import { runInSandbox } from '../sandbox/run'
import { findManifests } from './deps'
import { checkDirty, readGitRefs } from './git'
import { collectInventory } from './inventory'
import { detectLanguages } from './languages'
import { buildProgramModel } from './program-model'

import type { Database } from 'bun:sqlite'
import type { DetectOptions } from '../sandbox/backends'
import type { SandboxSpawn } from '../sandbox/run'
import type { SandboxBackendName } from '../sandbox/types'
import type { ManifestRef } from './deps'
import type { GitState } from './git'
import type { LanguageInventory } from './languages'
import type { ProgramModelResult } from './program-model'

export type ScopeClass = 'kernel' | 'userspace-c' | 'app'
export type BuildModel = 'compile_commands' | 'best-effort'

/** Spec §14.2. */
export interface TargetRecord {
  id: string
  location: string
  commitSha: string
  languages: LanguageInventory[]
  buildModel: BuildModel
  scopeClass: ScopeClass
}

/**
 * What recon is asked to survey — all of it JSON (§20.17.3).
 *
 * `target` is a host path, which is worth being explicit about: it is a string,
 * so it crosses a pipe happily, and it means nothing to a worker whose filesystem
 * is not the host's. Recon's isolation is at the sandbox (the target build), not
 * at this boundary — see §20.17.2.
 */
export interface ReconRequest {
  /** Path to the checkout. */
  target: string
  /** Expected commit. Recon does not check it out; it records and flags a mismatch. */
  commit?: string
  scratchDir?: string
  /** Run the sandboxed build step. Default true. */
  build?: boolean
  jobs?: number
  timeLimitSeconds?: number
  preferredBackend?: SandboxBackendName
  scopeClass?: ScopeClass
  /** Sandboxed `git status` for the dirty check. Default true. */
  checkWorkingTree?: boolean
}

/**
 * What recon needs from the host — none of it serializable.
 *
 * `detect` is the interesting one. It looks like configuration and reads like
 * configuration, but `DetectOptions.isExecutable` is a callback, so it is a
 * service: a worker cannot carry it, and a `JsonCompatible` assertion on
 * `ReconRequest` would reject it — correctly.
 */
export interface ReconServices {
  detect?: DetectOptions
  spawn?: SandboxSpawn
  listDirectory?: (dir: string) => string[]
  /** When supplied, the target, inventory, and program model are persisted. */
  db?: Database
  log?: (line: string) => void
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type RunReconOptions = ReconRequest & ReconServices

export interface BuildSummary {
  model: BuildModel
  system: string
  sourceMode: string
  compileCommandsPath: string | null
  ok: boolean
  /** True when the build step was not run at all. */
  skipped: boolean
}

export interface ReconResult {
  target: TargetRecord
  inventory: {
    fileCount: number
    totalBytes: number
    truncated: boolean
    ignoredDirectories: number
  }
  languages: LanguageInventory[]
  dependencyManifests: ManifestRef[]
  git: GitState
  build: BuildSummary
  programModel: ProgramModelResult | null
  warnings: string[]
}

const KERNEL_TOP_LEVEL_MARKERS = new Set(['Kconfig', 'Kbuild'])
const KERNEL_PATH_PREFIXES = ['arch/', 'drivers/', 'kernel/', 'mm/', 'fs/']

/**
 * Classify the target.
 *
 * Heuristic and deliberately conservative: a wrong `kernel` label only affects
 * which engine profiles run, while mislabelling a kernel as an app would drop
 * the kernel-specific engines entirely.
 */
export const inferScopeClass = (
  files: readonly { path: string }[],
  languages: readonly LanguageInventory[],
): ScopeClass => {
  const topLevel = new Set(
    files.filter((file) => !file.path.includes('/')).map((file) => file.path),
  )

  for (const marker of KERNEL_TOP_LEVEL_MARKERS) {
    if (topLevel.has(marker)) return 'kernel'
  }

  for (const prefix of KERNEL_PATH_PREFIXES) {
    if (files.some((file) => file.path.startsWith(prefix))) return 'kernel'
  }

  if (
    languages.some(
      (entry) => entry.language === 'c' || entry.language === 'cpp',
    )
  ) {
    return 'userspace-c'
  }

  return 'app'
}

/** Stable across runs so re-running recon on one commit replaces its rows. */
export const createTargetId = (
  absoluteLocation: string,
  commitSha: string | null,
): string =>
  createHash('sha256')
    .update(`${absoluteLocation}@${commitSha ?? 'unknown'}`)
    .digest('hex')
    .slice(0, 16)

/**
 * Run the sandboxed `git status` used for the dirty check.
 *
 * The checkout is bound read-only and `--no-optional-locks` is set, so git does
 * not try to refresh the index. `core.fsmonitor=false` matters because
 * `core.fsmonitor` from an untrusted `.git/config` is arbitrary command
 * execution — this is the one place recon runs target-adjacent code, and it
 * does so inside the sandbox.
 */
export const createSandboxGitRunner = (
  rootDir: string,
  options: Pick<
    RunReconOptions,
    'preferredBackend' | 'detect' | 'spawn' | 'timeLimitSeconds'
  > = {},
) => {
  return async (args: string[]): Promise<{ exitCode: number; stdout: string }> => {
    const policy = createSandboxPolicy({
      readOnlyBinds: [{ source: rootDir, dest: rootDir }],
      writableBinds: [],
      workingDirectory: rootDir,
      ...(options.timeLimitSeconds !== undefined
        ? { timeLimitSeconds: options.timeLimitSeconds }
        : {}),
    })

    const result = await runInSandbox(
      { policy, command: ['git', ...args], workingDirectory: rootDir },
      {
        ...(options.preferredBackend
          ? { preferred: options.preferredBackend }
          : {}),
        ...(options.detect ? { detect: options.detect } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
      },
    )

    return { exitCode: result.exitCode, stdout: result.stdout }
  }
}

export const runRecon = async (
  options: RunReconOptions,
): Promise<ReconResult> => {
  const log = options.log ?? (() => {})
  const warnings: string[] = []

  const root = path.resolve(options.target)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`)
  }

  log(`[recon] inventory ${root}`)
  const inventory = collectInventory(root)
  warnings.push(...inventory.warnings)

  const languages = detectLanguages(inventory.files)
  const dependencyManifests = findManifests(
    inventory.files.filter((file) => !file.binary),
  )

  const gitRefs = readGitRefs(root)
  warnings.push(...gitRefs.warnings)

  if (options.commit && gitRefs.commitSha && options.commit !== gitRefs.commitSha) {
    warnings.push(
      `Requested commit ${options.commit} but the checkout is at ${gitRefs.commitSha}. ` +
        `Recon records the requested commit; it does not check anything out.`,
    )
  }

  const commitSha =
    options.commit ?? gitRefs.commitSha ?? 'unknown'
  if (!gitRefs.commitSha && !options.commit) {
    warnings.push(
      'No commit could be resolved, so the target is not pinned to an immutable revision (spec §4.1).',
    )
  }

  let dirty: boolean | null = null
  if (options.checkWorkingTree !== false) {
    if (gitRefs.isRepository) {
      const runner = createSandboxGitRunner(root, options)
      const dirtyResult = await checkDirty(runner)
      dirty = dirtyResult.dirty
      if (dirtyResult.warning) warnings.push(dirtyResult.warning)
      if (dirty === true) {
        warnings.push(
          'The working tree has uncommitted changes, so this scan does not correspond to a committed revision.',
        )
      }
    }
  }

  const git: GitState = { ...gitRefs, dirty }

  const scratchDir =
    options.scratchDir ??
    path.join(process.cwd(), '.windbreak', 'scratch', 'recon')

  let build: BuildSummary = {
    model: 'best-effort',
    system: 'unknown',
    sourceMode: 'read-only',
    compileCommandsPath: null,
    ok: false,
    skipped: true,
  }

  if (options.build !== false) {
    log('[recon] sandboxed build')
    const buildResult = await runBuild({
      checkoutDir: root,
      scratchDir,
      compile: false,
      ...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
      ...(options.timeLimitSeconds !== undefined
        ? { timeLimitSeconds: options.timeLimitSeconds }
        : {}),
      ...(options.preferredBackend
        ? { preferredBackend: options.preferredBackend }
        : {}),
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    })

    warnings.push(...buildResult.warnings)

    build = {
      model: buildResult.compileCommandsPath ? 'compile_commands' : 'best-effort',
      system: buildResult.detection.system,
      sourceMode: buildResult.plan.sourceMode,
      compileCommandsPath: buildResult.compileCommandsPath,
      ok: buildResult.ok,
      skipped: false,
    }
  } else {
    warnings.push(
      'Build step skipped, so no compilation database was produced; the target is best-effort.',
    )
  }

  const target: TargetRecord = {
    id: createTargetId(root, commitSha),
    location: root,
    commitSha,
    languages,
    buildModel: build.model,
    scopeClass: options.scopeClass ?? inferScopeClass(inventory.files, languages),
  }

  let programModel: ProgramModelResult | null = null
  if (options.db) {
    // The target row must land before its child rows: `recon_files`, `symbols`,
    // and `symbol_refs` all carry a foreign key to `targets`, and the database
    // runs with `PRAGMA foreign_keys = ON`.
    options.db
      .prepare(
        // UPSERT, not INSERT OR REPLACE: REPLACE deletes the existing row, and
        // `dependencies` / `osv_matches` cascade off `targets` on delete — so
        // re-running recon on the same commit would silently discard the OSV
        // correlation (§4.2) and reset `osv_status`. An UPSERT updates in place.
        `INSERT INTO targets
           (id, location, commit_sha, languages_json, build_model, scope_class, program_model_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           location = excluded.location,
           commit_sha = excluded.commit_sha,
           languages_json = excluded.languages_json,
           build_model = excluded.build_model,
           scope_class = excluded.scope_class,
           program_model_path = excluded.program_model_path,
           created_at = excluded.created_at`,
      )
      .run(
        target.id,
        target.location,
        target.commitSha,
        JSON.stringify(target.languages),
        target.buildModel,
        target.scopeClass,
        options.db.filename ?? null,
        new Date().toISOString(),
      )

    log('[recon] program model')
    programModel = await buildProgramModel({
      db: options.db,
      targetId: target.id,
      files: inventory.files,
    })
    warnings.push(...programModel.warnings)
  }

  // A sandbox that cannot start only degrades the dirty check; the build step
  // already hard-fails on its own (spec §18), so this is not swallowed.
  if (options.build === false) {
    try {
      resolveBackend({
        ...options.detect,
        ...(options.preferredBackend ? { preferred: options.preferredBackend } : {}),
      })
    } catch {
      warnings.push(
        'No sandbox backend was available for this run; only filesystem reads were performed.',
      )
    }
  }

  return {
    target,
    inventory: {
      fileCount: inventory.files.length,
      totalBytes: inventory.totalBytes,
      truncated: inventory.truncated,
      ignoredDirectories: inventory.ignoredDirectories,
    },
    languages,
    dependencyManifests,
    git,
    build,
    programModel,
    warnings,
  }
}
