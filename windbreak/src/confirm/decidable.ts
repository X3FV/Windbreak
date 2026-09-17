/**
 * Which defect classes a single bounded fuzz run can decide, and what a
 * reproduction of each looks like to a sanitizer.
 *
 * This is the precision instrument of automated confirmation (spec §20.35). The
 * question it answers is not "did the target crash" — a generated target calls a
 * function it was never told the signature of, so a crash is cheap and often not
 * about the finding at all. The question is "did *this* defect manifest, in the
 * shape this class is supposed to manifest in". Two gates enforce that, and this
 * table is one of them:
 *
 * 1. **decidability** — a class is only confirmable if one input can decide it;
 * 2. **signature** — the sanitizer's own category has to be one of the ones this
 *    class is known to produce.
 *
 * ## Why races are not here
 *
 * `harness.ts`'s `EXPECTED_FAILURE` already states the rule for the concurrency
 * classes in so many words: "A single run does NOT disprove this class." A run
 * that cannot disprove cannot confirm either — observing a race is luck, and not
 * observing one is not evidence — so those classes are refused rather than
 * left to a coin flip that would read as a verdict.
 *
 * The same reasoning covers the classes whose observable is not a crash:
 * command injection and SQL injection show up as *output*, weak randomness and
 * insecure temp files need a second process or a controlled seed. Those need
 * replay machinery this stage does not have, and guessing would be the
 * overclaim the rest of the tool exists to avoid.
 *
 * ## The default is refusal
 *
 * A CWE with no entry anywhere is **not** treated as decidable with an empty
 * signature list — it is undecidable, and the reason says so. A new class
 * therefore either lands in one of these tables or is a decision someone made,
 * which is the same posture `harness.ts` takes toward its own table.
 */

/** A class a single bounded run can confirm, and the sanitizer categories that do it. */
export interface FuzzDecidability {
  /** Substrings that identify an accepted report. Matched case-insensitively. */
  signatures: readonly string[]
  /** What a successful reproduction is, in the class's own terms. For the record. */
  observable: string
}

/**
 * Keyed by canonical `CWE-<n>`.
 *
 * The signatures are sanitizer categories, not prose: `heap-buffer-overflow` is
 * what ASan prints, and matching on it is what separates "the copy this finding
 * named overflowed" from "the process died for some reason".
 *
 * **A bare `SEGV` is accepted for exactly one class, and that is deliberate.**
 * Under a sanitized build the memory classes report their own category, so a
 * plain `SEGV` from them means ASan did not see the access — which is what a
 * *mismatched call* produces, since a generated target calls a callee whose
 * parameter list the symbol index does not record. Accepting `SEGV` for CWE-120
 * would therefore let a wrongly-called function confirm a finding. It is the
 * right signature only for CWE-476, where a null dereference *is* the defect.
 */
export const FUZZ_DECIDABLE: Record<string, FuzzDecidability> = {
  'CWE-120': {
    signatures: [
      'stack-buffer-overflow',
      'heap-buffer-overflow',
      'dynamic-stack-buffer-overflow',
      'stack-buffer-underflow',
    ],
    observable: 'an unbounded copy overwriting its destination',
  },
  'CWE-121': {
    signatures: ['stack-buffer-overflow', 'dynamic-stack-buffer-overflow'],
    observable: 'a stack buffer overflow',
  },
  'CWE-122': {
    signatures: ['heap-buffer-overflow'],
    observable: 'a heap buffer overflow',
  },
  'CWE-125': {
    signatures: ['heap-buffer-overflow', 'stack-buffer-overflow'],
    observable: 'an out-of-bounds read',
  },
  'CWE-787': {
    signatures: ['heap-buffer-overflow', 'stack-buffer-overflow', 'dynamic-stack-buffer-overflow'],
    observable: 'an out-of-bounds write',
  },
  'CWE-476': {
    signatures: ['SEGV', 'null-pointer-dereference'],
    observable: 'a null dereference',
  },
  'CWE-416': {
    signatures: ['heap-use-after-free', 'stack-use-after-return', 'stack-use-after-scope'],
    observable: 'a use-after-free',
  },
  'CWE-415': {
    signatures: ['double-free', 'attempting double-free'],
    observable: 'a double free',
  },
  'CWE-401': {
    signatures: ['detected memory leaks', 'memory leak'],
    observable: 'a leak that outlives the call',
  },
  'CWE-190': {
    signatures: ['signed integer overflow', 'unsigned integer overflow', 'integer overflow'],
    observable: 'an integer overflow UBSan traps',
  },
  'CWE-191': {
    signatures: ['signed integer overflow', 'unsigned integer overflow', 'integer overflow'],
    observable: 'an integer underflow UBSan traps',
  },
  'CWE-134': {
    signatures: ['stack-buffer-overflow', 'heap-buffer-overflow', 'unknown-crash'],
    observable: 'a format string reaching a write through attacker-controlled input',
  },
}

/**
 * Classes that are recognised and deliberately *not* confirmable this way, with
 * the reason recorded on the refusal.
 *
 * Kept separate from "unknown class" so a refusal can distinguish "this class is
 * known and one run cannot decide it" from "this class has no observable in the
 * table at all" — the first is a design boundary, the second is a gap.
 */
export const FUZZ_UNDECIDABLE: Record<string, string> = {
  'CWE-362':
    'a race: a single run cannot disprove it, so it cannot confirm it either (spec §4.7, harness.ts)',
  'CWE-364':
    'a signal-handler race: it only manifests when a signal lands inside a window, and one run neither shows nor rules that out',
  'CWE-367':
    'a TOCTOU race: it needs the check-to-use window to be hit, which one run cannot arrange or rule out',
  'CWE-828':
    'an async-signal-unsafe call: it needs a signal delivered while the handler is already running, which one run cannot arrange',
  'CWE-78':
    'command injection: its observable is attacker-controlled output, not a sanitizer report',
  'CWE-89':
    'SQL injection: its observable is the query the target builds, not a sanitizer report',
  'CWE-338':
    'weak randomness: it needs two controlled runs compared against each other, not one crash',
  'CWE-377':
    'an insecure temporary file: it needs a second process pre-creating the predictable path',
}

/** The canonical `CWE-<n>` key for any spelling of a CWE id, or null. */
export const cweKey = (cwe: string | null | undefined): string | null => {
  const match = cwe ? /CWE-(\d+)/i.exec(cwe) : null
  return match ? `CWE-${match[1]}` : null
}

/**
 * Whether a single bounded fuzz run can decide this class, and why not when it
 * cannot.
 *
 * Returns the `FuzzDecidability` on success so the caller has the signatures in
 * hand without a second lookup, which is what keeps the "is it decidable" and
 * "does this report match" answers from being able to disagree.
 */
export type DecidabilityVerdict =
  | { decidable: true; key: string; entry: FuzzDecidability }
  | { decidable: false; key: string | null; reason: string }

export const decidabilityOf = (cwe: string | null | undefined): DecidabilityVerdict => {
  const key = cweKey(cwe)

  if (!key) {
    return {
      decidable: false,
      key: null,
      reason: 'the candidate names no CWE, so there is no observable to check a run against',
    }
  }

  const entry = FUZZ_DECIDABLE[key]
  if (entry) return { decidable: true, key, entry }

  const refusal = FUZZ_UNDECIDABLE[key]
  return {
    decidable: false,
    key,
    reason:
      refusal ??
      `no observable is recorded for ${key}: a class is confirmable only when the table names what its reproduction looks like`,
  }
}
