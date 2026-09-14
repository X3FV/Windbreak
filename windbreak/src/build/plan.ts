import path from 'path'

import type { BuildSystemDetection } from './detect'

export interface BuildStep {
  description: string
  /** Absolute command. Paths are absolute, and are bound at the same path. */
  command: string[]
  /** Absolute directory to run in, inside the sandbox. */
  cwd: string
}

export interface BuildPlan {
  detection: BuildSystemDetection
  /**
   * `read-only` binds the checkout read-only and builds beside it.
   * `copy` runs against a writable copy in scratch, because the build writes
   * into the source tree.
   */
  sourceMode: 'read-only' | 'copy'
  steps: BuildStep[]
  /** Absolute path compile_commands.json is expected at, if any. */
  compileCommandsPath: string | null
  warnings: string[]
}

export interface CreateBuildPlanInput {
  detection: BuildSystemDetection
  /** Absolute host path of the checkout. */
  checkoutDir: string
  /** Absolute host path of the build directory inside scratch. */
  buildDir: string
  /** Absolute host path where the source tree lives inside the sandbox. */
  sourceDir: string
  /**
   * Chosen by the caller (it determines where `sourceDir` points, so it cannot
   * be derived from the source tree after the fact).
   */
  sourceMode: 'read-only' | 'copy'
  /** Also run the compile, not just the configure step. */
  compile: boolean
  /** Parallelism for build tools. */
  jobs?: number
}

/**
 * Plan the build.
 *
 * Default is **configure only** where a configure step is enough to emit a
 * compilation database. Actually compiling is opt-in (`compile: true`) because
 * ingestion gets 10% of the target budget (spec §9) and a full build of a large
 * project does not fit in six minutes.
 */
export const createBuildPlan = (input: CreateBuildPlanInput): BuildPlan => {
  const { detection, buildDir, sourceDir, sourceMode, compile } = input
  const jobs = input.jobs ?? 4
  const warnings: string[] = []
  const steps: BuildStep[] = []
  let compileCommandsPath: string | null = null

  switch (detection.system) {
    case 'cmake': {
      const cmakeBuildDir = path.join(buildDir, 'cmake')
      compileCommandsPath = path.join(cmakeBuildDir, 'compile_commands.json')
      steps.push({
        description: 'cmake configure with CMAKE_EXPORT_COMPILE_COMMANDS',
        command: [
          'cmake',
          '-S',
          sourceDir,
          '-B',
          cmakeBuildDir,
          '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
          '-DCMAKE_BUILD_TYPE=Debug',
        ],
        cwd: cmakeBuildDir,
      })
      if (compile) {
        steps.push({
          description: 'cmake build',
          command: ['cmake', '--build', cmakeBuildDir, '-j', String(jobs)],
          cwd: cmakeBuildDir,
        })
      }
      break
    }

    case 'meson': {
      const mesonBuildDir = path.join(buildDir, 'meson')
      compileCommandsPath = path.join(mesonBuildDir, 'compile_commands.json')
      steps.push({
        description: 'meson setup',
        command: ['meson', 'setup', mesonBuildDir, sourceDir],
        cwd: mesonBuildDir,
      })
      if (compile) {
        steps.push({
          description: 'meson compile',
          command: ['meson', 'compile', '-C', mesonBuildDir],
          cwd: mesonBuildDir,
        })
      }
      break
    }

    case 'autotools': {
      const autotoolsBuildDir = path.join(buildDir, 'autotools')
      compileCommandsPath = path.join(autotoolsBuildDir, 'compile_commands.json')
      steps.push({
        description: 'autotools out-of-source configure (VPATH)',
        command: [path.join(sourceDir, 'configure')],
        cwd: autotoolsBuildDir,
      })
      if (compile) {
        steps.push({
          description: 'bear-instrumented make',
          command: ['bear', '--', 'make', '-j', String(jobs)],
          cwd: autotoolsBuildDir,
        })
      } else {
        warnings.push(
          'autotools needs a real instrumented build (bear -- make) to emit ' +
            'compile_commands.json; without --compile the run is best-effort.',
        )
      }
      break
    }

    case 'make': {
      // Plain make builds in the source tree, so `sourceMode` is `copy` and the
      // command runs in the copied tree rather than a separate build dir.
      compileCommandsPath = path.join(sourceDir, 'compile_commands.json')
      if (compile) {
        steps.push({
          description: 'bear-instrumented make',
          command: ['bear', '--', 'make', '-j', String(jobs)],
          cwd: sourceDir,
        })
      } else {
        warnings.push(
          'plain Make needs a real instrumented build (bear -- make) to emit ' +
            'compile_commands.json; without --compile the run is best-effort.',
        )
      }
      break
    }

    case 'bazel':
    case 'cargo':
    case 'npm':
    case 'unknown':
    default: {
      warnings.push(
        detection.system === 'unknown'
          ? 'No recognised build system; the run is best-effort with no compilation database.'
          : `${detection.system} has no supported path to compile_commands.json in WindBreak yet; the run is best-effort.`,
      )
      break
    }
  }

  return {
    detection,
    sourceMode,
    steps,
    compileCommandsPath,
    warnings,
  }
}
