/**
 * What a confirmation attempt can come back as (spec §20.35).
 *
 * Six outcomes rather than a boolean, because "it did not reproduce" and "it
 * could not be attempted" are different facts and only one of them is about the
 * finding. Collapsing `build-failed` into `not-reproduced` would make a compiler
 * error on a machine without headers look like evidence that the defect is not
 * real, which is the substitution the rest of this tool refuses to make.
 */
export const CONFIRMATION_OUTCOMES = [
  /** The sanitizer fired in the finding's own code, in the finding's own class. */
  'confirmed',
  /** Something real crashed, but not this defect — recorded, never counted. */
  'unattributed',
  /** The run completed inside its budget with nothing to report. Not disproof. */
  'not-reproduced',
  /** Refused before anything ran: the class is not decidable, or the code is C++. */
  'ineligible',
  /** The fuzz target did not compile against the target. */
  'build-failed',
  /** It compiled but could not be run, and said nothing about the defect. */
  'run-failed',
] as const

export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number]

/** The single outcome that may move an evidence tier. */
export const CONFIRMING_OUTCOMES: readonly ConfirmationOutcome[] = ['confirmed']

export interface ConfirmationLocation {
  /** Path as the sanitizer reported it (inside the sandbox's scratch tree). */
  filePath: string
  line: number
}

export interface ConfirmationResult {
  candidateId: string
  outcome: ConfirmationOutcome
  /**
   * Why, in the case's own terms. Always set, for every outcome.
   *
   * A record that says only `not-reproduced` invites the reader to supply their
   * own reason, and the likely one — "so it is probably not real" — is the one
   * this stage exists to avoid stating.
   */
  detail: string
  /** The sanitizer's category, when one fired. */
  signature: string | null
  /** Where it fired, when that was the finding's own code. */
  location: ConfirmationLocation | null
  /** Seconds actually given to the fuzzer. */
  fuzzSeconds: number
  /** How long the attempt took, wall clock, for the budget record. */
  durationMs: number
  /** The exact commands, recorded so a run can be audited or repeated. */
  compileCommand: string[]
  fuzzCommand: string[]
  /**
   * Scratch directory this attempt used, or null when nothing ran.
   *
   * Named because the fuzzer writes its crash artifacts here — a saved input is
   * the difference between "it crashed" and something a researcher can replay.
   */
  workspaceDir: string | null
}

/** A confirmation result flattened for storage. */
export interface ConfirmationRow {
  candidate_id: string
  run_id: string
  outcome: ConfirmationOutcome
  detail: string
  signature: string | null
  location: string | null
  fuzz_seconds: number
  duration_ms: number
  created_at: string
}
