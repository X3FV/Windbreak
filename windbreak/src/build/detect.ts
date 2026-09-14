/**
 * Build-system detection (spec §4.1).
 *
 * Detection is a pure function of the top-level directory listing so it can be
 * tested without a filesystem, and so `--dry-run` can report the plan it *would*
 * use before anything executes.
 */

export type BuildSystem =
  | 'cmake'
  | 'meson'
  | 'autotools'
  | 'make'
  | 'bazel'
  | 'cargo'
  | 'npm'
  | 'unknown'

export type CompileCommandsStrategy =
  /** The tool writes compile_commands.json itself. */
  | 'native'
  /** Needs an instrumented real build (e.g. `bear -- make`). */
  | 'bear'
  /** No known path to a compilation database. */
  | 'none'

export interface BuildSystemDetection {
  system: BuildSystem
  /** Files whose presence drove the decision. */
  evidence: string[]
  compileCommands: CompileCommandsStrategy
  /**
   * Whether compile_commands.json is obtainable from a configure step alone.
   * When false, producing one requires actually compiling — which the default
   * run does not do, because ingestion is only 10% of the target budget (§9).
   */
  obtainableWithoutCompiling: boolean
  /** Whether the build writes into the source tree. */
  writesInSource: boolean
  ecosystem: 'c' | 'c++' | 'rust' | 'node' | 'unknown'
}

interface Rule {
  system: BuildSystem
  markers: string[]
  compileCommands: CompileCommandsStrategy
  obtainableWithoutCompiling: boolean
  writesInSource: boolean
  ecosystem: BuildSystemDetection['ecosystem']
}

/**
 * Order matters: a CMake project can also contain a `Makefile` wrapper, and an
 * autotools project contains a `Makefile.am`. The most specific marker wins.
 */
const RULES: Rule[] = [
  {
    system: 'cmake',
    markers: ['CMakeLists.txt'],
    compileCommands: 'native',
    obtainableWithoutCompiling: true,
    writesInSource: false,
    ecosystem: 'c++',
  },
  {
    system: 'meson',
    markers: ['meson.build'],
    compileCommands: 'native',
    obtainableWithoutCompiling: true,
    writesInSource: false,
    ecosystem: 'c++',
  },
  {
    system: 'autotools',
    markers: ['configure.ac', 'configure.in', 'configure', 'Makefile.am'],
    compileCommands: 'bear',
    obtainableWithoutCompiling: false,
    writesInSource: false,
    ecosystem: 'c',
  },
  {
    system: 'bazel',
    markers: ['MODULE.bazel', 'WORKSPACE.bazel', 'WORKSPACE', 'BUILD.bazel'],
    compileCommands: 'none',
    obtainableWithoutCompiling: false,
    writesInSource: false,
    ecosystem: 'c++',
  },
  {
    system: 'cargo',
    markers: ['Cargo.toml'],
    compileCommands: 'none',
    obtainableWithoutCompiling: false,
    writesInSource: false,
    ecosystem: 'rust',
  },
  {
    system: 'npm',
    markers: ['package.json'],
    compileCommands: 'none',
    obtainableWithoutCompiling: false,
    writesInSource: false,
    ecosystem: 'node',
  },
  {
    system: 'make',
    markers: ['Makefile', 'makefile', 'GNUmakefile'],
    compileCommands: 'bear',
    obtainableWithoutCompiling: false,
    // Plain make has no out-of-source convention; the build writes next to the
    // sources, so it must run against a writable copy (§6.2).
    writesInSource: true,
    ecosystem: 'c',
  },
]

export const detectBuildSystem = (
  entries: readonly string[],
): BuildSystemDetection => {
  const present = new Set(entries)

  for (const rule of RULES) {
    const evidence = rule.markers.filter((marker) => present.has(marker))
    if (evidence.length === 0) continue

    return {
      system: rule.system,
      evidence,
      compileCommands: rule.compileCommands,
      obtainableWithoutCompiling: rule.obtainableWithoutCompiling,
      writesInSource: rule.writesInSource,
      ecosystem: rule.ecosystem,
    }
  }

  return {
    system: 'unknown',
    evidence: [],
    compileCommands: 'none',
    obtainableWithoutCompiling: false,
    writesInSource: false,
    ecosystem: 'unknown',
  }
}
