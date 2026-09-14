/**
 * The per-stage funnel (spec §11.2, §11.3, §2.4).
 *
 * §11.4's interpretation guide is the reason this module returns `bugsLost` and
 * not just counts: "a recall drop between triage and verification means the
 * Refuter is over-killing" is only answerable if the report says *which* seeded
 * bugs stopped being represented, not merely that the number fell. A count tells
 * the researcher to look; the ids tell them where.
 *
 * The stage predicates are transcriptions of the queries the stages themselves
 * run, not approximations of them. `post-triage` is
 * `persist.readCandidatesForVerification`'s SQL predicate and `post-verification`
 * is the pair of states §5.3 writes — because if this drifts, the funnel starts
 * describing a pipeline that does not exist, and it would keep doing so
 * plausibly.
 *
 * Membership is derived from candidate state rather than read from
 * `run_metrics`, deliberately. A run made by the individual stage commands has
 * no `run_metrics` row at all, and a funnel that could only score orchestrator
 * runs would be unavailable exactly when a single stage is being debugged.
 */

import { matchCandidate } from './match'

import { FUNNEL_STAGE_DEFINITIONS } from './types'

import type { EvalCandidate, Fixture, FunnelRow, FunnelStage } from './types'

/** Candidates that were alive at `stage`, mirroring the pipeline's own gates. */
export const stageSurvivors = (
  candidates: readonly EvalCandidate[],
  stage: FunnelStage,
): EvalCandidate[] => {
  switch (stage) {
    case 'raw':
      // Everything the run produced, including §4.2's rediscoveries: §11.2's
      // recall is "surfaced (candidate-stage or later)", and a rediscovery is
      // surfaced. That they are counted separately on the row, and excluded
      // from `discoveryRecall`, is what keeps this from flattering the score.
      return [...candidates]

    case 'post-triage':
      // §4.6. A `triage` of NULL is not a survivor: `readCandidatesForVerification`
      // selects only the two labelled values, so a candidate whose call failed
      // never reached verification. Note it, do not count it.
      return candidates.filter(
        (candidate) =>
          candidate.triage === 'likely-real' || candidate.triage === 'needs-context',
      )

    case 'post-verification':
      // §5.3's two non-dropped outcomes. `dropped` is the Refuter's kill.
      return candidates.filter(
        (candidate) => candidate.state === 'confirmed' || candidate.state === 'escalated',
      )

    case 'post-adjudication':
      // `recordAdjudicationDecision` moves `escalated` to `confirmed` or
      // `dropped`, so a confirmed candidate is one the human agreed with — or
      // one that never needed the human, which is §5's agreeing case.
      return candidates.filter((candidate) => candidate.state === 'confirmed')
  }
}

/**
 * Why a stage has no numbers, or null when it has them.
 *
 * The question is whether the *pipeline* offered the stage any work, not whether
 * the stage found anything: a stage that ran and killed everything is the most
 * interesting row in the report, and it must not be confused with one that was
 * never reached.
 */
const notRunReasonFor = (
  stage: FunnelStage,
  candidates: readonly EvalCandidate[],
): string | null => {
  switch (stage) {
    case 'raw':
      return null

    case 'post-triage':
      return candidates.some((candidate) => candidate.triage !== null)
        ? null
        : 'no candidate carries a triage label, so §4.6 never ran'

    case 'post-verification':
      return candidates.some(
        (candidate) =>
          candidate.state === 'confirmed' ||
          candidate.state === 'escalated' ||
          candidate.state === 'dropped',
      )
        ? null
        : 'no candidate reached a verification outcome, so §5 never ran'

    case 'post-adjudication':
      // The queue row is the only honest signal. Reading this off candidate
      // state would report a post-adjudication row for a run where two models
      // simply agreed, because §5.3 sets `confirmed` for both that case and the
      // case where a human confirmed an escalation.
      return candidates.some((candidate) => candidate.queuedForAdjudication)
        ? null
        : 'nothing was escalated, so §5.3 had no human decision to make'
  }
}

const emptyRow = (
  stage: FunnelStage,
  label: string,
  targetFpRate: number,
  reason: string,
): FunnelRow => ({
  stage,
  label,
  status: 'not-run',
  reason,
  candidates: null,
  truePositives: null,
  falsePositives: null,
  unscored: null,
  rediscovery: null,
  modelProposed: null,
  precision: null,
  recall: null,
  discoveryRecall: null,
  bugsFound: null,
  bugsFoundByDiscovery: null,
  bugsLost: null,
  targetFpRate,
  targetMet: null,
  notes: [],
})

/**
 * Score one fixture's candidates into §11.2's funnel.
 *
 * `candidates` are the candidates of *one run* against *one fixture*. Mixing
 * runs would make `bugsLost` meaningless, because a bug that disappeared between
 * two stages of different runs never disappeared at all.
 */
export const buildFunnel = (
  fixture: Fixture,
  candidates: readonly EvalCandidate[],
): FunnelRow[] => {
  const totalBugs = fixture.bugs.length
  const rows: FunnelRow[] = []

  // Carried across a stage that did not run, so the next scored stage's
  // `bugsLost` is measured against the last stage that actually reported.
  let previousFound: string[] = []

  for (const definition of FUNNEL_STAGE_DEFINITIONS) {
    const { stage, label, targetFpRate } = definition

    const notRun = notRunReasonFor(stage, candidates)
    if (notRun !== null) {
      rows.push(emptyRow(stage, label, targetFpRate, notRun))
      continue
    }

    const survivors = stageSurvivors(candidates, stage)
    const notes: string[] = []

    let truePositives = 0
    let falsePositives = 0
    let unscored = 0
    const found = new Set<string>()
    const foundByDiscovery = new Set<string>()
    // Bugs reached by at least one candidate a *detector* produced. Tracked separately
    // so the report can say whether the investigator added recall or merely relocated it,
    // which is §20.29.4's "the two loops fail in completely different ways" made
    // answerable rather than asserted.
    const foundByDetector = new Set<string>()

    for (const candidate of survivors) {
      const truth = matchCandidate(
        {
          filePath: candidate.filePath,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
        },
        fixture,
      )

      if (truth.kind === 'unscorable') {
        unscored += 1
        continue
      }

      if (truth.kind === 'unmatched') {
        falsePositives += 1
        continue
      }

      truePositives += 1
      for (const bug of truth.bugs) {
        found.add(bug.id)
        if (!candidate.rediscovery) foundByDiscovery.add(bug.id)
        if (!candidate.modelProposed) foundByDetector.add(bug.id)
      }
    }

    const scored = truePositives + falsePositives
    const precision = scored > 0 ? truePositives / scored : null
    const bugsFound = [...found].sort()
    const bugsFoundByDiscovery = [...foundByDiscovery].sort()

    const bugsLost = previousFound.filter((bugId) => !found.has(bugId)).sort()
    previousFound = bugsFound

    if (unscored > 0) {
      notes.push(
        `${unscored} candidate(s) could not be located, so they are in neither side ` +
          'of precision: a hit nothing can be said about is not a false positive (§18)',
      )
    }

    const rediscovery = survivors.filter((candidate) => candidate.rediscovery).length
    if (rediscovery > 0) {
      notes.push(
        `${rediscovery} of these came from §4.2 correlation rather than discovery; ` +
          'they count toward recall but not toward the discovery figure',
      )
    }

    // §20.29.4. A model proposal is a discovery — it is not a lookup against a known
    // advisory, so it stays inside `discoveryRecall` — but it is a different *kind* of
    // discovery from a detector's, and the two fail differently. What a reader actually
    // needs is not the count but whether these earned their place: bugs that nothing a
    // detector produced had already reached.
    const modelProposed = survivors.filter((candidate) => candidate.modelProposed).length
    if (modelProposed > 0) {
      const onlyFromProposals = bugsFound.filter((bugId) => !foundByDetector.has(bugId))
      notes.push(
        `${modelProposed} of these were proposed by §20.29's investigator rather than ` +
          'found by a detector; they count toward recall and toward the discovery figure, ' +
          'but a run that used the investigator is not comparable to one that did not ' +
          'unless this number is read first' +
          (onlyFromProposals.length > 0
            ? `. Reached by no detector: ${onlyFromProposals.join(', ')}`
            : '. Every one of them was also reached by a detector'),
      )
    }

    if (totalBugs === 0) {
      notes.push(
        'this fixture seeds no bugs, so it is a negative control: its recall is ' +
          'undefined and only its precision means anything',
      )
    }

    // The subset property is what makes the funnel a funnel. If it fails, the
    // gate in the pipeline is not the gate this table describes, and saying so
    // is more useful than a plausible-looking drop.
    const triageRow = rows.find((row) => row.stage === 'post-triage')
    if (stage === 'post-verification' && triageRow?.status === 'scored') {
      const triaged = new Set(
        stageSurvivors(candidates, 'post-triage').map((candidate) => candidate.id),
      )
      const verifiedNotTriaged = survivors.filter(
        (candidate) => !triaged.has(candidate.id),
      ).length
      if (verifiedNotTriaged > 0) {
        notes.push(
          `${verifiedNotTriaged} candidate(s) reached verification without a surviving ` +
            'triage label, so this row is not a subset of the one above it',
        )
      }
    }

    if (stage === 'post-adjudication') {
      const pending = candidates.filter(
        (candidate) => candidate.queuedForAdjudication && candidate.adjudication === null,
      ).length
      if (pending > 0) {
        notes.push(
          `${pending} escalated candidate(s) have no recorded decision yet, so this ` +
            'row is provisional and will move when §5.3 is worked',
        )
      }
    }

    rows.push({
      stage,
      label,
      status: 'scored',
      reason: null,
      candidates: survivors.length,
      truePositives,
      falsePositives,
      unscored,
      rediscovery,
      modelProposed,
      precision,
      recall: totalBugs > 0 ? bugsFound.length / totalBugs : null,
      discoveryRecall: totalBugs > 0 ? bugsFoundByDiscovery.length / totalBugs : null,
      bugsFound,
      bugsFoundByDiscovery,
      bugsLost,
      targetFpRate,
      // §2.4's table is a false-positive-rate target, so a stage meets it when
      // at most that share of what survived is noise. An unscorable stage has
      // nothing to compare and reports null rather than a pass.
      targetMet: precision === null ? null : 1 - precision <= targetFpRate,
      notes,
    })
  }

  return rows
}
