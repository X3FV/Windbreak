/**
 * Tier 1 — scoring a function-level corpus through the real stages (§11.1).
 *
 * The measurement is only worth anything if the stages are the shipping ones, so
 * this module does not reimplement any of them. It **materializes** each half of
 * each pair as a real candidate row and then calls `runTriage` and
 * `runVerification` unchanged. Three consequences follow, and all three are the
 * point:
 *
 * - **The prompts are production prompts.** §5.1's escaped, delimited evidence
 *   bundle, the same provenance line, the same role system prompts. A
 *   measurement taken through a shortcut would measure the shortcut.
 * - **The §8.4 verdict cache applies**, so a re-run of an unchanged corpus is
 *   free and comparable, and `--no-cache` is available when it must not be.
 * - **The `verdicts` and `run_metrics` rows are real**, so §11.3's "every run
 *   records its metrics" holds for this tier too.
 *
 * What it deliberately does **not** do is supply context the corpus does not
 * have. There is no program model, so §4.6's single enrichment attempt cannot
 * run and a `needs-context` label stands — which is itself worth knowing on a
 * corpus of isolated functions. The report says so rather than leaving a
 * reader to wonder why nothing was enriched.
 *
 * Verification is driven over **every** half, not only triage's survivors, so
 * the stage has a measurement of its own. The number that reflects production is
 * the composed row, where a half survives only if both stages kept it.
 */

import { createHash } from 'crypto'

import { createRun, finishRun, persistCandidates } from '../engines'
import { runTriage } from '../pipeline/triage'
import { runVerification } from '../pipeline/verify'
import { composeObservations, scoreStage } from './confusion'
import { halfPath } from './pairs'

import type { Database } from 'bun:sqlite'
import type { Candidate } from '../engines/types'
import type { ModelInvoker } from '../pipeline'
import type { Observation, StageMetrics } from './confusion'
import type { FunctionPair, PairSet } from './types'
import type { PairHalf } from './pairs'

/** Triage kept a half when the label is one §4.6 forwards to verification. */
export const TRIAGE_KEPT_LABELS = ['likely-real', 'needs-context'] as const

export interface Tier1Report {
  corpus: string
  corpusVersion: number
  description: string | null
  /** The synthetic target and run this measurement was recorded as. */
  targetId: string
  runId: string
  commitSha: string
  pairs: number
  stages: StageMetrics[]
  /**
   * Answers served from `verdict_cache`.
   *
   * Different units on purpose, matching each stage's own count: triage reports
   * **candidates** replayed and verification reports **role calls**, so one
   * verification candidate contributes two here.
   */
  cached: { triageCandidates: number; verificationCalls: number }
  /**
   * True when some answers came from the cache and some did not.
   *
   * §8.4 makes `--no-cache` the way to guarantee fresh calls, and a run that
   * silently mixed the two is not comparable to either. Reported rather than
   * prevented, because a partial cache hit is a legitimate and useful state.
   */
  mixedCache: boolean
  warnings: string[]
  caveats: string[]
}

export interface RunTier1Options {
  db: Database
  pairSet: PairSet
  invoker: ModelInvoker
  /** §8.4 `--no-cache`. */
  cacheDisabled?: boolean
  log?: (line: string) => void
  now?: () => number
}

/** A stable id for the corpus, so re-runs land on one target rather than many. */
const corpusTargetId = (corpus: string): string =>
  `primevul-${createHash('sha256').update(corpus).digest('hex').slice(0, 16)}`

/**
 * A digest of the corpus contents, recorded as the run's revision.
 *
 * It makes the `commit_sha` column mean something true — this exact set of pairs
 * — and keeps a changed corpus distinguishable from an unchanged one without
 * pretending to be a git commit. It cannot collide with a real fixture commit
 * because Tier 2's join is a prefix match against a 40-character digest that no
 * fixture author would have written.
 */
const corpusRevision = (pairSet: PairSet): string =>
  createHash('sha256')
    .update(
      pairSet.pairs
        .map((pair) => `${pair.id}:${pair.vulnerable}:${pair.patched}`)
        .join('\n'),
    )
    .digest('hex')
    .slice(0, 40)

export const ensureCorpusTarget = (input: {
  db: Database
  pairSet: PairSet
  commitSha: string
}): string => {
  const targetId = corpusTargetId(input.pairSet.corpus)
  // UPSERT rather than REPLACE: REPLACE deletes the row, and this target
  // accumulates runs and candidates across invocations (§20.7 does the same for
  // the same reason).
  input.db
    .prepare(
      `INSERT INTO targets (id, location, commit_sha, languages_json, build_model, scope_class, created_at)
       VALUES (?, ?, ?, ?, 'best-effort', 'app', ?)
       ON CONFLICT(id) DO UPDATE SET
         commit_sha = excluded.commit_sha,
         created_at = excluded.created_at`,
    )
    .run(
      targetId,
      `corpus://${input.pairSet.corpus}`,
      input.commitSha,
      JSON.stringify([{ language: 'c', files: input.pairSet.pairs.length }]),
      new Date().toISOString(),
    )
  return targetId
}

const lineCount = (source: string): number => source.split('\n').length

/**
 * One candidate per half.
 *
 * The evidence bundle is the function text and nothing else, which is exactly
 * what the corpus supplies. `sliceHash` binds the candidate to the text it was
 * derived from, as §14.1 intends, so an edited corpus produces different
 * candidates rather than silently re-scoring the old ones.
 */
export const corpusCandidates = (input: {
  runId: string
  pairSet: PairSet
}): Array<{ candidate: Candidate; pairId: string; half: PairHalf }> =>
  input.pairSet.pairs.flatMap((pair) =>
    (['vulnerable', 'patched'] as const).map((half) => {
      const source = half === 'vulnerable' ? pair.vulnerable : pair.patched
      const filePath = halfPath(pair)

      const candidate: Candidate = {
        id: `${input.runId}:${pair.id}:${half}`,
        source: 'primevul',
        patternId: 'primevul-pair',
        originPatchSha: pair.fixCommit,
        filePath,
        startLine: 1,
        endLine: lineCount(source),
        cwe: pair.cwe,
        state: 'new',
        injectionSignals: [],
        normalized: {
          engine: 'primevul',
          ruleId: 'primevul-pair',
          // The message is what the prompt shows as the engine's claim, so it
          // must not assert a detector's finding. It states the corpus's claim.
          message: `a function from the ${input.pairSet.corpus} corpus`,
          level: 'warning',
          filePath,
          startLine: 1,
          endLine: lineCount(source),
          snippet: source,
          sliceHash: createHash('sha256').update(source).digest('hex'),
          precision: null,
        },
      }

      return { candidate, pairId: pair.id, half }
    }),
  )

/**
 * Record this measurement in `run_metrics`, as §11.3 requires of every run.
 *
 * Written directly rather than through `scan`'s `writeRunMetrics`, because that
 * helper is typed to §3.2's stage ids and this run's stages are §11's. The column
 * shape is the same on purpose: one query can read either run's metrics, which is
 * the whole point of §11.3.
 */
export const writeTier1Metrics = (input: {
  db: Database
  runId: string
  stages: readonly StageMetrics[]
  pairs: number
  cached: number
  answered: number
  models: Array<{ role: string; modelId: string; provider: string }>
}): void => {
  const stageRecords = input.stages.map((stage) => ({
    stage: `tier1-${stage.stage}`,
    status: stage.status === 'scored' ? 'complete' : 'skipped',
    durationMs: 0,
    detail: stage.status === 'scored' ? `${stage.pairs} pair(s)` : stage.reason,
    counts:
      stage.status === 'scored'
        ? {
            truePositives: stage.truePositives ?? 0,
            falseNegatives: stage.falseNegatives ?? 0,
            falsePositives: stage.falsePositives ?? 0,
            trueNegatives: stage.trueNegatives ?? 0,
          }
        : {},
    reason: stage.reason,
  }))

  input.db
    .prepare(
      `INSERT OR REPLACE INTO run_metrics
         (run_id, stage_json, counts_json, cache_hit_rate, models_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      JSON.stringify(stageRecords),
      JSON.stringify({ pairs: input.pairs, halves: input.pairs * 2 }),
      input.answered === 0 ? null : input.cached / input.answered,
      JSON.stringify(input.models),
    )
}

/** Read the durable outcome back, rather than trusting the stage's return value. */
const readObservations = (input: {
  db: Database
  runId: string
  halves: ReadonlyArray<{ candidateId: string; pairId: string; half: PairHalf }>
  kind: 'triage' | 'verification'
}): Observation[] =>
  input.halves.map((entry) => {
    const row = input.db
      .query<{ triage: string | null; state: string }, [string]>(
        'SELECT triage, state FROM candidates WHERE id = ?',
      )
      .get(entry.candidateId)

    if (input.kind === 'triage') {
      const label = row?.triage ?? null
      if (label === null) {
        return {
          pairId: entry.pairId,
          half: entry.half,
          outcome: 'unscoreable' as const,
          detail: 'no triage label (the call failed)',
        }
      }
      return {
        pairId: entry.pairId,
        half: entry.half,
        outcome: (TRIAGE_KEPT_LABELS as readonly string[]).includes(label)
          ? ('flagged' as const)
          : ('cleared' as const),
        detail: label,
      }
    }

    const state = row?.state ?? null
    if (state === 'confirmed' || state === 'escalated' || state === 'dropped') {
      return {
        pairId: entry.pairId,
        half: entry.half,
        outcome: state === 'dropped' ? ('cleared' as const) : ('flagged' as const),
        detail: state,
      }
    }

    return {
      pairId: entry.pairId,
      half: entry.half,
      outcome: 'unscoreable' as const,
      detail: `no verification outcome (state: ${state ?? 'missing'})`,
    }
  })

export const runTier1 = async (options: RunTier1Options): Promise<Tier1Report> => {
  const log = options.log ?? (() => {})
  const commitSha = corpusRevision(options.pairSet)
  const targetId = ensureCorpusTarget({
    db: options.db,
    pairSet: options.pairSet,
    commitSha,
  })

  const runId = createRun({
    db: options.db,
    targetId,
    commitSha,
    config: {
      stage: 'eval',
      tier: 1,
      corpus: options.pairSet.corpus,
      corpusVersion: options.pairSet.version,
      pairs: options.pairSet.pairs.length,
    },
    ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
  })

  const materialized = corpusCandidates({ runId, pairSet: options.pairSet })
  const persisted = persistCandidates({
    db: options.db,
    runId,
    candidates: materialized.map((entry) => entry.candidate),
  })

  const halves = materialized.map((entry) => ({
    candidateId: entry.candidate.id,
    pairId: entry.pairId,
    half: entry.half,
  }))

  const candidates = materialized.map((entry) => ({
    id: entry.candidate.id,
    runId,
    targetId,
    source: entry.candidate.source,
    patternId: entry.candidate.patternId ?? null,
    originPatchSha: entry.candidate.originPatchSha ?? null,
    filePath: entry.candidate.filePath,
    startLine: entry.candidate.startLine,
    endLine: entry.candidate.endLine,
    cwe: entry.candidate.cwe ?? null,
    normalizedJson: JSON.stringify(entry.candidate.normalized),
    injectionSignals: entry.candidate.injectionSignals,
    state: 'new',
    triage: null,
  }))

  const triageResult = await runTriage({
    db: options.db,
    runId,
    candidates,
    invoker: options.invoker,
    // No program model exists for a function-level corpus, so §4.6's enrichment
    // pass has nothing to add and is switched off rather than attempted and
    // silently skipped inside the stage.
    enrich: false,
    ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
    ...(options.now ? { now: options.now } : {}),
    log,
  })

  const verificationResult = await runVerification({
    db: options.db,
    runId,
    candidates,
    invoker: options.invoker,
    ...(options.cacheDisabled ? { cacheDisabled: true } : {}),
    ...(options.now ? { now: options.now } : {}),
    log,
  })

  const triageObservations = readObservations({ db: options.db, runId, halves, kind: 'triage' })
  const verificationObservations = readObservations({
    db: options.db,
    runId,
    halves,
    kind: 'verification',
  })

  const triageScored = triageObservations.some((entry) => entry.outcome === 'flagged' || entry.outcome === 'cleared')
  const verificationScored = verificationObservations.some(
    (entry) => entry.outcome === 'flagged' || entry.outcome === 'cleared',
  )

  const stages: StageMetrics[] = [
    scoreStage({
      stage: 'triage',
      label: 'triage (§4.6)',
      pairs: options.pairSet.pairs,
      observations: triageObservations,
      notRunReason: triageScored
        ? null
        : 'no half received a triage label, so §4.6 did not answer',
    }),
    scoreStage({
      stage: 'verification',
      label: 'verification (§5.2)',
      pairs: options.pairSet.pairs,
      observations: verificationObservations,
      notRunReason: verificationScored
        ? null
        : 'no half reached a verification outcome, so §5 did not answer',
    }),
    scoreStage({
      stage: 'combined',
      label: 'composed (shipping order)',
      pairs: options.pairSet.pairs,
      observations: composeObservations(triageObservations, verificationObservations),
      notRunReason:
        triageScored && verificationScored
          ? null
          : 'the composed outcome needs both stages to have answered',
    }),
  ]

  /**
   * The two stages count cache hits in different units, and the report must not
   * average them.
   *
   * `runTriage` counts **candidates** it replayed; `runVerification` counts
   * **role calls**, so one verification candidate is two answers (Proposer and
   * Refuter). Both are the stages' own definitions, which is the right thing to
   * keep — but a mixed-cache verdict computed by adding them together would be
   * comparing candidates to calls and could land either way by accident.
   */
  const cached = {
    triageCandidates: triageResult.cached,
    verificationCalls: verificationResult.cached,
  }

  // Triage makes one call per candidate (enrichment is off below, so there is no
  // second pass) and verification makes two. These are call counts, which is
  // what the cached figures are, so the comparison is like for like.
  const totalCalls = triageResult.processed + verificationResult.verified * 2
  const totalCached = cached.triageCandidates + cached.verificationCalls
  const mixedCache = totalCached > 0 && totalCached < totalCalls
  const answered = totalCalls

  const warnings = [...triageResult.warnings, ...verificationResult.warnings]

  if (triageResult.enriched === 0 && triageResult.byLabel['needs-context'] > 0) {
    warnings.push(
      `${triageResult.byLabel['needs-context']} half/halves were labelled needs-context and ` +
        'could not be enriched: a function-level corpus has no program model to draw ' +
        '§4.6\'s second pass from (spec §11.1)',
    )
  }

  const models = (['triage', 'proposer', 'refuter'] as const).map((role) => {
    const identity = options.invoker.identity(role)
    return { role, modelId: identity.modelId, provider: identity.provider }
  })

  writeTier1Metrics({
    db: options.db,
    runId,
    stages,
    pairs: options.pairSet.pairs.length,
    cached: totalCached,
    answered,
    models,
  })

  // The run is `partial` when a stage could not answer for every half: a
  // measurement missing some of its corpus is narrower than the one requested
  // (§20.13.3's distinction).
  const incomplete =
    triageResult.failed > 0 ||
    verificationResult.failed > 0 ||
    triageResult.stoppedBy !== null ||
    verificationResult.stoppedBy !== null
  finishRun(options.db, runId, incomplete ? 'partial' : 'complete')

  const caveats = [
    'this measures the model stages on isolated functions. It is not repo-scale ' +
      'detection evidence: there is no engine candidate, no call path, and no program ' +
      'model, and §11.1 forbids the stronger claim',
    'the corpus supplies no program model, so §4.6\'s single enrichment pass cannot run ' +
      'and a needs-context label stands rather than being re-asked',
    'the halves are scored independently. The patched half was judged on its own text, ' +
      'not as a fix to the vulnerable one, which is the corpus\'s framing rather than a ' +
      'stronger two-function comparison',
  ]

  if (mixedCache) {
    caveats.push(
      'some answers came from the §8.4 verdict cache and some did not, so this result is ' +
        'not cleanly comparable to a fully cached or a fully fresh run — pass --no-cache ' +
        'for a run that is reproducible on its own',
    )
  }

  if (verificationScored) {
    caveats.push(
      'verification was driven over every half rather than only triage\'s survivors, so its ' +
        'row is the stage\'s own ability. The composed row is the production number',
    )
  }

  log(
    `[eval] tier 1: ${options.pairSet.pairs.length} pair(s), ` +
      `${persisted.inserted} candidate(s), run ${runId}`,
  )

  return {
    corpus: options.pairSet.corpus,
    corpusVersion: options.pairSet.version,
    description: options.pairSet.description,
    targetId,
    runId,
    commitSha,
    pairs: options.pairSet.pairs.length,
    stages,
    cached,
    mixedCache,
    warnings,
    caveats,
  }
}
