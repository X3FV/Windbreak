/**
 * Scoring a fixture set against the state database (spec §11, D11, D22).
 *
 * Three things make this command different from every other one in WindBreak,
 * and all three are deliberate:
 *
 * **It makes no model call and touches no network.** Scoring reads rows that
 * already exist. §8.4's verdict cache is what makes that meaningful — the same
 * run re-scored twice cannot drift, so a change in the funnel is a change in the
 * pipeline or the fixture list and never a change in the provider.
 *
 * **The join key is the commit SHA.** A fixture is not "the target the researcher
 * means", it is a specific revision, and the only evidence that a run saw that
 * revision is that the run recorded it. A fixture whose commit no run is pinned
 * to is reported as unscored, never as a fixture with zero recall (§18).
 *
 * **The gate is D11's, and it is on the surfaced figure.** §11.2's MVP metric is
 * "surfaced (candidate-stage or later) / total seeded", which is exactly the
 * `raw` row's recall. The stages after it are reported because they are how a
 * researcher explains that number, not because they set it.
 */

import { buildFunnel } from './funnel'
import { readJsonFile } from './load'
import { parseFixtureSet } from './manifest'
import { readEvalCandidates, readEvalRuns } from './read'

import type { Database } from 'bun:sqlite'
import type {
  EvalCandidate,
  EvalFixtureReport,
  EvalReport,
  EvalRun,
  Fixture,
  FixtureSet,
  FunnelRow,
} from './types'

/** D11's bar. A default, not an invariant — §9 makes the same distinction for quotas. */
export const DEFAULT_MIN_RECALL = 0.2

export class UnknownRunError extends Error {
  constructor(runId: string) {
    super(
      `No run ${runId} in the state database. Scoring a run that does not exist would ` +
        'report every fixture as unscored, which reads like a fixture problem (spec §18).',
    )
    this.name = 'UnknownRunError'
  }
}

/**
 * Read and validate a repo-snapshot fixture list.
 *
 * A missing file is an error rather than an empty set, for the same reason a
 * missing database is refused by name in §20.14.1: an empty list produces a
 * report with no fixtures in it, and "no fixtures" reads like "nothing to fail".
 *
 * `loadEvalInput` is the entry point the CLI uses, because it has to decide the
 * tier first. This stays for callers that already know theirs.
 */
export const loadFixtureSet = (filePath: string): FixtureSet =>
  parseFixtureSet(readJsonFile(filePath))

/**
 * Whether a run saw the revision a fixture is pinned to.
 *
 * Abbreviated shas are accepted in the fixture list, so the match is a prefix
 * one — and it is required to be a *prefix* rather than a substring, because a
 * fixture pinned to `deadbee` must not match a run whose commit merely contains
 * it. The manifest floor of seven hex characters is what makes this safe.
 */
export const commitMatches = (fixtureCommit: string, runCommit: string): boolean => {
  const left = fixtureCommit.toLowerCase()
  const right = runCommit.toLowerCase()
  if (left === right) return true
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  return longer.startsWith(shorter)
}

/**
 * The run to score a fixture against.
 *
 * The newest by `started_at`, because a re-scan of the same revision is a
 * re-doing rather than additional evidence. `started_at` is an ISO string, so
 * the ordering is lexicographic and correct.
 */
const newestRunFor = (fixture: Fixture, runs: readonly EvalRun[]): EvalRun | null => {
  const matching = runs.filter((run) => commitMatches(fixture.commitSha, run.commitSha))
  return matching.length > 0 ? matching[0]! : null
}

/** The `raw` row is §11.2's surfaced metric: everything the run produced. */
const surfacedRow = (funnel: readonly FunnelRow[]): FunnelRow | null =>
  funnel.find((row) => row.stage === 'raw' && row.status === 'scored') ?? null

const mean = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0) / values.length

export interface RunEvalOptions {
  db: Database
  fixtureSet: FixtureSet
  /** Score only this run; every fixture it does not match is reported unscored. */
  runId?: string
  /** D11's gate on the surfaced recall. */
  minRecall?: number
}

/**
 * Score the fixture set against the database.
 *
 * Every fixture gets a row whether or not a run could be found: a report that
 * silently omits the fixtures it could not score is the failure this command
 * exists to avoid.
 */
export const runEval = (options: RunEvalOptions): EvalReport => {
  const minRecall = options.minRecall ?? DEFAULT_MIN_RECALL
  const allRuns = readEvalRuns(options.db)

  let runs = allRuns
  if (options.runId !== undefined) {
    const only = allRuns.filter((run) => run.id === options.runId)
    if (only.length === 0) throw new UnknownRunError(options.runId)
    runs = only
  }

  const fixtures: EvalFixtureReport[] = []

  for (const fixture of options.fixtureSet.fixtures) {
    const matching = runs.filter((run) => commitMatches(fixture.commitSha, run.commitSha))
    const run = newestRunFor(fixture, runs)

    if (run === null) {
      fixtures.push({
        fixtureId: fixture.id,
        project: fixture.project,
        commitSha: fixture.commitSha,
        runId: null,
        status: 'not-run',
        reason:
          options.runId !== undefined
            ? `run ${options.runId} is not pinned to ${fixture.commitSha}`
            : `no run in the database is pinned to ${fixture.commitSha}, so nothing ` +
              'has been scored against this fixture',
        totalBugs: fixture.bugs.length,
        funnel: [],
        notes: fixture.note === null ? [] : [fixture.note],
      })
      continue
    }

    const candidates: EvalCandidate[] = readEvalCandidates(options.db, run.id)
    const funnel = buildFunnel(fixture, candidates)
    const notes = [`scored against run ${run.id} (status: ${run.status})`]
    if (fixture.note !== null) notes.push(`fixture note: ${fixture.note}`)

    if (matching.length > 1) {
      const others = matching
        .slice(1)
        .map((other) => other.id)
        .join(', ')
      notes.push(
        `${matching.length} runs are pinned to this commit; scoring the newest and ` +
          `ignoring ${others}`,
      )
    }

    if (run.staticOnly === true) {
      notes.push(
        'this run was discovery-only (--static-only), so its model stages were never ' +
          'asked and their absence is not recall loss',
      )
    } else if (run.staticOnly === null) {
      notes.push('the run recorded no mode flags, so its stage coverage is unknown')
    }

    if (run.status !== 'complete') {
      notes.push(
        `the run is ${run.status}, so this funnel describes a pipeline that did not ` +
          'finish',
      )
    }

    fixtures.push({
      fixtureId: fixture.id,
      project: fixture.project,
      commitSha: fixture.commitSha,
      runId: run.id,
      status: 'scored',
      reason: null,
      totalBugs: fixture.bugs.length,
      funnel,
      notes,
    })
  }

  const scored = fixtures.filter((report) => report.status === 'scored')
  const withBugs = scored.filter((report) => report.totalBugs > 0)

  const recalls: number[] = []
  const discoveryRecalls: number[] = []
  for (const report of withBugs) {
    const row = surfacedRow(report.funnel)
    if (row?.recall != null) recalls.push(row.recall)
    if (row?.discoveryRecall != null) discoveryRecalls.push(row.discoveryRecall)
  }

  const recall = recalls.length > 0 ? mean(recalls) : null
  const discoveryRecall =
    discoveryRecalls.length > 0 ? mean(discoveryRecalls) : null

  const caveats: string[] = [
    'a candidate that matches no seeded site is counted as a false positive, but it ' +
      'may be a real bug the fixture list does not seed — so every precision figure ' +
      'here is a lower bound on the true one',
  ]

  const unscored = fixtures.filter((report) => report.status === 'not-run')
  if (unscored.length > 0) {
    caveats.push(
      `${unscored.length} fixture(s) had no run to score and are therefore neither a ` +
        'pass nor a failure; the figures above cover the other ' +
        `${scored.length}`,
    )
  }

  const negativeControls = scored.filter((report) => report.totalBugs === 0)
  if (negativeControls.length > 0) {
    caveats.push(
      `${negativeControls.length} scored fixture(s) seed no bugs and contribute only to ` +
        'the precision figures, not to recall',
    )
  }

  if (discoveryRecall !== null && recall !== null && discoveryRecall < recall) {
    caveats.push(
      'the discovery figure is lower than the surfaced one, which means some seeded bugs ' +
        'were surfaced by §4.2 correlation rather than by discovery — and correlation ' +
        'finding a bug the fixture list already knew about says nothing about the engines',
    )
  }

  const gate: EvalReport['gate'] =
    recall === null ? 'not-evaluable' : recall >= minRecall ? 'pass' : 'fail'

  const gateReason =
    recall === null
      ? withBugs.length === 0
        ? 'no scored fixture seeds any bug, so there is no recall to gate on'
        : 'no fixture could be scored, so there is no recall to gate on'
      : null

  return {
    fixtureSetVersion: options.fixtureSet.version,
    fixtureSetDescription: options.fixtureSet.description,
    fixtures,
    scoredFixtures: scored.length,
    unscoredFixtures: unscored.length,
    totalBugs: scored.reduce((total, report) => total + report.totalBugs, 0),
    recall,
    discoveryRecall,
    minRecall,
    gate,
    gateReason,
    caveats,
  }
}
