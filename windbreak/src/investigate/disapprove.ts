/**
 * Disapprove first (spec §20.42).
 *
 * The problem this module solves is not "the model did not check its work". It is
 * that **a model asked to review its own work reviews the *claim*, not the
 * artifact** — and the claim is the part it already believes. Every live defect
 * this repository has recorded came from that gap: §20.35.6's `-O1` deleting the
 * defect while coverage stayed at `cov: 5`, §20.35.1's bare `SEGV` from a
 * mismatched call, §20.29's first hunt that "read both files, ran seven commands,
 * and proposed nothing" and reported itself `ok: true`. In each case the model's
 * account of what it did was true and its conclusion did not follow from it.
 *
 * So this module does four things, and none of them is "ask the model if it is
 * sure":
 *
 * 1. **It names the ways a work product can be invalid**, as a table, not as
 *    encouragement (`INVALIDITY_CLASSES`). A doubt that is not in the table is
 *    not a doubt this gate knows how to weigh, and an unknown class is refused
 *    rather than counted.
 * 2. **A check is a command, and the result is read from the run.** The model
 *    chooses what to run and says what it is about; the exit code, the output and
 *    the marker come from `check-result`, which is the sandbox's record. Nothing
 *    the model *asserts* about an outcome is accepted, for the same reason
 *    `propose.ts` reads the snippet from the file instead of storing what the
 *    model pasted.
 * 3. **Approval is not the default.** `deriveDisapproval` starts from
 *    `disapproved` and a work product has to *earn* its way out: every doubt the
 *    work product's own shape makes required must have been attempted and must
 *    have survived. An unattempted doubt is not a pass; a check that could not be
 *    judged is not a pass; a check that hung is not a pass. This is the inversion
 *    §20.4 asks for, and it is the only version of self-review a model cannot
 *    satisfy by being agreeable.
 * 4. **It runs before the review, and the review is handed the result.** The
 *    gate `gateReview` refuses to let the *model-generated* review start until
 *    there is a disapproval record that came out `approved`, and
 *    `buildReviewPrompt` opens the review with the doubts that survived rather
 *    than with the claim. The point is anchoring: §5.1's whole design is that the
 *    reviewer should not inherit the proposer's frame, and a reviewer that reads
 *    "here is my PoC, it works" before it reads anything else has inherited it.
 *
 * ## Why the doubt tables are separate from the confirmation tables
 *
 * §20.35's `decidable.ts` asks *"did this defect manifest in the shape this class
 * manifests in"* about a **fuzz target windbreak generated**. These classes ask a
 * different question about a **different artifact** — a proof of concept, a patch
 * or a reading the model itself produced. The two overlap in exactly one place
 * (`defect-not-the-harness`, which reuses §20.35's signature discipline), and
 * merging them would mean one table whose entries each had to say which of two
 * questions they answered. They are kept apart for the reason §20.35.2 keeps
 * `FUZZ_DECIDABLE` apart from `FUZZ_UNDECIDABLE`: a refusal should say **which
 * kind of no it is**.
 *
 * ## What this module deliberately does not do
 *
 * It does not run anything, and it does not call a model. Every function here is
 * pure, so the table and the gate are pinned by tests before a subprocess exists —
 * the posture `confirm/decidable.ts` and `confirm/attribute.ts` already take.
 * The command that produces a `CheckResult` is `investigate/tools.ts`'s
 * `record_falsification_check`, so the thing that executes and the thing that
 * judges are separable and separately testable.
 */

/**
 * What a work product claims, as flags rather than as prose.
 *
 * The required doubt set is derived from these, so "which checks does this claim
 * owe" is a function of the claim's shape and not of a model's judgement about
 * which checks seem worthwhile. A model that could choose its own required set
 * would choose the two it already knows it passes.
 */
export const WORK_PRODUCT_FLAGS = [
  /** The claim rests on a failure being reproduced, not on reading code. */
  'asserts-reproduction',
  /** The claim asserts an attacker can get somewhere, so a path has to be shown. */
  'asserts-reachability',
  /** The claimant edited the tree under test, so the subject may not be the target's. */
  'wrote-to-subject',
  /**
   * The claim rests on a command having been run at all.
   *
   * Required for the two doubts that apply to *any* executed check — whether the
   * check can fail, and whether the precondition was established — because both
   * are about the run rather than about the defect. A product with no run has no
   * check to weigh, and is `unverified` rather than approved (§20.42.5).
   */
  'rests-on-a-run',
] as const

export type WorkProductFlag = (typeof WORK_PRODUCT_FLAGS)[number]

/**
 * The thing being disapproved.
 *
 * `claim` is the model's own words and is kept verbatim: it is the *subject* of
 * the doubts, shown beside them so a reader can see what was being asserted when
 * the check ran. It is never evidence, and nothing in this module reads it.
 */
export interface WorkProduct {
  /** What the model asserts. Its wording, not a normalized statement. */
  claim: string
  flags: readonly WorkProductFlag[]
}

/** `marker: 'required'` means a check without a marker cannot be judged at all. */
export type MarkerRequirement = 'required' | 'optional'

/**
 * What the check has to do for the work to survive this doubt.
 *
 * The direction is the whole content of the type, so it is worth stating: a check
 * listed as `fails` is one that **must fail in order to be reassuring** — a
 * reproduction that succeeds, a control that catches nothing, a probe that runs
 * clean. Reading it backwards is the single easiest way to get this gate wrong,
 * which is why the field is not a boolean named `expectFailure`.
 */
export type Expectation =
  | {
      kind: 'fails'
      marker: MarkerRequirement
      /** What a failure here shows, for the record. */
      means: string
    }
  | {
      kind: 'succeeds'
      marker: MarkerRequirement
      means: string
    }
  | {
      /** The check must complete and must *not* produce the marker. */
      kind: 'marker-absent'
      means: string
    }

export interface InvalidityClass {
  id: string
  /**
   * The doubt, as one sentence, in the second person because it is read by the
   * model that has to answer it.
   */
  doubt: string
  /** What settles it — an executable check, described so the model can write it. */
  settles: string
  expects: Expectation
  /** When this doubt is owed. */
  requiredWhen: readonly WorkProductFlag[]
  /**
   * The recorded defect this class exists because of.
   *
   * Every class carries one. A doubt with no origin is a guess wearing a table
   * row's clothes, and the origin is what lets a reader decide whether the check
   * was aimed at something that actually happened.
   */
  origin: string
}

/**
 * The table.
 *
 * Ordered as it should be read: the four doubts about a reproduction, then the
 * two about any run, then the two about a claim that reaches or edits something.
 */
export const INVALIDITY_CLASSES: readonly InvalidityClass[] = [
  {
    id: 'reproduced-twice',
    doubt: 'it worked once, and once is not a reproduction.',
    settles:
      'run the same command again with the same input and the same seed, and show it ' +
      'failing the same way. Record the second run, not a description of it.',
    expects: {
      kind: 'fails',
      marker: 'optional',
      means: 'the same command, run again, failed the way the first one did',
    },
    requiredWhen: ['asserts-reproduction'],
    origin:
      '§20.35.4: a single run is silence, and silence is not disproof. The same rule ' +
      'read the other way is that a single success is not a reproduction either.',
  },
  {
    id: 'defect-not-the-harness',
    doubt:
      'the failure is the harness calling the code with the wrong signature, not the defect.',
    settles:
      'record the sanitizer category the run produced. A bare SEGV is not evidence for a ' +
      'memory class — under a sanitized build those report their own category, so a plain ' +
      'SEGV means the sanitizer did not see the access.',
    expects: {
      kind: 'fails',
      marker: 'required',
      means: 'the run failed with the category this class is supposed to produce',
    },
    requiredWhen: ['asserts-reproduction'],
    origin:
      '§20.35.1: "a `SEGV` from a mismatched call is indistinguishable from a `SEGV` ' +
      'that *is* the defect." The generated-target path solved this with a signature ' +
      'table; a hand-written PoC has to settle it the same way.',
  },
  {
    id: 'behavior-still-present',
    doubt: 'the compiler removed the behaviour, so a clean run proves nothing.',
    settles:
      'show the run failing at the flags the PoC actually used. If the build optimized ' +
      'the subject away, nothing downstream can be read from it.',
    expects: {
      kind: 'fails',
      marker: 'required',
      means: 'the behaviour survived the build and manifested at these flags',
    },
    requiredWhen: ['asserts-reproduction'],
    origin:
      '§20.35.6 defect 1: `-O1` deleted the defect, the fuzzer executed 24 million ' +
      'inputs, and coverage stayed at `cov: 5` with an empty corpus. The body never ran ' +
      'and every metric looked like a finished run.',
  },
  {
    id: 'fired-in-the-named-code',
    doubt: 'something failed, but not in the code the finding names.',
    settles:
      'check the report\'s own location against the finding\'s file and line, or against ' +
      'the function the finding names. Record both locations.',
    expects: {
      kind: 'succeeds',
      marker: 'required',
      means: 'the recorded location is the finding\'s own code, not a neighbour',
    },
    requiredWhen: ['asserts-reproduction'],
    origin:
      '§20.35.3\'s location gate, applied to a PoC the model wrote rather than to a ' +
      'target windbreak generated. One translation unit can carry several defects and ' +
      'the finding names only one.',
  },
  {
    id: 'success-is-the-targets',
    doubt:
      'the output you are treating as proof was printed by your own harness, not by the target.',
    settles:
      'run the same harness with the vulnerable input withheld, or with the guard put back, ' +
      'and show the string you are calling proof does not appear.',
    expects: {
      kind: 'marker-absent',
      means: 'with the cause removed the proof-string vanished, so it came from the target',
    },
    requiredWhen: ['asserts-reproduction'],
    origin:
      '`sandbox/probe.ts` marks its own branches (`READ_ONLY_ENFORCED`, `NO_WRITES_AT_ALL`) ' +
      'so that a shell\'s own message cannot be read as the sandbox\'s behaviour. A PoC that ' +
      'prints its result unconditionally has the same problem with the target.',
  },
  {
    id: 'check-can-fail',
    doubt: 'this check may be incapable of failing, in which case its silence means nothing.',
    settles:
      'run the same check against a control that must fail — a known-bad input, or the ' +
      'same subject with the guard removed — and show it failing.',
    expects: {
      kind: 'fails',
      marker: 'optional',
      means: 'the check demonstrably detects the thing it is being used to rule out',
    },
    requiredWhen: ['rests-on-a-run'],
    origin:
      '`sandbox/probe.ts`: the read-only probe must show a writable bind succeeding *in ' +
      'the same sandbox*, "otherwise a sandbox that simply cannot write anything would ' +
      'pass". A check with no positive control is that sandbox.',
  },
  {
    id: 'precondition-established',
    doubt: 'the claim assumes a configuration, privilege or state it never establishes.',
    settles:
      'run the command that shows the precondition holds, or name the precondition and ' +
      'where it comes from. An assumed precondition is a stated one or it is a gap.',
    expects: {
      kind: 'succeeds',
      marker: 'optional',
      means: 'the precondition was observed to hold in the environment the claim is about',
    },
    requiredWhen: ['rests-on-a-run'],
    origin:
      '§20.29: "the preconditions an attacker must satisfy". Zabbix\'s program policy ' +
      'states the same rule from the other side — "overriding secure default ' +
      'configuration will not be accepted as a prerequisite" — and a claim whose ' +
      'precondition is a modified default is out of scope before it is wrong.',
  },
  {
    id: 'input-reaches-the-sink',
    doubt: 'the input never reached the code under test, so the run shows nothing.',
    settles:
      'show the sink was reached: a marker the sink prints, or coverage for the function ' +
      'the finding names. Absence of a crash is not absence of a path.',
    expects: {
      kind: 'succeeds',
      marker: 'required',
      means: 'the input demonstrably arrived at the code being claimed about',
    },
    requiredWhen: ['asserts-reachability'],
    origin:
      '§20.35.6 defect 1 again, read as a reachability failure: "coverage stayed at ' +
      '`cov: 5` with an empty corpus". §4.4.4 exists because "the code is real, but not ' +
      'reachable in this build" is the most common reason a technically-true report is ' +
      'closed, and an unshown path is the same defect one level down.',
  },
  {
    id: 'subject-is-the-targets',
    doubt:
      'the harness stubs or replaces the function under test, so the code exercised is not the target\'s.',
    settles:
      'build the target\'s own code and show the report landing in the target\'s file. A ' +
      'stub, a reimplementation or a copy of the function makes the result a fact about ' +
      'the harness.',
    expects: {
      kind: 'fails',
      marker: 'required',
      means: 'the failure came out of the target\'s own compiled code',
    },
    requiredWhen: ['wrote-to-subject'],
    origin:
      '§20.29.4: "a model that read the code and formed an opinion is not an engine ' +
      'match" — and, one step further, "a model that patched the copy and then proposed ' +
      'the patch as a finding would be citing code it wrote."',
  },
]

/** Lookup by id. Built from the array so the table has one source. */
const BY_ID = new Map(INVALIDITY_CLASSES.map((klass) => [klass.id, klass]))

export const invalidityClass = (id: string): InvalidityClass | null =>
  BY_ID.get(id) ?? null

/** Whether an id names a class this gate knows how to weigh. */
export const isInvalidityClassId = (id: string): boolean => BY_ID.has(id)

/**
 * The doubts this work product owes.
 *
 * A union rather than an intersection: a product that both reproduces something and
 * reaches it owes both sets. The two `rests-on-a-run` doubts are owed by anything
 * executed, including a product that edited nothing and reproduces nothing — they
 * are about the check rather than about the subject.
 */
export const requiredClassesFor = (product: WorkProduct): string[] =>
  INVALIDITY_CLASSES.filter((klass) =>
    klass.requiredWhen.some((flag) => product.flags.includes(flag)),
  ).map((klass) => klass.id)

/**
 * What a command did, as the sandbox recorded it.
 *
 * Structurally `SandboxRunResult`'s security-relevant half rather than that type
 * itself, so the judge can be exercised without constructing an argv, a backend
 * name or a duration. `timedOut` is kept because a hang is not a pass and the
 * judgement has to be able to say so.
 */
export interface CheckResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type CheckOutcome =
  /** The check ran and the doubt did not hold. The work survives this one. */
  | 'survived'
  /** The check ran and the doubt was **confirmed**: the work does not hold. */
  | 'invalidated'
  /**
   * The check ran and settled nothing — the wrong marker, a marker that was
   * needed and not given, a timeout. Not a pass, and recorded as its own word so
   * a reader can tell "it held" from "we could not tell".
   */
  | 'inconclusive'

export interface CheckJudgement {
  outcome: CheckOutcome
  /** Always set. A judgement a reader cannot check is a judgement, not a record. */
  detail: string
}

/** One recording of a check: what was run, what it was about, and what it did. */
export interface FalsificationAttempt {
  klass: string
  /** The command as run, for the record. */
  argv: readonly string[]
  /** What this check is about, in the model's words. Shown beside the result. */
  describes: string
  /** The string the check's output was matched against, when one was given. */
  marker: string | null
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const outputOf = (result: CheckResult): string =>
  `${result.stdout}\n${result.stderr}`

const matches = (
  result: CheckResult,
  marker: string | null,
): boolean => marker !== null && outputOf(result).includes(marker)

/**
 * Judge one check against the doubt it was aimed at.
 *
 * Four rules are enforced here and each is a place a self-review would otherwise
 * pass itself:
 *
 * - **A timeout is `inconclusive`, never `survived`.** A check that hung did not
 *   demonstrate anything, and the failure mode this prevents is a harness that
 *   deadlocks being recorded as a harness that found nothing (§18: a missing
 *   binary is not an empty result).
 * - **A needed marker that was not given is `inconclusive`.** For the classes
 *   where the doubt is *which* failure this is, a result with no marker cannot
 *   settle it — and the honest answer is that the check was not written in a way
 *   that could settle it, not that it passed.
 * - **The three expectations are not interchangeable.** `fails` is reassured by a
 *   non-zero exit and invalidated by a zero one; `succeeds` is the opposite; and
 *   `marker-absent` needs a *completed* run before the absence counts, because a
 *   process that died on startup produces no marker for uninteresting reasons.
 * - **A marker that does not match is `inconclusive`, not `invalidated`.** The
 *   check failed, but not with the thing the doubt was about, so this run is not
 *   evidence either way about the finding.
 */
export const judgeCheck = (
  klass: InvalidityClass,
  attempt: { marker: string | null },
  result: CheckResult,
): CheckJudgement => {
  if (result.timedOut) {
    return {
      outcome: 'inconclusive',
      detail:
        'the check timed out. A check that did not finish demonstrates nothing, and is ' +
        'recorded as unjudged rather than as a pass.',
    }
  }

  const { expects } = klass
  const markerRequired = expects.kind !== 'marker-absent' && expects.marker === 'required'

  if (markerRequired && attempt.marker === null) {
    return {
      outcome: 'inconclusive',
      detail:
        `this doubt is about *which* failure the run produced, and no marker was given to ` +
        `match against. A result without one cannot settle it.`,
    }
  }

  if (expects.kind === 'fails') {
    if (result.exitCode === 0) {
      return {
        outcome: 'invalidated',
        detail:
          'the check succeeded but this doubt requires it to fail. ' + expects.means + '.',
      }
    }
    if (attempt.marker !== null && !matches(result, attempt.marker)) {
      return {
        outcome: 'inconclusive',
        detail:
          `the check failed, but not with "${attempt.marker}". A different failure does ` +
          'not settle this doubt.',
      }
    }
    return { outcome: 'survived', detail: expects.means }
  }

  if (expects.kind === 'succeeds') {
    if (result.exitCode !== 0) {
      return {
        outcome: 'invalidated',
        detail:
          'the check failed but this doubt requires it to succeed. ' + expects.means + '.',
      }
    }
    if (attempt.marker !== null && !matches(result, attempt.marker)) {
      return {
        outcome: 'inconclusive',
        detail:
          `the check succeeded, but its output does not contain "${attempt.marker}", so ` +
          'there is no record that the thing being looked for happened.',
      }
    }
    return { outcome: 'survived', detail: expects.means }
  }

  // marker-absent. A run that did not complete produces no marker for reasons that
  // have nothing to do with the doubt, so the absence only counts after a clean exit.
  if (result.exitCode !== 0) {
    return {
      outcome: 'inconclusive',
      detail:
        'the check did not complete, so the marker\'s absence proves nothing about the ' +
        'work. A run that failed to start is not a run that found nothing.',
    }
  }
  if (attempt.marker !== null && matches(result, attempt.marker)) {
    return {
      outcome: 'invalidated',
      detail: `the check produced "${attempt.marker}", which this doubt says it must not.`,
    }
  }
  return { outcome: 'survived', detail: expects.means }
}

/**
 * The three states a work product can be in when it reaches the review.
 *
 * `unverified` is the one worth explaining: it is **not** a weaker `disapproved`.
 * `disapproved` means a doubt was owed and went unanswered, or a check came back
 * against the work — there is something to argue with. `unverified` means no check
 * was owed at all, because the product rests on nothing executable, so there is
 * nothing that *could* have survived. A review of it would be a review of the
 * claim's wording, which is the failure this whole gate exists to prevent.
 */
export const DISAPPROVAL_DISPOSITIONS = ['approved', 'disapproved', 'unverified'] as const
export type DisapprovalDisposition = (typeof DISAPPROVAL_DISPOSITIONS)[number]

export interface DisapprovalRecord {
  disposition: DisapprovalDisposition
  /** The doubts this product owes, in table order. */
  required: string[]
  /** One entry per **owed** doubt that had at least one attempt. */
  judged: Array<{
    klass: string
    outcome: CheckOutcome
    /** The judgement's own words, from the attempt that decided the aggregate. */
    detail: string
    attempts: number
  }>
  /**
   * Checks run against doubts this claim does not owe, aggregated the same way.
   *
   * Recorded rather than dropped because the alternative is disappearing work: a
   * model that ran an extra check did something a reader may want to see, and
   * `deriveFindings`' own rule is that nothing is dropped silently. It changes no
   * disposition either way — a claim is not approved by surplus checks.
   */
  surplus: Array<{
    klass: string
    outcome: CheckOutcome
    detail: string
    attempts: number
  }>
  /** Owed doubts with no attempt at all. */
  missing: string[]
  /** Owed doubts whose attempts settled nothing. */
  inconclusive: string[]
  /** Doubts a check came back against. */
  invalidated: string[]
  /** Attempts naming a class this table does not know. Refused, and said so. */
  unknown: string[]
  /**
   * The disposition, in a sentence. Always populated, including for `approved` —
   * an approval with no stated basis is the self-report this module does not trust.
   */
  reasons: string[]
}

/**
 * Aggregate several attempts at one doubt.
 *
 * Conservative in every direction: one invalidating result decides the doubt even
 * beside a surviving one, and one unjudgeable result outranks a surviving one. A
 * doubt is only satisfied by attempts that all came back clean, which is the
 * reading a gate that defaults to refusal needs — the alternative is a model
 * re-running a flaky check until one run agrees with it.
 */
const aggregate = (
  klass: InvalidityClass,
  attempts: readonly FalsificationAttempt[],
): { outcome: CheckOutcome; detail: string } | null => {
  if (attempts.length === 0) return null

  const judged = attempts.map((attempt) => ({
    attempt,
    judgement: judgeCheck(klass, { marker: attempt.marker }, attempt),
  }))

  const invalidated = judged.find((entry) => entry.judgement.outcome === 'invalidated')
  if (invalidated) return { outcome: 'invalidated', detail: invalidated.judgement.detail }

  const inconclusive = judged.find((entry) => entry.judgement.outcome === 'inconclusive')
  if (inconclusive) return { outcome: 'inconclusive', detail: inconclusive.judgement.detail }

  return { outcome: 'survived', detail: judged[0]!.judgement.detail }
}

/**
 * Decide the disposition from the claim's shape and the recorded checks.
 *
 * Approval is reached by elimination and never by assertion: the function starts
 * at `disapproved` and only replaces it once `missing`, `inconclusive` and
 * `invalidated` are all empty and there is at least one judged doubt. An empty
 * attempt list therefore disapproves every product that owes a check, and a
 * product that owes none comes out `unverified` rather than approved.
 *
 * `unknown` is reported and does not approve or disapprove on its own: an attempt
 * against a class this table does not have is not evidence about the work, and
 * counting it either way would be letting an unmodelled claim move the gate. It is
 * still recorded, because a model reaching for a doubt that does not exist is
 * something a reader should see.
 */
export const deriveDisapproval = (input: {
  product: WorkProduct
  attempts: readonly FalsificationAttempt[]
}): DisapprovalRecord => {
  const required = requiredClassesFor(input.product)
  const requiredSet = new Set(required)

  const byClass = new Map<string, FalsificationAttempt[]>()
  const unknown: string[] = []

  for (const attempt of input.attempts) {
    if (!isInvalidityClassId(attempt.klass)) unknown.push(attempt.klass)
    const list = byClass.get(attempt.klass) ?? []
    list.push(attempt)
    byClass.set(attempt.klass, list)
  }

  const judged: DisapprovalRecord['judged'] = []
  const surplus: DisapprovalRecord['surplus'] = []
  const missing: string[] = []
  const inconclusive: string[] = []
  const invalidated: string[] = []

  for (const id of required) {
    const klass = invalidityClass(id)
    if (!klass) continue

    const attempts = byClass.get(id) ?? []
    const result = aggregate(klass, attempts)

    if (result === null) {
      missing.push(id)
      continue
    }

    judged.push({
      klass: id,
      outcome: result.outcome,
      detail: result.detail,
      attempts: attempts.length,
    })

    if (result.outcome === 'invalidated') invalidated.push(id)
    if (result.outcome === 'inconclusive') inconclusive.push(id)
  }

  for (const [id, attempts] of byClass) {
    if (requiredSet.has(id)) continue
    const klass = invalidityClass(id)
    if (!klass) continue
    const result = aggregate(klass, attempts)
    if (result === null) continue
    surplus.push({
      klass: id,
      outcome: result.outcome,
      detail: result.detail,
      attempts: attempts.length,
    })
  }

  const reasons: string[] = []

  if (required.length === 0) {
    reasons.push(
      'nothing executable was claimed, so no check was owed. This is not an approval: ' +
        'there is nothing here that could have survived a doubt.',
    )
  }

  if (missing.length > 0) {
    reasons.push(
      `${missing.length} doubt(s) this claim owes were never checked: ${missing.join(', ')}. ` +
        'An unattempted doubt is not a pass.',
    )
  }

  if (inconclusive.length > 0) {
    reasons.push(
      `${inconclusive.length} check(s) settled nothing: ${inconclusive.join(', ')}. ` +
        'A check that could not be judged is recorded as unjudged, not as a pass.',
    )
  }

  if (invalidated.length > 0) {
    reasons.push(
      `${invalidated.length} check(s) came back against the work: ${invalidated.join(', ')}.`,
    )
  }

  if (unknown.length > 0) {
    reasons.push(
      `${unknown.length} attempt(s) named a doubt this gate does not model ` +
        `(${[...new Set(unknown)].join(', ')}); recorded, and not counted either way.`,
    )
  }

  const disposition: DisapprovalDisposition =
    required.length === 0
      ? 'unverified'
      : missing.length === 0 && inconclusive.length === 0 && invalidated.length === 0
        ? 'approved'
        : 'disapproved'

  if (disposition === 'approved') {
    reasons.push(
      `every doubt this claim owes was attempted and survived: ${required.join(', ')}.`,
    )
  }

  return {
    disposition,
    required,
    judged,
    surplus,
    missing,
    inconclusive,
    invalidated,
    unknown,
    reasons,
  }
}

/**
 * One line for the transcript, in the register §18 asks for: a state, then the
 * basis for it.
 */
export const describeDisapproval = (record: DisapprovalRecord): string => {
  const counts =
    `${record.judged.filter((entry) => entry.outcome === 'survived').length}/` +
    `${record.required.length} doubt(s) survived`

  switch (record.disposition) {
    case 'approved':
      return `disapproval: APPROVED — ${counts}.`
    case 'unverified':
      return 'disapproval: UNVERIFIED — no check was owed, so nothing was shown.'
    case 'disapproved':
      return `disapproval: DISAPPROVED — ${counts}; ${record.reasons[0] ?? ''}`.trim()
  }
}

/**
 * The order, as a gate you cannot walk past by leaving a field out.
 *
 * `null` is refused rather than treated as an empty record, because "no disapproval
 * was run" and "a disapproval was run and came back clean" must not be able to
 * arrive at the same branch. That is the same shape as §20.35's six outcomes and
 * §20.41's session states: the absence of a record is its own fact.
 *
 * Only the model-generated review is gated. A human looking at disapproved work is
 * not a review this function has any business preventing — the record is *shown* to
 * them, doubts and all, and §5.3 makes the human the tiebreak.
 */
export const gateReview = (
  record: DisapprovalRecord | null,
): { ok: true } | { ok: false; reason: string } => {
  if (record === null) {
    return {
      ok: false,
      reason:
        'no disapproval was recorded for this work. The order is disapprove first: a ' +
        'review that begins without the case against it begins from the claim.',
    }
  }

  if (record.disposition === 'unverified') {
    return {
      ok: false,
      reason:
        'the work is unverified: it rests on no check that could have survived a doubt, ' +
        'so a review of it would be a review of its wording.',
    }
  }

  if (record.disposition === 'disapproved') {
    return {
      ok: false,
      reason: `the work is disapproved: ${record.reasons.join(' ')}`,
    }
  }

  return { ok: true }
}

/**
 * The disobedience instruction, stated once and reused, for the same reason
 * `TRUST_FRAMING` is: a second hand-written copy of this sentence is a second
 * place for the rule to be softened.
 */
export const DISAPPROVAL_RULE =
  'An unattempted doubt is not a pass, and a check that could not be judged is not a ' +
  'pass. Approval is reached only by a check that ran and came back against the doubt.'

/**
 * The disapprove-first block an agent's system prompt carries.
 *
 * Built from the table rather than written out, because a hand-typed copy of nine
 * doubts in a prompt is a second table that drifts from this one — and the drift would
 * be invisible, since a prompt is not checked against anything. The model has to
 * *declare* its own required set here (an agent's prompt cannot know what it will
 * claim), so this states the rule for deriving it instead of the set itself.
 */
export const buildDisapproveFirstRule = (): string =>
  [
    '## Before you report, disapprove your own work first',
    '',
    'A conclusion you have not tried to falsify is not a finding, it is a sentence. So',
    'before your final answer, take what you are about to claim and work out which of the',
    'doubts below it owes — a claim that something reproduces owes every doubt marked',
    '`asserts-reproduction`; one that says an attacker can get somewhere owes',
    '`asserts-reachability`; anything that rests on a command you ran owes the',
    '`rests-on-a-run` doubts; anything you edited owes `wrote-to-subject`.',
    '',
    'For each doubt you owe, do one of two things:',
    '',
    '1. call `record_falsification_check` with the **exact command** that settles it.',
    '   The tool runs it and judges the result itself. Do not tell it what the outcome',
    '   will be and do not report an outcome for a check you did not run — you are not',
    '   the judge of your own check, and a check you describe instead of running is not',
    '   recorded at all.',
    '2. say plainly that you could not check it, and why.',
    '',
    DISAPPROVAL_RULE,
    '',
    'This is not a formality and it is not a reason to weaken your claim. A doubt you',
    'cannot settle is the most useful thing you can report: it tells the researcher where',
    'to spend their time, and it is exactly what a confident summary would have hidden.',
    '',
    'The doubts:',
    '',
    ...INVALIDITY_CLASSES.flatMap((klass) => [
      `- \`${klass.id}\` (owed by: ${klass.requiredWhen.join(', ')})`,
      `  doubt: ${klass.doubt}`,
      `  check: ${klass.settles}`,
      `  settles it when: ${klass.expects.means}`,
    ]),
  ].join('\n')

/**
 * The prompt for the disapproval phase.
 *
 * Three things make this different from "review your work", and all three are
 * load-bearing:
 *
 * - **The case against comes first and alone.** The phase is explicitly forbidden
 *   from arguing for the work; the approving argument is the *review's* job, and it
 *   is a separate phase that starts from what survives here.
 * - **Checks are stated as commands.** A doubt reported as considered-but-fine is
 *   not recorded, because `record_falsification_check` is what records one and it
 *   runs the command itself.
 * - **A doubt that cannot be checked is recorded as unattempted, with a reason.**
 *   That keeps the honest failure available: this gate would be worse than useless
 *   if the only way to satisfy it were to invent a passing check.
 */
export const buildDisapprovalPrompt = (input: {
  product: WorkProduct
  /** Extra context: the candidate, the commands already run, the finding. */
  subject?: string
}): string => {
  const required = requiredClassesFor(input.product)
  const classes = required
    .map((id) => invalidityClass(id))
    .filter((klass): klass is InvalidityClass => klass !== null)

  return [
    'PHASE: DISAPPROVE. Do not argue for this work in this phase.',
    '',
    'Your job is to establish the strongest case that the following claim does not hold:',
    '',
    `CLAIM: ${input.product.claim}`,
    ...(input.subject ? ['', input.subject] : []),
    '',
    'The doubts this claim owes, because of what it asserts:',
    '',
    ...classes.flatMap((klass) => [
      `- ${klass.id}: you have not shown that ${klass.doubt}`,
      `  check to run: ${klass.settles}`,
      `  settles it when: ${klass.expects.means}`,
      `  why this exists: ${klass.origin}`,
    ]),
    '',
    'For each doubt above, either:',
    '  1. call record_falsification_check with the exact command that settles it — the tool',
    '     runs it and records what actually happened, so state the command and not the',
    '     outcome; or',
    '  2. say plainly that you could not check it, and why.',
    '',
    DISAPPROVAL_RULE,
    '',
    'A doubt you did not check is recorded as unattempted, which is a refusal. That is',
    'the intended outcome for a doubt you cannot settle: this gate is worth nothing if',
    'the only way to pass it is to invent a check that passes.',
    '',
    'Answer in prose. There is no output schema: the record is what the tool wrote, not',
    'what you say about it.',
  ].join('\n')
}

/**
 * The prompt for the review phase, which cannot run until the disapproval approved.
 *
 * The review is handed the record rather than the claim, which is the anchoring fix
 * and the reason the order is enforced instead of merely recommended: a reviewer
 * that is told the work passed its own doubts, and told exactly which ones it
 * survived and why, is reviewing a different object than one handed a confident
 * summary. It may disagree — that is a review — but it has to disagree with a
 * recorded result rather than with nothing.
 */
export const buildReviewPrompt = (input: {
  product: WorkProduct
  record: DisapprovalRecord
  /** The question the review was asked, or null for a general review. */
  question?: string | null
}): string =>
  [
    'PHASE: REVIEW. The work below has already been put through disapproval, and the',
    'record of what it survived is stated before the claim is. Address the record: say',
    'where you agree with a surviving doubt and where you do not, and give the check you',
    'would run if you disagree with one.',
    '',
    describeDisapproval(input.record),
    '',
    ...input.record.judged.map(
      (entry) => `- ${entry.klass}: ${entry.outcome} — ${entry.detail}`,
    ),
    '',
    `CLAIM: ${input.product.claim}`,
    ...(input.question ? ['', `QUESTION: ${input.question}`] : []),
    '',
    'You are not being asked to agree with the claim. A review that confirms disapproved',
    'or unverified work is a review that failed, and saying so is the useful answer.',
    '',
    'Answer in prose. There is no output schema and no structured result to fill in.',
  ].join('\n')
