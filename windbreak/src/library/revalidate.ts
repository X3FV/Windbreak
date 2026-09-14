/**
 * Checker revalidation (spec §10).
 *
 * §10's rule: "Before replay, it is re-validated against the patch it was mined
 * from (catch the pre-image, stay silent on the post-image). A drifted checker
 * is skipped, not tuned."
 *
 * The pre-image here is the *site* the pattern was mined from, and drift is
 * decided against that site rather than against a match count. That distinction
 * is the whole value of the check: a pattern that has widened so that it still
 * fires somewhere in the same file, but no longer on the code that was
 * confirmed, has stopped being a description of a known bug and become a
 * description of something nobody has ever looked at.
 *
 * The post-image half runs only when a post-image target is supplied, and
 * records `null` rather than a guess when it does not. "This check did not run"
 * and "this check passed" are different claims, and §18 exists because the
 * first keeps being reported as the second.
 */

import { matchFingerprint } from './match'

import type { Database } from 'bun:sqlite'
import type { LibraryEntry, RevalidationResult } from './types'

export const revalidateChecker = (input: {
  db: Database
  checker: LibraryEntry
  /** A target whose program model is the post-image, when one is available. */
  postImageTargetId?: string | undefined
}): RevalidationResult => {
  const { checker } = input

  if (!checker.targetId) {
    return {
      revalidated: false,
      reason: 'the pattern records no origin target, so it cannot be validated against its pre-image',
      preImageHits: 0,
      postImageClean: null,
      originSiteHit: null,
    }
  }

  if (!checker.originSite) {
    return {
      revalidated: false,
      reason: 'the pattern records no origin site, so drift cannot be detected',
      preImageHits: 0,
      postImageClean: null,
      originSiteHit: null,
    }
  }

  const hits = matchFingerprint({
    db: input.db,
    targetId: checker.targetId,
    fingerprint: checker.fingerprint,
  })

  const originSiteHit =
    hits.find(
      (hit) =>
        hit.filePath === checker.originSite!.filePath &&
        (checker.originSite!.functionName === null ||
          hit.functionName === checker.originSite!.functionName),
    ) ?? null

  if (!originSiteHit) {
    return {
      revalidated: false,
      reason:
        `the pattern no longer catches ${checker.originSite.filePath} ` +
        `${checker.originSite.functionName ?? '(file scope)'} where it was mined ` +
        `(${hits.length} hit(s) elsewhere in the origin target)`,
      preImageHits: hits.length,
      postImageClean: null,
      originSiteHit: null,
    }
  }

  // Only meaningful once the pattern still catches its own site: a pattern that
  // already drifted cannot be "silent on the post-image" in any useful sense.
  let postImageClean: number | null = null
  if (input.postImageTargetId) {
    const postHits = matchFingerprint({
      db: input.db,
      targetId: input.postImageTargetId,
      fingerprint: checker.fingerprint,
    })
    postImageClean = postHits.length === 0 ? 1 : 0

    if (postImageClean === 0) {
      return {
        revalidated: false,
        reason:
          `the pattern still fires on the post-image (${postHits.length} hit(s)); §10 ` +
          'requires it to be silent there',
        preImageHits: hits.length,
        postImageClean,
        originSiteHit,
      }
    }
  }

  return {
    revalidated: true,
    reason: null,
    preImageHits: hits.length,
    postImageClean,
    originSiteHit,
  }
}
