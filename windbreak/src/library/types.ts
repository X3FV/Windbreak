/**
 * Pattern library types (spec §10, §4.8, §12.2).
 *
 * A stored pattern is only ever created from a finding that survived
 * verification, and it is replayed only while it still catches the site it was
 * mined from. Both of those are decisions about *trust*, not about convenience:
 * a pattern that enters the library on a guess, or keeps replaying after the
 * code under it has changed, manufactures findings at cross-target scale.
 */

import type { Candidate } from '../engines/types'

/**
 * The pattern form. Only `function-shape` exists, and that is deliberate: the
 * fingerprint language is small, deterministic, and answerable entirely from
 * the recon program model, so a stored pattern is *data* rather than code and
 * cannot execute anything at replay time.
 */
export const FINGERPRINT_KINDS = ['function-shape'] as const
export type FingerprintKind = (typeof FINGERPRINT_KINDS)[number]

/**
 * Where a fingerprint is evaluated. `function` groups call sites by the
 * enclosing function the symbol index recorded; `file` groups by file, for
 * shapes that span functions.
 */
export const FINGERPRINT_SCOPES = ['function', 'file'] as const
export type FingerprintScope = (typeof FINGERPRINT_SCOPES)[number]

/** An ordering predicate: both calls occur in the site, `before` above `after`. */
export interface FingerprintOrderPair {
  before: string
  after: string
}

/**
 * A structural fingerprint: a set of call-presence predicates that must all
 * hold at one site.
 *
 * The vocabulary is deliberately narrow. Each field is answerable with a SQL
 * query against `symbol_refs` and `symbols`, which means replay is cheap,
 * reproducible, and identical on every machine — the property a synthesized
 * `Semgrep` rule would *not* have, since it would depend on Semgrep's own
 * matcher and version.
 */
export interface Fingerprint {
  kind: FingerprintKind
  scope: FingerprintScope
  /** The class the seeding finding was confirmed under, when it had one. */
  cwe: string | null
  /** One line, shown on every candidate the pattern produces. */
  summary: string
  /** Language ids the pattern applies to. Restricted to indexed languages. */
  languages: string[]
  /** Calls that must ALL appear in the site. */
  requireCalls: string[]
  /** Calls of which AT LEAST ONE must appear in the site. */
  requireAnyCalls: string[]
  /**
   * Calls that must NOT appear in the site — the absent-guard predicate. This
   * is what makes a fingerprint more than "the sink is called": it is the claim
   * that the bounded alternative is missing.
   */
  forbidCalls: string[]
  /** Ordering constraints, for check-then-use shapes. */
  order: FingerprintOrderPair[]
}

/** The fingerprint without its discriminator: what the synthesis model returns. */
export type FingerprintBody = Omit<Fingerprint, 'kind'>

/** §14.1. `unconfirmed` means the D15 gate has not been met for replay. */
export const CHECKER_CONDITIONS = ['confirmed', 'unconfirmed'] as const
export type CheckerCondition = (typeof CHECKER_CONDITIONS)[number]

/**
 * The site a pattern was mined from, recorded so drift can be decided against
 * the *site* rather than against a hit count.
 */
export interface OriginSite {
  filePath: string
  /** Null for a file-scoped fingerprint. */
  functionName: string | null
  /** Line of the anchor call when the pattern was created. */
  line: number
}

/** A row of the library, resolved (§14.1 `checkers`). */
export interface LibraryEntry {
  id: string
  patternId: string
  /** The revision the pattern was mined from (§20.12.1). */
  originPatchSha: string
  condition: CheckerCondition
  fingerprint: Fingerprint
  /** Hits on the pre-image at the last validation; null when never validated. */
  preImageHits: number | null
  /** 1 silent on a post-image, 0 fired on it, null when none was supplied. */
  postImageClean: number | null
  precisionObserved: number | null
  findingId: string | null
  candidateId: string | null
  /** The target the pattern was mined from. */
  targetId: string | null
  cwe: string | null
  /**
   * The seeding finding's evidence tier. Recorded because D15 gates on
   * `human-reproduced` while §10's replay rule says `confirmed`, and a refusal
   * message that cannot say which gate failed is not auditable (§2.1.5).
   */
  evidenceTier: string | null
  originSite: OriginSite | null
  modelId: string | null
  provider: string | null
  promptTemplateVersion: string | null
  retiredAt: string | null
  createdAt: string
}

/** §14.1 `checker_replays`. One attempt to replay one checker against one target. */
export interface CheckerReplay {
  id: string
  checkerId: string
  targetId: string
  revalidated: boolean
  candidatesFound: number
  /** Why nothing was produced. Null when the replay actually ran (§18). */
  skippedReason: string | null
  targetCommitSha: string | null
  ranAt: string
}

/** One site a fingerprint matched, before it becomes a candidate. */
export interface FingerprintHit {
  filePath: string
  /** The enclosing function when the scope is `function`; null otherwise. */
  functionName: string | null
  /** Line of the anchor call — the sink the pattern is really about. */
  line: number
  /** The call names observed in the site, sorted. */
  observedCalls: string[]
  /** The required call the anchor was taken from, for the candidate message. */
  matchedOn: string
}

/**
 * Revalidation outcome (§10).
 *
 * `revalidated: false` means the pattern must be **skipped, not tuned** — that
 * is the spec's rule, and it exists because silently rewriting a pattern to fit
 * new code would let a pattern drift into something nobody confirmed.
 */
export interface RevalidationResult {
  revalidated: boolean
  reason: string | null
  preImageHits: number
  postImageClean: number | null
  originSiteHit: FingerprintHit | null
}

/** Per-checker outcome of one replay sweep. */
export interface ReplayOutcome {
  checkerId: string
  patternId: string
  revalidated: boolean
  skippedReason: string | null
  candidatesFound: number
}

/** §12.2's `VariantHuntResult`, realized. */
export interface VariantHuntResult {
  candidates: Candidate[]
  checkersConsidered: number
  outcomes: ReplayOutcome[]
  warnings: string[]
}
