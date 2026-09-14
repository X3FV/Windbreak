import fs from 'fs'
import path from 'path'

import { resolveBackend } from '../sandbox/backends'
import { createSandboxPolicy } from '../sandbox/policy'
import { buildSandboxArgv, runInSandbox } from '../sandbox/run'
import { detectBuildSystem } from './detect'
import { createBuildPlan } from './plan'

import type { DetectOptions, ResolvedBackend } from '../sandbox/backends'
import type { SandboxBackendName, SandboxPolicy } from '../sandbox/types'
import type { SandboxSpawn } from '../sandbox/run'
import type { BuildSystemDetection } from './detect'
import type { BuildPlan, BuildStep } from './plan'

/** Directory names never worth copying into scratch. */
const COPY_EXCLUDES = new Set(['.git'])

export interface RunBuildOptions {
  /** Absolute (or resolvable) path to the checkout. */
  checkoutDir: string
  /** Absolute (or resolvable) path to per-run scratch. */
  scratchDir: string
  /** Also compile, not just configure. Default false (spec §9 budget). */
  compile?: boolean
  jobs?: number
  /** Overrides the sandbox default. */
  timeLimitSeconds?: number
  preferredBackend?: SandboxBackendName
  detect?: DetectOptions
  /** Injected for tests. */
  listDirectory?: (dir: string) => string[]
  log?: (line: string) => void
}

/**
 * Everything decided before anything runs: the detection, the plan, the bind
 * policy, and the backend. `--dry-run` prints exactly this, which is the only
 * way to inspect the sandboxed argv without executing target code.
 */
export interface PreparedBuild {
  detection: BuildSystemDetection
  plan: BuildPlan
  checkoutDir: string
  scratchDir: string
  /** Where sources live inside the sandbox — what analysis should read. */
  sourceDir: string
  buildDir: string
  policy: SandboxPolicy
  backend: ResolvedBackend
  warnings: string[]
}

export interface BuildStepOutcome {
  step: BuildStep
  argv: string[]
  exitCode: number
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
}

export interface BuildResult extends Omit<PreparedBuild, 'backend'> {
  backend: SandboxBackendName
  stepOutcomes: BuildStepOutcome[]
  ok: boolean
  /** Path to a compile_commands.json that actually exists, or null. */
  compileCommandsPath: string | null
}

const defaultListDirectory = (dir: string): string[] => fs.readdirSync(dir)

/**
 * Find a compilation database anywhere under `root`.
 *
 * Build tools disagree about where to put it (CMake puts it in the build dir,
 * some projects copy it to the root), so the expected path is checked first and
 * a bounded walk is the fallback.
 */
export const findCompileCommands = (
  root: string,
  maxDepth = 4,
): string | null => {
  const walk = (dir: string, depth: number): string | null => {
    if (depth > maxDepth) return null

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }

    if (entries.some((entry) => entry.name === 'compile_commands.json')) {
      return path.join(dir, 'compile_commands.json')
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || COPY_EXCLUDES.has(entry.name)) continue
      const found = walk(path.join(dir, entry.name), depth + 1)
      if (found) return found
    }

    return null
  }

  return walk(root, 0)
}

/** Copy a checkout into scratch, skipping `.git`. */
const copySourceTree = (from: string, to: string): void => {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (source) => !COPY_EXCLUDES.has(path.basename(source)),
  })
}

/**
 * Decide the build without executing anything.
 *
 * The security property that matters is established here: the **original
 * checkout is never writable**. Out-of-source build systems get a read-only
 * bind of it; in-source ones are not bound at all and run against a copy in
 * scratch, so the original is untouched by construction rather than by trust
 * (spec §6.2, §6.4).
 */
export const prepareBuild = (options: RunBuildOptions): PreparedBuild => {
  const listDirectory = options.listDirectory ?? defaultListDirectory

  const checkoutDir = path.resolve(options.checkoutDir)
  const scratchDir = path.resolve(options.scratchDir)
  const buildDir = path.join(scratchDir, 'build')

  const detection = detectBuildSystem(listDirectory(checkoutDir))

  const sourceMode = detection.writesInSource ? 'copy' : 'read-only'
  const sourceDir =
    sourceMode === 'copy' ? path.join(scratchDir, 'src') : checkoutDir

  const plan = createBuildPlan({
    detection,
    checkoutDir,
    buildDir,
    sourceDir,
    sourceMode,
    compile: options.compile ?? false,
    jobs: options.jobs,
  })

  const warnings = [...plan.warnings]

  if (sourceMode === 'copy') {
    warnings.push(
      `The ${detection.system} build writes into the source tree, so the tree ` +
        `is copied to scratch and the original checkout is not bound at all.`,
    )
  }

  const policy = createSandboxPolicy({
    readOnlyBinds:
      sourceMode === 'read-only'
        ? [{ source: checkoutDir, dest: checkoutDir }]
        : [],
    writableBinds: [{ source: scratchDir, dest: scratchDir }],
    workingDirectory: buildDir,
    ...(options.timeLimitSeconds !== undefined
      ? { timeLimitSeconds: options.timeLimitSeconds }
      : {}),
  })

  const backend = resolveBackend({
    ...options.detect,
    ...(options.preferredBackend
      ? { preferred: options.preferredBackend }
      : {}),
  })

  return {
    detection,
    plan,
    checkoutDir,
    scratchDir,
    sourceDir,
    buildDir,
    policy,
    backend,
    warnings,
  }
}

/**
 * Run the target's build inside the sandbox.
 *
 * Configure-only by default: ingestion gets 10% of the target budget (§9), and
 * a full compile of a large project does not fit. `compile: true` opts in.
 */
export const runBuild = async (
  options: RunBuildOptions & { spawn?: SandboxSpawn },
): Promise<BuildResult> => {
  const log = options.log ?? (() => {})
  const prepared = prepareBuild(options)
  const { plan, policy, sourceDir, scratchDir, backend } = prepared

  const warnings = [...prepared.warnings]

  fs.mkdirSync(prepared.buildDir, { recursive: true })

  if (plan.sourceMode === 'copy') {
    log(`Copying ${prepared.checkoutDir} -> ${sourceDir}`)
    copySourceTree(prepared.checkoutDir, sourceDir)
  }

  const stepOutcomes: BuildStepOutcome[] = []

  for (const step of plan.steps) {
    // bwrap's --chdir requires the directory to exist already.
    fs.mkdirSync(step.cwd, { recursive: true })

    const request = {
      policy,
      command: step.command,
      workingDirectory: step.cwd,
    }
    log(`[build] ${step.description}`)

    const result = await runInSandbox(request, {
      preferred: backend.name,
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
    })

    stepOutcomes.push({
      step,
      argv: result.argv,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    })

    if (result.timedOut) {
      warnings.push(
        `Step "${step.description}" was killed at the ${policy.timeLimitSeconds}s limit.`,
      )
      break
    }

    if (result.exitCode !== 0) {
      warnings.push(
        `Step "${step.description}" exited ${result.exitCode}: ` +
          `${result.stderr.trim().split('\n')[0] ?? 'no stderr'}`,
      )
      break
    }
  }

  let compileCommandsPath: string | null = null
  if (plan.compileCommandsPath && fs.existsSync(plan.compileCommandsPath)) {
    compileCommandsPath = plan.compileCommandsPath
  } else {
    compileCommandsPath = findCompileCommands(scratchDir)
  }

  if (!compileCommandsPath) {
    warnings.push(
      'No compile_commands.json was produced; the target is best-effort and ' +
        'engine-dependent stages should be downgraded (spec §18).',
    )
  }

  const ok =
    stepOutcomes.length > 0 &&
    stepOutcomes.every((outcome) => outcome.exitCode === 0)

  return {
    ...prepared,
    backend: backend.name,
    stepOutcomes,
    ok,
    compileCommandsPath,
    warnings,
  }
}

/** The exact argv each step would run, for `--dry-run`. */
export const buildStepArgv = (
  prepared: PreparedBuild,
): Array<{ step: BuildStep; argv: string[] }> =>
  prepared.plan.steps.map((step) => ({
    step,
    argv: buildSandboxArgv(
      {
        policy: prepared.policy,
        command: step.command,
        workingDirectory: step.cwd,
      },
      prepared.backend,
    ),
  }))
