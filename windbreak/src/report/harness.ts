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
 *
 * ## What "it compiles" is guaranteed to mean
 *
 * The skeleton declares its own prototype, so it is syntactically valid C on its
 * own. It does not link, and it cannot be checked against the target's real
 * signature — that is the decision left to the researcher, and guessing it would
 * be the same overclaim the rest of this module avoids. Compiling it *against the
 * target* is not done here and never will be: D21 keeps generation pure, so
 * `report/` spawns nothing.
 *
 * What *is* verified is that every shape this module can emit is valid C:
 * `harness.test.ts` compiles each one with `cc -fsyntax-only -Wall -Wextra` and
 * fails on a diagnostic. That is not decoration. A symbol-index name is not
 * necessarily a C identifier — a C++ destructor, an operator, a qualified name —
 * and emitting one put a syntax error in the first file the researcher builds,
 * which reads as "the target is broken" rather than "the harness needs a decision
 * made". Names like that now degrade to the placeholder, with the reason stated
 * in the emitted file rather than left to be inferred.
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

/**
 * CWE prefix -> what a successful reproduction looks like.
 *
 * Exported because this is the only place the claim is made, and it is checkable:
 * `harness.test.ts` holds it against the classes the report can name
 * (`CLASS_NAMES`) and the classes the committed rule set can emit. A class the
 * tool emits with no entry here still degrades honestly to "no class-specific
 * signature is known" — which is a stated gap, not a failure — so a new class
 * either lands here or is a decision someone made.
 */
export const EXPECTED_FAILURE: Record<string, string> = {
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
  'CWE-401':
    'a memory leak: expect an AddressSanitizer/LeakSanitizer report naming the allocation. This ' +
    'class does not crash.',
  'CWE-190': 'an integer overflow: UBSan reports signed overflow, or the wraparound shows as an ' +
    'implausible size reaching an allocation.',
  'CWE-191':
    'an integer underflow: UBSan reports the wrap as it happens, or the value reads back as an ' +
    'implausible size reaching an allocation.',
  'CWE-134': 'a format-string defect: expect a crash when the input contains `%s`/`%n`, or ' +
    'attacker-controlled output.',
  'CWE-78': 'command injection: expect the injected command to execute, observable in its output.',
  'CWE-89':
    'SQL injection: expect the injected fragment to appear in the query the target builds or ' +
    'sends — observable output, not a crash.',
  'CWE-338':
    'weak pseudo-randomness: no crash. Run the target twice under the same or a controlled seed ' +
    'and compare the values it generates.',
  'CWE-377':
    'an insecure temporary file: no crash. Pre-create the predictable path from a second process ' +
    'and check whether the target uses the attacker-chosen file.',
  'CWE-362': 'a race: expect non-deterministic corruption or a crash under repeated concurrent ' +
    'execution. A single run does NOT disprove this class.',
  'CWE-364':
    'a signal-handler race: expect non-deterministic corruption or a crash only when the signal ' +
    'lands inside the check-to-use window. A single run does NOT disprove this class.',
  'CWE-367':
    'a TOCTOU race: expect non-deterministic corruption only when the check-to-use window is ' +
    'hit. A single run does NOT disprove this class.',
  'CWE-828':
    'a signal handler calling non-async-signal-safe code: expect a deadlock or corruption only ' +
    'under a signal storm, delivered while the handler is already running. A single run does NOT ' +
    'disprove this class.',
}

/** `CWE-120` for any spelling of that class; null when it is not a CWE id at all. */
const cweKey = (cwe: string | null): string | null => {
  const match = cwe ? /CWE-(\d+)/i.exec(cwe) : null
  return match ? `CWE-${match[1]}` : null
}

/**
 * True when a class-specific observable is known.
 *
 * Separate from `expectedFailureFor` so a caller can tell "this class has no
 * signature" — a stated gap — from "this CWE id was not recognised".
 */
export const hasFailureSignature = (cwe: string | null): boolean => {
  const key = cweKey(cwe)
  return key !== null && key in EXPECTED_FAILURE
}

const expectedFailureFor = (cwe: string | null): string => {
  const key = cweKey(cwe)
  const signature = key === null ? undefined : EXPECTED_FAILURE[key]
  if (signature !== undefined) return signature
  return (
    'no class-specific signature is known for this finding. Observe for a crash, an ' +
    'AddressSanitizer/UBSan report, or a failed assertion, and record what you actually see.'
  )
}

const PLACEHOLDER_CALLABLE = 'TARGET_FUNCTION'

/** Exactly the identifiers a C declaration may carry. */
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * C keywords. They cannot name a function, so they cannot appear in a declaration.
 *
 * The symbol index reads eleven languages, so a name that is legal where it was
 * written can still be illegal in the C skeleton this module emits.
 */
const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
  'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex', '_Generic',
  '_Imaginary', '_Noreturn', '_Static_assert', '_Thread_local',
])

/**
 * A name the skeleton can declare and call.
 *
 * `reason` is set when the index's name could not be used, so the emitted file can
 * say *why* the researcher is looking at a placeholder instead of leaving them to
 * infer it from a name that does not match their symbol. It is written to be a
 * standalone sentence: capitalised, no full stop, and short enough to sit on one
 * line of the emitted comment.
 */
interface Callable {
  name: string
  reason: string | null
}

const callableFor = (functionName: string | null): Callable => {
  if (functionName === null) {
    return {
      name: PLACEHOLDER_CALLABLE,
      reason: 'No enclosing function was resolved for this location',
    }
  }
  if (!C_IDENTIFIER.test(functionName)) {
    return {
      name: PLACEHOLDER_CALLABLE,
      reason: `The symbol index name \`${functionName}\` is not a C identifier`,
    }
  }
  if (C_KEYWORDS.has(functionName)) {
    return {
      name: PLACEHOLDER_CALLABLE,
      reason: `The symbol index name \`${functionName}\` is a C keyword`,
    }
  }
  return { name: functionName, reason: null }
}

const pocSource = (input: {
  finding: Finding
  callable: Callable
  targetLocation: string
}): string => {
  const { callable } = input
  const header =
    input.finding.filePath ?? `<header declaring ${callable.name}>`

  const placeholderNote =
    callable.reason === null
      ? ''
      : [
          '',
          `/* TODO: ${callable.reason}.`,
          ' * The declaration and the call below are placeholders; supply the real name,',
          ' * its arguments, and its expected return, then delete this note. */',
        ].join('\n')

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

/* TODO: replace with the real header for the function under test, if any. */
/* #include "${header}" */
${placeholderNote}
/* Declared here so the skeleton compiles even without the header; if you add
 * the include above, delete this declaration so the compiler checks it against
 * the real one. */
extern int ${callable.name}(void);

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
  int result = ${callable.name}();

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
  const callable = callableFor(input.functionName ?? null)
  /** What the instructions can call the function: its name, or a description. */
  const described = callable.reason === null ? callable.name : 'the function under test'

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
        callable,
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
    `1. Complete the TODOs in poc.c: include the real header for ${described}, and build the`,
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
