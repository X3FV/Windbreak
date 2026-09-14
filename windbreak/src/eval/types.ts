/**
 * The evaluation vocabulary (spec §11, D10, D11, D22).
 *
 * §11's funnel is the only instrument in this project that can say whether the
 * pipeline works. Its two questions — *how many seeded bugs survived to this
 * stage* and *how much of what survived was real* — both go wrong in the same
 * quiet way: a stage that did not run reports zeros, and zeros read exactly like
 * a stage that ran and found nothing (§18). So "did not run" is a status here
 * rather than an absence, and the numbers on such a row are `null` rather than
 * `0`.
 *
 * The same rule governs a candidate that cannot be located. A hit with no file
 * path is neither a true positive nor a false positive; it is *unscored*, and
 * folding it into either side would be reporting a match or a miss that nobody
 * established.
 */

/**
 * One seeded vulnerability site.
 *
 * A bug may live in more than one place (a bug and its copy, a header and its
 * definition), so a candidate matching *any* of them counts.
 */
export interface FixtureSite {
  /** Relative to the snapshot root, POSIX separators. */
  filePath: string
  /**
   * 1-based inclusive. Both null means the site is the whole file, which is the
   * honest encoding for a seeded bug whose exact lines the list does not record:
   * an imprecise match is a weaker claim, not a missing one.
   */
  startLine: number | null
  endLine: number | null
  functionName: string | null
}

export interface FixtureBug {
  id: string
  cwe: string | null
  cve: string | null
  /** At least one site; a bug with no location cannot be matched against. */
  files: FixtureSite[]
  /** The commit that fixes it, for ground truth. Null when not known. */
  fixCommit: string | null
  note: string | null
}

export interface Fixture {
  id: string
  project: string
  /**
   * The **vulnerable** revision the snapshot is pinned to. This is the join key:
   * a run is scored against this fixture when the run's own `commit_sha`
   * matches, because that is the only evidence that the run saw this code.
   */
  commitSha: string
  /**
   * Possibly empty. A fixture with no seeded bugs is a *negative control* — it
   * measures the false-positive rate on code with no known bug — so an empty
   * list is accepted and its recall is `null` with a reason, never 0.
   */
  bugs: FixtureBug[]
  /**
   * The author's own annotation, carried into the report.
   *
   * A fixture list is hand-written ground truth, and the reasons a fixture is
   * shaped the way it is — why it is a negative control, why a site has no line
   * range — are not derivable from the numbers. Refusing the field would force
   * the author to delete information to make the file valid.
   */
  note: string | null
}

export interface FixtureSet {
  version: number
  description: string | null
  fixtures: Fixture[]
}

/** How a candidate was tied to a bug: by line range, or only by file. */
export type MatchBasis = 'range' | 'file'

/**
 * One vulnerable/patched pair (spec §11.1).
 *
 * Two halves of the same function, and the ground truth is opposite in each: the
 * vulnerable text is a real bug, the patched text is not. Everything the corpus
 * does not know — a call graph, a line number, an engine rule — is absent rather
 * than synthesized.
 */
export interface FunctionPair {
  id: string
  project: string
  cwe: string | null
  cve: string | null
  /** The vulnerable revision, for provenance. */
  commitSha: string | null
  /** The commit that fixed it. */
  fixCommit: string | null
  /** Source text of the function before the fix. Ground truth: a bug. */
  vulnerable: string
  /** The same function after the fix. Ground truth: not a bug. */
  patched: string
  /** Recorded path, when the corpus has one. */
  filePath: string | null
  note: string | null
}

export interface PairSet {
  kind: 'function-pairs'
  version: number
  description: string | null
  /** Name of the corpus, e.g. `primevul-2024`. Identifies the target row. */
  corpus: string
  pairs: FunctionPair[]
}

/**
 * The persisted facts about a candidate that scoring reads.
 *
 * Deliberately not `CandidateRecord`: the funnel must be computable from a row
 * set, without the normalized evidence bundle or the program model, because the
 * question §11 asks is about counts and locations rather than about content.
 */
export interface EvalCandidate {
  id: string
  /** §4.3's engines, §4.8's pattern replay, or §4.2's correlation. */
  source: string
  filePath: string | null
  startLine: number | null
  endLine: number | null
  /** `new` | `triaged` | `verifying` | `escalated` | `confirmed` | `dropped` | `rediscovery` */
  state: string
  /** §4.6's label. Null means triage never produced one for this candidate. */
  triage: string | null
  /** True when §4.2 tagged this candidate as an already-known advisory. */
  rediscovery: boolean
  /**
   * True when a model proposed this candidate rather than a detector (§20.29.4).
   *
   * Required rather than optional, so every construction site has to declare which kind
   * of candidate it is building. Defaulting it to `false` would silently classify a
   * model's proposal as a detector's finding, which is the mistake §20.29.4 is about —
   * and the kind of default that is only ever wrong in the direction of overstating what
   * the detectors did.
   */
  modelProposed: boolean
  /**
   * True when §5.3 queued this candidate for a human, i.e. an
   * `adjudication_queue` row exists.
   *
   * This is what distinguishes "the human stage ran and nobody survived it" from
   * "the human stage never existed". Candidate state cannot tell the two apart:
   * two models that agreed the finding is real set `confirmed` directly, exactly
   * as a human agreeing with an escalated one does.
   */
  queuedForAdjudication: boolean
  /** The human's decision, while one is on record. Null for a pending entry. */
  adjudication: 'real' | 'benign' | null
}

/**
 * What the ground truth says about one candidate.
 *
 * `unscorable` is deliberately not folded into `unmatched`. A candidate nothing
 * can be said about is not a false positive, and counting it as one would make
 * a broken recon look like a noisy detector.
 */
export type GroundTruth =
  | { kind: 'matched'; bugs: FixtureBug[]; basis: MatchBasis }
  | { kind: 'unmatched' }
  | { kind: 'unscorable'; reason: string }

/** A run as scoring sees it: which commit it saw, and how much it produced. */
export interface EvalRun {
  id: string
  targetId: string
  commitSha: string
  status: string
  startedAt: string | null
  candidates: number
  /**
   * `runs.config_json`'s `staticOnly`, or null when the run recorded nothing.
   *
   * A discovery-only run has no model stages by construction, so scoring one and
   * reading the missing stages as recall loss would blame the models for not
   * being asked (§20.13.3's distinction, one level up).
   */
  staticOnly: boolean | null
}

export const FUNNEL_STAGES = [
  'raw',
  'post-triage',
  'post-verification',
  'post-adjudication',
] as const

export type FunnelStage = (typeof FUNNEL_STAGES)[number]

export interface FunnelStageDefinition {
  stage: FunnelStage
  label: string
  /**
   * §2.4's target false-positive rate for this stage. §11.3 exists to test these
   * numbers, so the target travels with the row it applies to rather than living
   * only in the spec prose.
   */
  targetFpRate: number
  spec: string
}

/** §3.2's funnel, in the order §11.2 reports it. */
export const FUNNEL_STAGE_DEFINITIONS: readonly FunnelStageDefinition[] = [
  { stage: 'raw', label: 'raw static hits', targetFpRate: 0.9, spec: '§2.4, §4.3' },
  { stage: 'post-triage', label: 'post-triage', targetFpRate: 0.6, spec: '§2.4, §4.6' },
  {
    stage: 'post-verification',
    label: 'post-verification',
    targetFpRate: 0.25,
    spec: '§2.4, §5',
  },
  {
    stage: 'post-adjudication',
    label: 'post-adjudication',
    targetFpRate: 0.1,
    spec: '§2.4, §5.3',
  },
]

/**
 * One stage of the funnel.
 *
 * Every metric is nullable for one reason: **a row for a stage that did not run
 * carries no numbers at all.** Not zeroes — nothing. A zero on this row would
 * mean "this stage ran and nothing survived", which is a completely different
 * statement from "this stage never ran", and the report is the only place the
 * difference can be kept (§18).
 */
export interface FunnelRow {
  stage: FunnelStage
  label: string
  status: 'scored' | 'not-run'
  /** Why the stage has no numbers. Null when `status` is `'scored'`. */
  reason: string | null
  /** Candidates still in the pipeline at this stage. */
  candidates: number | null
  truePositives: number | null
  falsePositives: number | null
  /** Candidates with no path to score against; in neither side of precision. */
  unscored: number | null
  /** Candidates at this stage that came from OSV correlation, not discovery. */
  rediscovery: number | null
  /**
   * Candidates at this stage that a model proposed rather than a detector (§20.29.4).
   *
   * Its own column for the reason §20.29.4 gives: a chat-then-confirm loop and an
   * engine-then-verify loop fail in completely different ways, so a funnel that pooled
   * them could not be compared against a run that did not use the investigator at all —
   * and would report the investigator's reading of the code as its detectors' quality.
   */
  modelProposed: number | null
  /** `TP / (TP + FP)`. Null when nothing at this stage could be scored. */
  precision: number | null
  /**
   * Distinct seeded bugs represented at this stage over the fixture's total,
   * counting bugs surfaced by an OSV rediscovery (§11.2's MVP recall metric).
   */
  recall: number | null
  /**
   * The same figure with rediscovery-only bugs excluded.
   *
   * This is the number that answers D11's actual question — whether the
   * *discovery path* works — because correlation finding a bug the fixture list
   * already knew about says nothing about the engines or the models. The two are
   * reported side by side so a run cannot pass the recall gate on rediscoveries
   * alone without that being visible.
   */
  discoveryRecall: number | null
  /** Bug ids represented at this stage, sorted, for a stable report. */
  bugsFound: string[] | null
  /** The subset of `bugsFound` reached by at least one non-rediscovery candidate. */
  bugsFoundByDiscovery: string[] | null
  /** Bugs covered at the previous stage and no longer. */
  bugsLost: string[] | null
  /** §2.4's target false-positive rate for this stage. */
  targetFpRate: number
  targetMet: boolean | null
  /** Per-stage observations a reader needs; never a substitute for `reason`. */
  notes: string[]
}

export interface EvalFixtureReport {
  fixtureId: string
  project: string
  commitSha: string
  /** The run scored against this fixture. Null when none matched the commit. */
  runId: string | null
  status: 'scored' | 'not-run'
  /** Why the fixture has no numbers. Null when `status` is `'scored'`. */
  reason: string | null
  /** Seeded bugs in this fixture. 0 for a negative control. */
  totalBugs: number
  funnel: FunnelRow[]
  /** Things a reader must know before treating the numbers as a score. */
  notes: string[]
}

export interface EvalReport {
  fixtureSetVersion: number
  fixtureSetDescription: string | null
  fixtures: EvalFixtureReport[]
  /** Fixtures that had a matching run and produced numbers. */
  scoredFixtures: number
  /** Fixtures with no matching run. Neither pass nor fail. */
  unscoredFixtures: number
  totalBugs: number
  /** Mean over scored fixtures that have seeded bugs. Null when none qualify. */
  recall: number | null
  discoveryRecall: number | null
  /** D11's gate. Default 0.20 and configurable (§9's pattern: a default, not an invariant). */
  minRecall: number
  gate: 'pass' | 'fail' | 'not-evaluable'
  /** Why the gate could not be evaluated. Null unless `gate` is `'not-evaluable'`. */
  gateReason: string | null
  caveats: string[]
}
