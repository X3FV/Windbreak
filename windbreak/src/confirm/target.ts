/**
 * Generating the fuzz target that drives a finding (spec §20.35).
 *
 * This is the executable counterpart of the manual harness `report/` emits. That
 * one is a skeleton a human finishes; this one has to run with nobody at the
 * keyboard, which changes what it is allowed to assume — and the assumptions it
 * cannot make are the reason this module refuses more often than it emits.
 *
 * ## The one hard problem: the callee's signature is not in the database
 *
 * `symbols` records a name, a qualifier, a kind, a location and a language. It
 * does **not** record a parameter list. So a generated target cannot write the
 * real prototype, and inventing one would be a guess that fails as a *compile
 * error in the researcher's terminal* — which reads as "the target is broken"
 * rather than "the harness needs a decision", the same failure `harness.ts`
 * documents for symbol-index names that are not C identifiers.
 *
 * The way out is a C rule rather than a guess: `void f();` declares a function
 * with **unspecified** parameters, not none, so it links against the real symbol
 * and may be called with any argument list. C++ has no such rule — `f()` there
 * means exactly zero parameters — so this module is C-only for now and says so
 * rather than emitting something that cannot compile.
 *
 * What that costs is stated plainly: if the real callee takes more arguments
 * than the one passed here, the call is best-effort and the defect may not
 * manifest or may manifest as a mismatched-call crash. Attribution is what
 * absorbs that — see `attribute.ts`, where an accepted report must name the
 * finding's own class *and* land in the finding's own code.
 *
 * ## Why a fuzzer and not a scripted run
 *
 * A defect of the classes here needs attacker-shaped input, and nothing in the
 * database says what that input is. The spec names this exact path: §4.7 and
 * §12.4 both say a future AFL++/libFuzzer backend "slots in behind the same
 * interface without redesign", and `-fsanitize=fuzzer` is libFuzzer, so the
 * backend needs no new dependency and no network.
 */

import { decidabilityOf } from './decidable'

/** Written beside the finding's source and compiled with it. */
export const FUZZ_TARGET_FILE_NAME = 'windbreak_fuzz_target.c'

/**
 * A C identifier, and nothing else.
 *
 * A symbol-index name is not necessarily one: a C++ destructor, an operator, or
 * a qualified name all fail this — which is the point. They are refused with
 * that reason rather than emitted as a syntax error the researcher has to
 * decipher.
 */
const C_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface FuzzTargetInput {
  /** Enclosing function from the symbol index, when one was resolved. */
  functionName: string | null
  /** Program-model language of the finding's file. */
  language: string | null
  cwe: string | null
  filePath: string | null
}

export type FuzzTargetPlan =
  | { ok: true; fileName: string; source: string; cweKey: string }
  | { ok: false; reason: string }

const preamble = (functionName: string, cwe: string): string =>
  `/*
 * WindBreak's generated fuzz target (spec §20.35) for ${functionName} (${cwe}).
 *
 * Written by \`windbreak confirm\` and compiled inside the sandbox with
 * -std=gnu17 -O0 -fsanitize=fuzzer,address,undefined. The standard is pinned and
 * optimisation is off for reasons that are load-bearing rather than tuning — see
 * \`SANITIZER_FLAGS\` in run.ts. The target checkout is bound read-only; nothing
 * this file does can change it.
 *
 * The empty parameter list is deliberate. \`symbols\` records where ${functionName}
 * is but not what it takes, and a C prototype that does not match the real one is
 * a compile error in the researcher's shell rather than a diagnostic they can act
 * on. \`void f();\` in C means "unspecified parameters", so this links against the
 * real symbol without inventing one. If the real callee takes more arguments, the
 * call is best-effort — which is why a run only counts as a reproduction when the
 * sanitizer's category matches ${cwe} *and* the report lands in the finding's own
 * code. See src/confirm/attribute.ts.
 */
`

const body = (functionName: string): string => `
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void ${functionName}();

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  char *input;

  /* A zero-length input is not worth a call: every shape below would hand the
   * callee an empty string, and the fuzzer reaches those through one-byte
   * inputs anyway. Skipping it keeps a crash from being attributed to a call
   * that carried no data. */
  if (size == 0) return 0;

  input = (char *)malloc(size + 1);
  if (input == NULL) return 0;

  memcpy(input, data, size);
  input[size] = '\\0';

  ${functionName}(input);

  free(input);
  return 0;
}
`

/**
 * Plan a fuzz target for one finding, or say why one cannot be built.
 *
 * Pure: it returns source text as data and spawns nothing, so the decision to
 * refuse is testable without a compiler and without a sandbox.
 */
export const planFuzzTarget = (input: FuzzTargetInput): FuzzTargetPlan => {
  // Decidability first: it is the cheapest gate, and its refusal is the most
  // useful one — it says the class is not something a single run can settle,
  // rather than that this particular file could not be driven.
  const decidability = decidabilityOf(input.cwe)
  if (!decidability.decidable) {
    return { ok: false, reason: decidability.reason }
  }

  const language = (input.language ?? '').toLowerCase()
  if (language !== 'c') {
    return {
      ok: false,
      reason:
        language === 'cpp' || language === 'c++'
          ? 'C++ cannot be driven this way yet: unlike C, `f()` there declares zero parameters, ' +
            'so the callee cannot be called without the real signature the symbol index does not record'
          : `the program model read this file as ${language || 'an unknown language'}, and generated ` +
            'fuzz targets are C only for now',
    }
  }

  if (!input.filePath) {
    return { ok: false, reason: 'the candidate records no file, so there is no source to compile' }
  }

  const functionName = input.functionName
  if (!functionName) {
    return {
      ok: false,
      reason:
        'no enclosing function was resolved for this location, so there is nothing to call; ' +
        'a fuzz target drives a function, not a line',
    }
  }

  if (!C_IDENTIFIER.test(functionName)) {
    return {
      ok: false,
      reason:
        `the symbol index names \`${functionName}\`, which is not a C identifier ` +
        '(a destructor, an operator, or a qualified name). Calling it needs the real ' +
        'signature, which is the manual harness\'s job.',
    }
  }

  return {
    ok: true,
    fileName: FUZZ_TARGET_FILE_NAME,
    cweKey: decidability.key,
    source: preamble(functionName, decidability.key) + body(functionName),
  }
}
