export { detectBuildSystem } from './detect'
export type {
  BuildSystem,
  BuildSystemDetection,
  CompileCommandsStrategy,
} from './detect'

export { createBuildPlan } from './plan'
export type { BuildPlan, BuildStep, CreateBuildPlanInput } from './plan'

export {
  buildStepArgv,
  findCompileCommands,
  prepareBuild,
  runBuild,
} from './run'
export type {
  BuildResult,
  BuildStepOutcome,
  PreparedBuild,
  RunBuildOptions,
} from './run'
