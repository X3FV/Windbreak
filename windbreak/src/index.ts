#!/usr/bin/env bun
// First import on purpose: `@codebuff/common/env` validates `process.env` at
// import time, and this is what supplies the public NEXT_PUBLIC_* values a
// source checkout does not have. See `pre-init/client-env.ts`.
import './pre-init/client-env'

import { Command } from 'commander'

import { registerAuthCommand } from './commands/auth'
import { registerBuildCommand } from './commands/build'
import { registerConfigCommand } from './commands/config'
import { registerDbCommand } from './commands/db'
import { registerEnginesCommand } from './commands/engines'
import { registerEvalCommand } from './commands/eval'
import { registerFetchCommand } from './commands/fetch'
import { registerLibraryCommand } from './commands/library'
import { registerOsvCommand } from './commands/osv'
import { registerPipelineCommand } from './commands/pipeline'
import { registerPatchMineCommand } from './commands/patch-mine'
import { registerPrepareCommand } from './commands/prepare'
import { registerReconCommand } from './commands/recon'
import { registerScanCommand } from './commands/scan'
import { registerReportCommand } from './commands/report'
import { registerReviewCommand } from './commands/review'
import { registerSandboxCommand } from './commands/sandbox'
import { registerToctouCommand } from './commands/toctou'
import { VERSION } from './version'

export { VERSION }

export const createProgram = (): Command => {
  const program = new Command()

  program
    .name('windbreak')
    .description(
      'AI-assisted vulnerability discovery harness for open source codebases',
    )
    .version(VERSION)

  registerAuthCommand(program)
  registerBuildCommand(program)
  registerConfigCommand(program)
  registerDbCommand(program)
  registerEnginesCommand(program)
  registerEvalCommand(program)
  registerFetchCommand(program)
  registerLibraryCommand(program)
  registerOsvCommand(program)
  registerPipelineCommand(program)
  registerPatchMineCommand(program)
  registerPrepareCommand(program)
  registerReconCommand(program)
  registerReportCommand(program)
  registerReviewCommand(program)
  registerSandboxCommand(program)
  registerScanCommand(program)
  registerToctouCommand(program)

  // §7.3's surface is complete. `commands/not-implemented.ts` registered the
  // stubs while it was not; `eval` was the last one, so it is gone rather than
  // left as a hook for the next stage that is specified before it is built.
  return program
}

if (import.meta.main) {
  createProgram().parse(process.argv)
}
