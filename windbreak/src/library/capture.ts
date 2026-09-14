/**
 * Pattern capture (spec §10, D15).
 *
 * Turning a confirmed finding into a library pattern is the moment a bug stops
 * being local and becomes a claim about every other codebase WindBreak will ever
 * see. Three things therefore have to be true before the row is written, and
 * each one is enforced here rather than assumed:
 *
 * 1. **The finding was confirmed.** A candidate in any other state is refused by
 *    name, so "why is this not in the library" always has an answer.
 * 2. **The pattern catches its own bug.** It is matched against the origin
 *    target immediately, and a pattern that cannot reproduce the finding it came
 *    from is *discarded, not adjusted* (§4.4.1, §10). This is the only
 *    validation that matters at capture time, and it is why the model's output
 *    is not trusted on its own.
 * 3. **The D15 gate is recorded, not assumed.** §10 says a checker is saved once
 *    it has produced a `human-reproduced` true positive; §10's replay rule then
 *    says `confirmed`. The tier is read from what reporting actually recorded
 *    and stored alongside, so a pattern that only cleared model verification is
 *    labelled as such rather than quietly promoted.
 */

import { findingId } from '../report'
import { parseFingerprint } from './fingerprint'
import { matchFingerprint } from './match'
import { CHECKER_PROMPT_TEMPLATE_VERSION } from './prompt'
import { synthesizePattern } from './synthesize'
import { checkerIdFor, insertChecker, libraryPatternId, readChecker } from './store'

import type { Database } from 'bun:sqlite'
import type { ModelInvoker, PipelineProgramContext } from '../pipeline'
import type { Fingerprint, LibraryEntry, OriginSite } from './types'
import type { CandidateRecord } from '../pipeline'

/**
 * What pattern capture is asked to mine — all of it JSON (§20.17.3).
 *
 * `fingerprint` being here is the point of the split: §10's hand-authored
 * fingerprint is the escape hatch that lets capture work with no model at all,
 * and it is a plain value, so it is a request field. `invoker` is the fallback,
 * and it is a callback, so it is a service. The stage is usable in both modes
 * and the partition says so without a comment having to.
 */
export interface CapturePatternRequest {
  candidate: CandidateRecord
  /** A hand-authored fingerprint, overriding synthesis. */
  fingerprint?: Fingerprint
  /** The revision the pattern is mined from; defaults to the target's commit. */
  originPatchSha?: string
  /** A post-image target, for §10's silence check at capture time. */
  postImageTargetId?: string
  cacheDisabled?: boolean
  timeoutMs?: number
}

/** What pattern capture needs from the host — none of it serializable. */
export interface CapturePatternServices {
  db: Database
  programContext: PipelineProgramContext
  /** Required unless `fingerprint` is supplied. */
  invoker?: ModelInvoker
  now?: () => number
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type CapturePatternInput = CapturePatternRequest & CapturePatternServices

export interface CapturePatternResult {
  ok: boolean
  /** True when this exact pattern was already in the library. */
  alreadyPresent: boolean
  checkerId: string | null
  patternId: string | null
  fingerprint: Fingerprint | null
  /** `confirmed` only when the seeding finding was human-reproduced. */
  condition: 'confirmed' | 'unconfirmed' | null
  evidenceTier: string | null
  originSite: OriginSite | null
  preImageHits: number | null
  postImageClean: number | null
  /** Where the fingerprint came from, for the audit line. */
  source: 'synthesis' | 'supplied' | null
  cached: boolean
  error: string | null
  warnings: string[]
  entry: LibraryEntry | null
}

const refusal = (error: string): CapturePatternResult => ({
  ok: false,
  alreadyPresent: false,
  checkerId: null,
  patternId: null,
  fingerprint: null,
  condition: null,
  evidenceTier: null,
  originSite: null,
  preImageHits: null,
  postImageClean: null,
  source: null,
  cached: false,
  error,
  warnings: [],
  entry: null,
})

/**
 * The evidence tier reporting recorded for a candidate, if it ran.
 *
 * Read from `findings` rather than asked for on the command line on purpose: a
 * tier that can be asserted as a flag is a tier that will eventually be asserted
 * by mistake, and §2.1.5 makes an unearned tier a contract violation. A
 * `human-reproduced` tier therefore requires `windbreak report --reproduced`.
 */
export const evidenceTierFor = (
  db: Database,
  candidateId: string,
): { findingId: string; evidenceTier: string } | null => {
  const row = db
    .query<{ id: string; evidence_tier: string }, [string]>(
      'SELECT id, evidence_tier FROM findings WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(candidateId)

  return row ? { findingId: row.id, evidenceTier: row.evidence_tier } : null
}

export const targetCommitSha = (db: Database, targetId: string): string | null =>
  db
    .query<{ commit_sha: string | null }, [string]>(
      'SELECT commit_sha FROM targets WHERE id = ?',
    )
    .get(targetId)?.commit_sha ?? null

const enclosingNameAt = (
  programContext: PipelineProgramContext,
  candidate: CandidateRecord,
): string | null => {
  if (!candidate.filePath || candidate.startLine === null) return null
  return (
    programContext.enclosingFunction(candidate.filePath, candidate.startLine)?.name ?? null
  )
}

export const capturePattern = async (
  input: CapturePatternInput,
): Promise<CapturePatternResult> => {
  const { db, candidate } = input
  const warnings: string[] = []

  // --- gate 1: the finding must have survived verification ---
  if (candidate.state !== 'confirmed') {
    return refusal(
      `candidate ${candidate.id} is in state "${candidate.state}", not "confirmed". ` +
        'Only a confirmed finding can seed a library pattern (spec §10): a pattern ' +
        'replays against every future target, so an unverified one scales a guess.',
    )
  }

  if (!candidate.targetId) {
    return refusal(`candidate ${candidate.id} records no target to validate against`)
  }

  // --- the D15 gate, read from what reporting recorded ---
  const reported = evidenceTierFor(db, candidate.id)
  const evidenceTier = reported?.evidenceTier ?? null
  const condition: 'confirmed' | 'unconfirmed' =
    evidenceTier === 'human-reproduced' ? 'confirmed' : 'unconfirmed'

  if (condition === 'unconfirmed') {
    warnings.push(
      evidenceTier
        ? `the seeding finding's evidence tier is "${evidenceTier}", so this pattern is ` +
            'stored unconfirmed and will be refused at replay unless ' +
            '--allow-statically-verified is passed.'
        : 'reporting has not recorded an evidence tier for this candidate, so the pattern ' +
            'is stored unconfirmed. Run `windbreak report --reproduced <candidateId>` ' +
            'after reproducing it to promote the tier, then re-add.',
    )
  }

  // --- gate 2: obtain a fingerprint ---
  let fingerprint: Fingerprint
  let source: 'synthesis' | 'supplied'
  let cached = false
  let modelId: string | null = null
  let provider: string | null = null
  let promptTemplateVersion: string | null = null

  if (input.fingerprint) {
    fingerprint = parseFingerprint(input.fingerprint)
    source = 'supplied'
  } else {
    if (!input.invoker) {
      return refusal(
        'no fingerprint was supplied and no model invoker is available to synthesize one',
      )
    }

    const synthesis = await synthesizePattern({
      db,
      candidate,
      targetId: candidate.targetId,
      programContext: input.programContext,
      invoker: input.invoker,
      ...(input.cacheDisabled ? { cacheDisabled: true } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.now ? { now: input.now } : {}),
    })

    if (!synthesis.ok || !synthesis.fingerprint) {
      return refusal(`synthesis failed: ${synthesis.error ?? 'no fingerprint produced'}`)
    }

    fingerprint = synthesis.fingerprint
    source = 'synthesis'
    cached = synthesis.cached
    modelId = synthesis.identity.modelId
    provider = synthesis.identity.provider
    promptTemplateVersion = CHECKER_PROMPT_TEMPLATE_VERSION
  }

  const patternId = libraryPatternId(fingerprint)
  const checkerId = checkerIdFor(patternId, fingerprint)

  const existing = readChecker(db, checkerId)
  if (existing && existing.retiredAt === null) {
    // A pattern captured before its finding was reproduced is stored
    // unconfirmed. Re-adding it after `report --reproduced` promotes the gate
    // rather than reporting "already present" and leaving a trap: the tier is
    // still read from what reporting recorded, never asserted here.
    if (existing.condition === 'unconfirmed' && condition === 'confirmed') {
      db.prepare(
        'UPDATE checkers SET condition = ?, evidence_tier = ?, finding_id = ? WHERE id = ?',
      ).run(condition, evidenceTier, reported?.findingId ?? existing.findingId, checkerId)
      warnings.push(
        'this pattern was already in the library; its gate has been promoted to confirmed ' +
          'now that the seeding finding is human-reproduced.',
      )
    }

    return {
      ok: true,
      alreadyPresent: true,
      checkerId,
      patternId,
      fingerprint,
      condition: readChecker(db, checkerId)?.condition ?? existing.condition,
      evidenceTier: readChecker(db, checkerId)?.evidenceTier ?? existing.evidenceTier,
      originSite: existing.originSite,
      preImageHits: existing.preImageHits,
      postImageClean: existing.postImageClean,
      source,
      cached,
      error: null,
      warnings,
      entry: readChecker(db, checkerId),
    }
  }

  // --- gate 3: the pattern must still catch the site it came from ---
  const originHits = matchFingerprint({ db, targetId: candidate.targetId, fingerprint })
  // A file-scoped pattern's sites have no enclosing function by definition, so
  // the recorded site must not carry one either — otherwise the origin site
  // could never be found again and every file-scoped pattern would look drifted
  // on its first replay.
  const functionName =
    fingerprint.scope === 'function'
      ? enclosingNameAt(input.programContext, candidate)
      : null
  const originSiteHit = originHits.find(
    (hit) =>
      candidate.filePath !== null &&
      hit.filePath === candidate.filePath &&
      hit.functionName === functionName,
  )

  if (!originSiteHit) {
    return refusal(
      `the pattern does not match ${candidate.filePath ?? '(unknown)'}` +
        `${functionName ? ` :: ${functionName}` : ''}, the site it was mined from ` +
        `(${originHits.length} hit(s) elsewhere in the origin target). A pattern that ` +
        'cannot reproduce its own finding is dropped, not tuned (spec §4.4.1, §10).',
    )
  }

  const originSite: OriginSite = {
    filePath: originSiteHit.filePath,
    functionName: originSiteHit.functionName,
    line: originSiteHit.line,
  }

  // §10's second half, when a post-image is available to check against.
  let postImageClean: number | null = null
  if (input.postImageTargetId) {
    const postHits = matchFingerprint({
      db,
      targetId: input.postImageTargetId,
      fingerprint,
    })
    postImageClean = postHits.length === 0 ? 1 : 0
    if (postImageClean === 0) {
      return refusal(
        `the pattern also matches the post-image (${postHits.length} hit(s)); a pattern ` +
          'must be silent on the code that already fixed the bug (spec §10)',
      )
    }
  }

  const originPatchSha =
    input.originPatchSha ?? targetCommitSha(db, candidate.targetId) ?? 'unknown'

  insertChecker({
    db,
    patternId,
    originPatchSha,
    condition,
    fingerprint,
    findingId: reported?.findingId ?? findingId(candidate.id),
    candidateId: candidate.id,
    targetId: candidate.targetId,
    evidenceTier,
    originSite,
    modelId,
    provider,
    promptTemplateVersion,
    preImageHits: originHits.length,
    postImageClean,
    ...(input.now ? { now: input.now } : {}),
  })

  if (originHits.length > 1) {
    warnings.push(
      `the pattern matched ${originHits.length} site(s) in the target it was mined from, ` +
        'which is expected for a real variant but worth knowing before replaying it widely.',
    )
  }

  return {
    ok: true,
    alreadyPresent: false,
    checkerId,
    patternId,
    fingerprint,
    condition,
    evidenceTier,
    originSite,
    preImageHits: originHits.length,
    postImageClean,
    source,
    cached,
    error: null,
    warnings,
    entry: readChecker(db, checkerId),
  }
}
