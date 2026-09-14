/**
 * Patch-mined candidate discovery (spec §4.4.1 — Phase A).
 *
 * §4.3's engines are the wide net; §4.4 is the recall investment. Phase A is the
 * cheap half of that investment: instead of synthesising a checker from a patch
 * (§4.4.2, post-MVP), it reads the target's *own* fix commits, extracts the shape
 * of each fix, and looks for sibling sites in the current tree that still have
 * the pre-fix shape.
 *
 * The rule that decides what is admitted is §4.4.1's:
 *
 *   "a pattern is only emitted if its own source patch distinguishes
 *    vulnerable-vs-patched (i.e. re-applying the shape detection to the patch's
 *    pre-image flags it). Patterns that don't validate are dropped, not tuned."
 *
 * So every pattern carries a `validation` record and an unvalidated pattern is
 * never mined — not ranked lower and not emitted with a caveat. What validation
 * buys is narrow and worth stating exactly: **a validated pattern explains its own
 * patch.** It says nothing about how precise the pattern is on sibling sites,
 * which is what triage (§4.6) and cross-model verification (§5) exist for. §4.4.1
 * asks for cheap validation and this is it — the alternative reading, that a
 * validated pattern is a good detector, is the overclaim this design refuses.
 *
 * Everything in this module is pure except `history.ts` (which spawns git) and
 * `siblings.ts` (which reads the checkout). The shape logic is the part worth
 * testing hardest, so it is the part with no dependencies at all.
 */

/**
 * §4.4.1's five shapes, verbatim and closed.
 *
 * Closed matters: a patch that matches none of these produces **no pattern**
 * rather than being forced into the nearest shape. §4.4.1 names exactly this
 * taxonomy ("added guard, added lock, added bounds check, added null check,
 * lifetime change"), and a sixth shape invented here would be a detector the spec
 * never asked for, mining candidates nothing downstream was designed to reason
 * about. Unrecognised patches are counted so the coverage gap is visible.
 */
export const FIX_SHAPES = [
  'null-check',
  'bounds-check',
  'guard',
  'lock',
  'lifetime',
] as const

export type FixShape = (typeof FIX_SHAPES)[number]

/** One line of a unified diff, with the line number on each side it exists on. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
  /** 1-based line number in the pre-image. Null for added lines. */
  oldLine: number | null
  /** 1-based line number in the post-image. Null for removed lines. */
  newLine: number | null
}

export interface Hunk {
  /** Path relative to the repository root, post-image side. */
  filePath: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/** One commit's patch, as `git log -p` emitted it. */
export interface CommitPatch {
  sha: string
  /** Author/committer timestamp, seconds since the epoch. */
  committedAt: number
  subject: string
  hunks: Hunk[]
}

/** Commit-level facts, before any shape is decided. */
export interface CommitCoverage {
  /** Commits the log walk returned. */
  commitsRead: number
  /** Commits whose diff was parsed far enough to look at hunks. */
  commitsWithPatches: number
  /** Hunks examined across all commits. */
  hunksExamined: number
  /** Hunks whose added lines matched none of §4.4.1's five shapes. */
  hunksUnrecognised: number
}

/**
 * What a shape is *about*, taken from the patch.
 *
 * These are the only two pieces of a hunk that generalise to another site, and
 * they generalise differently:
 *
 * - `subject` is the identifier the fix protects (`dst` in `if (dst == NULL)`, or
 *   the index in `if (i >= len)`). It is **not** portable across functions, so it
 *   is used for validation, where the pre-image is the same code the fix touched,
 *   and not for the sibling sweep.
 * - `operation` is the callee the fix guarded, relocated, or released (`strcpy`).
 *   That *is* portable — the same dangerous call appearing elsewhere in the
 *   target is exactly the §4.4.1 "sibling site" — so it scopes the sweep.
 */
export interface ShapeHint {
  subject?: string | null
  operation?: string | null
}

/** Where a pre-fix shape was seen, and why the detector said so. */
export interface ShapeFinding extends Required<ShapeHint> {
  shape: FixShape
  /** 1-based line within the region the detector was given. */
  line: number
  /** One sentence naming the defect, carried into the candidate's message. */
  evidence: string
}

/**
 * §4.4.1's admission test, recorded per pattern rather than summarised.
 *
 * Both values are kept even when `accepted` is false, because "the detector fired
 * on the fix too" and "the detector never fired at all" are different failures
 * and a boolean would collapse them.
 */
export interface PatternValidation {
  /** The detector fired on the patch's pre-image (the vulnerable side). */
  preImageFlagged: boolean
  /** The detector fired on the patch's post-image (the fixed side). */
  postImageFlagged: boolean
  /** `preImageFlagged && !postImageFlagged` — §4.4.1's condition. */
  accepted: boolean
}

/** A pattern that survived §4.4.1's validation, ready to sweep for siblings. */
export interface MinedPattern {
  /** Stable hash of (shape, operation, subject, originPatchSha) — the sweep key. */
  id: string
  shape: FixShape
  /** The revision this pattern was mined from (§4.4.1). */
  originPatchSha: string
  originFile: string
  /** Commit subject, so a candidate's provenance reads as a sentence. */
  originSubject: string
  subject: string | null
  operation: string | null
  /** The patch's own defect, in one line, if the detector produced one. */
  description: string
  validation: PatternValidation
  /**
   * How many distinct hunks across the history validated into this pattern.
   *
   * A pattern is keyed on what its *sweep* is parameterised by — the shape and the
   * operation — not on the commit that produced it, so the same shape fixed in
   * twenty commits is one pattern with `occurrences: 20` rather than twenty
   * patterns that would each emit the same candidates. Multiplicity is real signal
   * (a shape a project keeps re-fixing is a recurring bug class) so it is counted
   * rather than discarded, and `originPatchSha` names the newest commit that
   * exhibited it.
   */
  occurrences: number
}

/** A pattern the validation dropped, kept so the drop is inspectable. */
export interface RejectedPattern {
  shape: FixShape
  originPatchSha: string
  originFile: string
  subject: string | null
  operation: string | null
  validation: PatternValidation
}

/** A site in the current tree that still carries a mined pattern's pre-fix shape. */
export interface SiblingSite {
  /** The pattern whose sweep found this site. */
  patternId: string
  filePath: string
  /** 1-based, matching `symbols.start_line`. */
  startLine: number
  endLine: number
  /** The enclosing function's name, from the program model. */
  functionName: string
  /** The line inside the function where the shape was seen. */
  matchLine: number
  evidence: string
}

export interface PatchMineResult {
  patterns: MinedPattern[]
  rejected: RejectedPattern[]
  sites: SiblingSite[]
  /**
   * Commits whose subject *and* touched languages made them worth diffing, i.e.
   * the denominator the pattern count should be read against.
   */
  commitsConsidered: number
  coverage: CommitCoverage
  warnings: string[]
  /** Set when the governor stopped the stage early. */
  stoppedBy: 'budget-degrade' | 'budget-abort' | null
}
