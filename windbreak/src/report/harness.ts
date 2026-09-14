/**
 * Manual harness generation (spec §4.7, §12.4).
 *
 * D21: WindBreak generates the harness and **does not execute it**. This module
 * is pure — it returns file contents and instructions as data and spawns
 * nothing. Actually running a harness is the researcher's job, outside
 * WindBreak; a future automated fuzzer slots in behind §12.4's interface without
 * redesign, which is why the output shape matches it.
 *
 * The generated PoC is a *skeleton*, and says so. It compiles against the
 * target, marks every decision the researcher has to make, and does not pretend
 * to be a working exploit: a harness that looks complete but silently does
 * nothing would waste exactly the researcher time this tool exists to protect.
 */

import type { Finding, GeneratedHarness, HarnessFile } from './types'

export interface HarnessBuildStep {
  description: string
  command: string[]
}

export interface BuildHarnessInput {
  finding: Finding
  targetLocation: string
  /** Enclosing function from the symbol index, when one was resolved. */
  functionName: string | null
  /** Build steps for the target, from `createBuildPlan`. */
  buildSteps?: readonly HarnessBuildStep[] | undefined
  /** Absolute path of the target's compilation database, when one exists. */
  compileCommandsPath?: string | null
  /** Program used to compile the skeleton. Defaults by ecosystem. */
  compiler?: string | undefined
}

const SANITIZER_FLAGS = '-g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer'

/** CWE prefix -> what a successful reproduction looks like. */
const EXPECTED_FAILURE: Record<string, string> = {
  'CWE-120':
    'a buffer overrun: expect a crash (SIGSEGV) or an AddressSanitizer ' +
    'stack-buffer-overflow / heap-buffer-overflow report naming the copy.',
  'CWE-121': 'a stack buffer overflow: expect a crash or an ASan stack-buffer-overflow report.',
  'CWE-122': 'a heap buffer overflow: expect a crash or an ASan heap-buffer-overflow report.',
  'CWE-125': 'an out-of-bounds read: expect an ASan heap-buffer-overflow read or a crash.',
  'CWE-787': 'an out-of-bounds write: expect a crash or an ASan report at the write.',
  'CWE-476': 'a NULL pointer dereference: expect SIGSEGV at the dereference site.',
  'CWE-416': 'a use-after-free: expect an ASan heap-use-after-free report.',
  'CWE-415': 'a double free: expect an ASan double-free report.',
  'CWE-190': 'an integer overflow: UBSan reports signed overflow, or the wraparound shows as an ' +
    'implausible size reaching an allocation.',
  'CWE-134': 'a format-string defect: expect a crash when the input contains `%s`/`%n`, or ' +
    'attacker-controlled output.',
  'CWE-78': 'command injection: expect the injected command to execute, observable in its output.',
  'CWE-362': 'a race: expect non-deterministic corruption or a crash under repeated concurrent ' +
    'execution. A single run does NOT disprove this class.',
  'CWE-367':
    'a TOCTOU race: expect non-deterministic corruption only when the check-to-use window is ' +
    'hit. A single run does NOT disprove this class.',
}

const expectedFailureFor = (cwe: string | null): string => {
  const match = cwe ? /CWE-(\d+)/i.exec(cwe) : null
  const key = match ? `CWE-${match[1]}` : null
  if (key && EXPECTED_FAILURE[key]) return EXPECTED_FAILURE[key]!
  return (
    'no class-specific signature is known for this finding. Observe for a crash, an ' +
    'AddressSanitizer/UBSan report, or a failed assertion, and record what you actually see.'
  )
}

const pocSource = (input: {
  finding: Finding
  functionName: string | null
  targetLocation: string
}): string => {
  const fn = input.functionName ?? 'TARGET_FUNCTION'
  const header = input.finding.filePath ?? '<header defining ' + fn + '>'

  return `/*
 * WindBreak reproduction harness — SKELETON, not a working exploit.
 *
 * Generated for: ${input.finding.id}
 * Finding:       ${input.finding.title}
 * Class:         ${input.finding.cwe ?? 'unclassified'}
 * Evidence tier: ${input.finding.evidenceTier}
 * Target:        ${input.targetLocation}
 * Location:      ${input.finding.filePath ?? '(unknown)'}:${input.finding.startLine ?? '?'}
 *
 * WindBreak did not run this and cannot vouch for it. It marks the decisions the
 * researcher has to make; it does not make them.
 */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* TODO: replace with the real header for ${fn}, if any. */
/* #include "${header}" */

/* Declared here so the skeleton compiles even without the header; if you add
 * the include above, delete this declaration so the compiler checks it against
 * the real one. */
extern int ${fn}(void);

int main(void) {
  /*
   * TODO: build the input this function mishandles.
   *
   * The candidate was flagged at ${input.finding.filePath ?? '(unknown)'}:${input.finding.startLine ?? '?'}.
   * Work out what attacker-controlled data reaches that line:
   *   - length: choose input longer than the destination it is copied into
   *   - content: for a format-string finding, include "%s" or "%n"
   *   - timing: for a race, drive the check and the use from two threads
   */
  char input[4096];
  memset(input, 'A', sizeof(input) - 1);
  input[sizeof(input) - 1] = '\\0';

  /* TODO: call the function the way the real caller does. */
  int result = ${fn}();

  printf("returned %d\\n", result);
  return 0;
}
`
}

const RUN_SCRIPT = `#!/usr/bin/env bash
# WindBreak reproduction harness — build and run instructions.
#
#   WindBreak generated this file and did NOT execute it.
#   Running it is your decision, on your machine, outside WindBreak (spec D21).
#
# It is a starting point: read it before running it.
set -euo pipefail
`

export const generateHarness = (input: BuildHarnessInput): GeneratedHarness => {
  const compiler = input.compiler ?? 'cc'
  const functionName = input.functionName ?? 'TARGET_FUNCTION'

  const buildInstructions: string[] = []
  buildInstructions.push(
    `WindBreak wrote this harness but did not build or run it. Nothing below has been executed.`,
  )

  if (input.buildSteps && input.buildSteps.length > 0) {
    buildInstructions.push('', 'Build the target first, exactly as recon did it:')
    for (const step of input.buildSteps) {
      buildInstructions.push(`  ${step.command.join(' ')}   # ${step.description}`)
    }
  }

  if (input.compileCommandsPath) {
    buildInstructions.push(
      '',
      `The target's compilation database is at ${input.compileCommandsPath}; copying the flags ` +
        'for the translation unit that defines the function under test is the most reliable ' +
        'way to match the real build.',
    )
  }

  buildInstructions.push(
    '',
    'Then build the skeleton with sanitizers enabled, so the failure is observable:',
    `  ${compiler} ${SANITIZER_FLAGS} -o poc poc.c <target objects or sources>`,
    '',
    'Run it:',
    '  ./poc',
    '',
    'If the defect is a race, a single run proves nothing — repeat the run under load, or use ' +
      'a thread-sanitizer build (-fsanitize=thread), and expect non-determinism.',
  )

  const files: HarnessFile[] = [
    {
      name: 'poc.c',
      contents: pocSource({
        finding: input.finding,
        functionName: input.functionName,
        targetLocation: input.targetLocation,
      }),
      executable: false,
    },
    {
      name: 'build-and-run.sh',
      contents: `${RUN_SCRIPT}\n${buildInstructions.map((line) => `# ${line}`).join('\n')}\n`,
      executable: true,
    },
  ]

  const researcherInstructions = [
    'This harness was generated, not executed. WindBreak never runs it (spec D21).',
    `1. Complete the TODOs in poc.c: include the real header for ${functionName}, and build the`,
    '   input that reaches the flagged line with attacker-controlled data.',
    '2. Build it with the sanitizer flags in build-and-run.sh and run it outside WindBreak.',
    `3. Expected observable failure: ${expectedFailureFor(input.finding.cwe)}`,
    `4. If it reproduces, record that with \`windbreak report --reproduced ${input.finding.candidateId}\` so the`,
    '   writeup states the stronger evidence tier (human-reproduced).',
    '5. If it does not reproduce, the candidate is not disproven — say what you tried. A failed',
    '   reproduction is evidence, and it is what feeds the negative examples in the pattern library.',
  ].join('\n')

  return {
    files,
    buildInstructions,
    expectedFailure: expectedFailureFor(input.finding.cwe),
    researcherInstructions,
  }
}
