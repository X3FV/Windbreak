/**
 * §4.4.1's admission test.
 *
 * The spec states it once, precisely, and everything about which patterns reach
 * the sweep depends on it:
 *
 *   "a pattern is only emitted if its own source patch distinguishes
 *    vulnerable-vs-patched (i.e. re-applying the shape detection to the patch's
 *    pre-image flags it). Patterns that don't validate are dropped, not tuned."
 *
 * So this module is deliberately three lines of real work. Its value is being a
 * *named* step rather than an inline condition: the rule is the only gate on
 * pattern quality, and a reader looking for it should find it as a thing rather
 * than as a clause inside the miner.
 *
 * ## What the sides are, exactly
 *
 * A hunk's pre-image is its context lines plus its removed lines; the post-image
 * is the same context plus its added lines. Comparing those two is comparing the
 * code with the fix against the code without it, and *nothing else* — which is
 * what makes the result attributable to the fix rather than to the surrounding
 * function.
 *
 * One limit worth stating, because it bounds what a validated pattern means: the
 * context lines are the same on both sides, so this can only show that the shape
 * detector's answer changed because of the added lines. It cannot show that the
 * detector is a good detector. A pattern that passes is one that *explains its own
 * patch*; whether it is precise on siblings is what triage and verification are
 * for, and §4.4.1 asks for exactly this much on purpose.
 */

import { postImage, preImage } from './diff'
import { detectShape } from './shapes'

import type { FixShape, Hunk, PatternValidation, ShapeHint } from './types'

/**
 * Does this patch's pre-fix shape discriminate? Both answers are kept even when
 * the outcome is a drop, because "the detector fired on the fix too" and "the
 * detector never fired at all" are different failures — the first says the shape
 * is not what this patch was about, the second usually says the operation was
 * misread out of the hunk's context.
 */
export const validateShape = (
  hunk: Hunk,
  shape: FixShape,
  hint: ShapeHint,
): PatternValidation => {
  const preImageFlagged = detectShape(preImage(hunk), shape, hint) !== null
  const postImageFlagged = detectShape(postImage(hunk), shape, hint) !== null

  return {
    preImageFlagged,
    postImageFlagged,
    accepted: preImageFlagged && !postImageFlagged,
  }
}
