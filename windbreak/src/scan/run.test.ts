import { describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '../config'
import { persistCandidates } from '../engines'
import { createFakeInvoker } from '../pipeline/test-support'

import { runScan } from './run'
import { LIBRARY_OPT_IN_SKIP, STATIC_ONLY_SKIP } from './stages'
import {
  createScanDeps,
  engineCandidate,
  patchMineCandidate,
  patchMineStub,
  toctouCandidate,
  toctouStub,
  readRunStatus,
  readStages,
  reportResult,
  SCAN_TARGET_ID,
  SCAN_TARGET_ROOT,
  scanDatabase,
  seedScanTarget,
} from './test-support'

import type { Database } from 'bun:sqlite'
import type { ScanDeps } from './run'
import type { InvokerOutcome, ScanOptions, ScanResult } from './types'

const triageInvoker = () =>
  createFakeInvoker({
    respond: (call) =>
      call.role === 'triage'
        ? { label: 'likely-real', rationale: 'the buffer is unbounded' }
        : { verdict: 'real', reasoning: 'reachable', preconditions: [] },
  })

const options = (db: Database, extra: Partial<ScanOptions> = {}): ScanOptions => ({
  db,
  targetRoot: SCAN_TARGET_ROOT,
  targetId: SCAN_TARGET_ID,
  commitSha: 'abc123',
  config: DEFAULT_CONFIG,
  version: 'test',
  log: () => {},
  ...extra,
})

const stageOf = (result: ScanResult, stage: string) =>
  result.stages.find((record) => record.stage === stage)!

describe('runScan', () => {
  test('patch-mined candidates join the run and the static core\u2019s record', async () => {
    // §3.2 step 3 groups §4.4.1 into the static core, so its candidates are part of
    // the same worklist the engines fill — but they are recorded separately, because
    // "the engines found nothing" and "the sweep found nothing" are different
    // statements about a target.
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      runPatchMining: (async (stage: { db: Database; runId: string }) => {
        const candidates = [patchMineCandidate()]
        persistCandidates({ db: stage.db, runId: stage.runId, candidates })
        return patchMineStub({ candidates, patterns: 3 })
      }) as unknown as ScanDeps['runPatchMining'],
    })

    const result = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )

    // One engine candidate from the default stub plus one patch-mined.
    expect(result.counts.candidates).toBe(2)
    expect(result.counts.patchMined).toBe(1)
    expect(result.counts.patchPatterns).toBe(3)

    const staticCore = stageOf(result, 'static-core')
    expect(staticCore.status).toBe('complete')
    expect(staticCore.detail).toContain('1 patch-mined from 3 pattern(s)')
    expect(staticCore.counts.patchMined).toBe(1)
    expect(staticCore.counts.patchPatterns).toBe(3)

    // The candidate is a real row, so a later stage can read it like any other.
    const stored = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM candidates WHERE source = 'patch-mined'`)
      .get()!
    expect(stored.n).toBe(1)
    db.close()
  })

  test('check-to-use candidates join the run, with every producer counted', async () => {
    // §4.4.3 has three producers — the four FSMs, the mined atomicity rules, and the
    // four CWE-364 signal shapes — and they are counted separately because "the FSM
    // fired twice" and "two rules were violated" are different statements about a
    // target. Counting them by subtraction is what the third producer would have
    // broken.
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      runToctou: (async (stage: { db: Database; runId: string }) => {
        const candidates = [toctouCandidate()]
        persistCandidates({ db: stage.db, runId: stage.runId, candidates })
        return toctouStub({
          candidates,
          rules: 2,
          fsmSites: 1,
          atomicitySites: 2,
          signalSites: 1,
          handlers: 2,
        })
      }) as unknown as ScanDeps['runToctou'],
    })

    const result = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )

    // One engine candidate from the default stub plus one check-to-use.
    expect(result.counts.candidates).toBe(2)
    expect(result.counts.toctou).toBe(1)
    expect(result.counts.toctouRules).toBe(2)
    expect(result.counts.toctouFsm).toBe(1)
    expect(result.counts.toctouAtomicity).toBe(2)
    expect(result.counts.toctouSignal).toBe(1)
    expect(result.counts.signalHandlers).toBe(2)

    const staticCore = stageOf(result, 'static-core')
    expect(staticCore.status).toBe('complete')
    expect(staticCore.detail).toContain(
      '1 toctou from 2 rule(s) + 1 fsm site(s) + 0 interprocedural site(s) + 1 signal site(s)',
    )
    expect(staticCore.detail).toContain('over 2 handler(s)')

    const stored = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM candidates WHERE source = 'toctou-fsm'`)
      .get()!
    expect(stored.n).toBe(1)
    db.close()
  })

  test('a check-to-use budget abort stops the static core rather than reporting success', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      runToctou: (async () =>
        toctouStub({ stoppedBy: 'budget-abort', rules: 2 })) as unknown as ScanDeps['runToctou'],
    })

    const result = await runScan(options(db, { deps }))

    expect(result.status).toBe('aborted')
    const staticCore = stageOf(result, 'static-core')
    expect(staticCore.counts.toctouRules).toBe(2)
    expect(staticCore.reason).toContain('aborted check-to-use discovery')
    db.close()
  })

  test('a patch-mine budget abort stops the static core rather than reporting success', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      runPatchMining: (async () =>
        patchMineStub({ stoppedBy: 'budget-abort', patterns: 2 })) as unknown as ScanDeps['runPatchMining'],
    })

    const result = await runScan(options(db, { deps }))

    expect(result.status).toBe('aborted')
    expect(stageOf(result, 'static-core').status).toBe('aborted')
    expect(stageOf(result, 'static-core').reason).toContain('aborted patch-mined discovery')
    db.close()
  })

  test('runs §3.2\u2019s stages in order over a single run', () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps()
    return runScan(
      options(db, {
        deps,
        resolveInvoker: async (): Promise<InvokerOutcome> => ({
          ok: true,
          invoker: triageInvoker(),
        }),
      }),
    ).then((result) => {
      expect(result.status).toBe('complete')
      expect(result.stages.map((record) => record.stage)).toEqual([
        'ingestion',
        'known-vuln',
        'static-core',
        'triage',
        'verification',
        'reporting',
        'library-update',
      ])
      expect(stageOf(result, 'library-update').status).toBe('skipped')
      expect(stageOf(result, 'library-update').reason).toBe(LIBRARY_OPT_IN_SKIP)

      expect(result.counts).toMatchObject({
        filesIndexed: 3,
        symbols: 5,
        callSites: 6,
        candidates: 1,
        triaged: 1,
        confirmed: 1,
        findings: 1,
      })
      expect(result.resumeFrom).toBeNull()
      expect(result.report?.sarifPath).toContain('report.sarif')

      // One run for the whole chain, and the candidate is confirmed in it.
      const runs = db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runs')
        .get()!
      expect(runs.n).toBe(1)

      const candidate = db
        .query<{ state: string; triage: string }, [string]>(
          'SELECT state, triage FROM candidates WHERE run_id = ?',
        )
        .get(result.runId)!
      expect(candidate).toEqual({ state: 'confirmed', triage: 'likely-real' })

      expect(readRunStatus(db, result.runId)).toBe('complete')
      expect(readStages(db, result.runId)).toHaveLength(7)
      db.close()
    })
  })

  test('--static-only never asks for a model transport', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    let resolved = 0
    const result = await runScan(
      options(db, {
        staticOnly: true,
        deps: createScanDeps(),
        resolveInvoker: async () => {
          resolved += 1
          return { ok: false, reason: 'should not be called' }
        },
      }),
    )

    expect(resolved).toBe(0)
    expect(stageOf(result, 'triage').reason).toBe(STATIC_ONLY_SKIP)
    expect(stageOf(result, 'verification').reason).toBe(STATIC_ONLY_SKIP)
    // Reporting is discovery, so §3.2's chain still ends in an artifact.
    expect(stageOf(result, 'reporting').status).toBe('complete')
    // Everything that was asked for ran, so this is not a partial run.
    expect(result.status).toBe('complete')
    expect(result.resumeFrom).toBe('triage')
    db.close()
  })

  test('a missing model environment degrades discovery and says so', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const result = await runScan(
      options(db, {
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: false, reason: 'no credentials found' }),
      }),
    )

    expect(result.status).toBe('partial')
    expect(result.resumeFrom).toBe('triage')
    // The reason names the environment, not the operator's flag: §18 exists so
    // "not checked" is never displayed as "checked and clean".
    expect(stageOf(result, 'triage').reason).toBe('no credentials found')
    expect(stageOf(result, 'triage').reason).not.toBe(STATIC_ONLY_SKIP)
    expect(stageOf(result, 'reporting').status).toBe('complete')
    db.close()
  })

  test('a refused account is reported once, on the result (§18)', async () => {
    // The wall of noise this exists for: with a refused balance every triaged candidate
    // leaves its own `warning:` line, and the one fact they share — that the account is
    // out of credits — is not in any of them. The result carries it once, and the
    // per-candidate lines stay, because each one is a candidate left unexamined.
    const db = scanDatabase()
    seedScanTarget({ db })

    const result = await runScan(
      options(db, {
        deps: createScanDeps(),
        resolveInvoker: async () => ({
          ok: true,
          invoker: createFakeInvoker({
            respond: () =>
              new Error(
                'triage: Out of credits. Please add credits at ' +
                  'https://www.codebuff.com/usage.',
              ),
          }),
        }),
      }),
    )

    expect(result.providerFailure?.kind).toBe('credits')
    expect(result.providerFailure?.detail).toContain('Out of credits')
    expect(result.warnings.some((warning) => warning.includes('triage failed'))).toBe(true)
    // The run is still `partial` for its own reasons, not `failed`: what did not happen is
    // the model stages, and the static ones are real work.
    expect(result.status).toBe('partial')
    db.close()
  })

  test('a run with no credentials at all is the same kind of statement', async () => {
    // A stage that never ran because the environment had no credentials is not a model
    // failure, but it is the same *decision* for a reader: nothing that needed a model
    // happened, and the fix is theirs to make.
    const db = scanDatabase()
    seedScanTarget({ db })

    const result = await runScan(
      options(db, {
        deps: createScanDeps(),
        resolveInvoker: async () => ({
          ok: false,
          reason: 'No Freebuff credentials found. Run `freebuff` to log in.',
        }),
      }),
    )

    expect(result.providerFailure?.kind).toBe('auth')
    db.close()
  })

  test('a scan nothing refused carries no refusal', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const result = await runScan(
      options(db, { deps: createScanDeps(), resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )

    expect(result.providerFailure).toBeNull()
    db.close()
  })

  test('a degraded stage is retried by a later resume', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const first = await runScan(
      options(db, {
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: false, reason: 'no credentials found' }),
      }),
    )

    const second = await runScan(
      options(db, {
        runId: first.runId,
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )

    expect(second.status).toBe('complete')
    expect(stageOf(second, 'triage').status).toBe('complete')
    expect(second.counts.confirmed).toBe(1)
    db.close()
  })

  test('an unresolvable engine fails the scan instead of thinning the net', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      requireEngines: (async () => {
        throw new Error('semgrep is required but was not found on PATH')
      }) as unknown as ScanDeps['requireEngines'],
    })

    const result = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )

    expect(result.status).toBe('failed')
    expect(stageOf(result, 'static-core').status).toBe('failed')
    expect(stageOf(result, 'static-core').reason).toContain('semgrep')
    // Nothing downstream ran: the chain stopped where the net got thinner.
    expect(result.stages.map((record) => record.stage)).toEqual([
      'ingestion',
      'known-vuln',
      'static-core',
    ])
    expect(result.resumeFrom).toBe('static-core')
    expect(readRunStatus(db, result.runId)).toBe('failed')
    db.close()
  })

  test('a budget abort during the static core stops the run as aborted', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const deps = createScanDeps({
      runBaselineEngines: (async () => ({
        executions: [],
        candidates: [engineCandidate()],
        unavailable: [],
        enginesAttempted: 1,
        warnings: ['stopped after semgrep'],
        stoppedBy: 'budget-abort',
      })) as unknown as ScanDeps['runBaselineEngines'],
    })

    const result = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )

    expect(result.status).toBe('aborted')
    expect(stageOf(result, 'static-core').status).toBe('aborted')
    expect(stageOf(result, 'triage')).toBeUndefined()
    // Reported rather than swallowed: the candidates found before the abort are
    // still counted.
    expect(result.counts.candidates).toBe(1)
    db.close()
  })

  test('a resumed run re-runs the failed stage and not the ones behind it', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    let reports = 0
    let osvRuns = 0
    const deps = createScanDeps({
      // OSV unreachable on the first invocation and reachable on the second:
      // `known-vuln` is partial, which is what makes the run resumable even
      // though everything after it ran.
      correlateWithOsv: (async () => {
        osvRuns += 1
        return {
          status: osvRuns === 1 ? 'partial' : 'complete',
          dependencies: [],
          queriedPackages: 0,
          unqueryable: 0,
          packageMatches: [],
          commitMatches: [],
          unsupportedManifests: [],
          failures: osvRuns === 1 ? 1 : 0,
          warnings: osvRuns === 1 ? ['OSV request failed'] : [],
        }
      }) as unknown as ScanDeps['correlateWithOsv'],
      runReport: (async () => {
        reports += 1
        return {
          outDir: '/tmp/out',
          sarifPath: '/tmp/out/report.sarif',
          indexPath: '/tmp/out/report.md',
          findings: [],
          rediscoveries: [],
          excluded: [],
          warnings: [],
          partial: false,
        }
      }) as unknown as ScanDeps['runReport'],
    })

    const first = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )
    expect(first.status).toBe('partial')
    expect(reports).toBe(1)

    const second = await runScan(
      options(db, {
        runId: first.runId,
        deps,
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )

    // Only the partial stage is repeated: the completed stages behind it would
    // have spent budget and re-written their artifacts for no new information.
    expect(osvRuns).toBe(2)
    expect(reports).toBe(1)
    expect(second.stages.map((record) => record.stage)).toEqual([
      'ingestion',
      'known-vuln',
      'static-core',
      'triage',
      'verification',
      'reporting',
      'library-update',
    ])
    expect(stageOf(second, 'reporting').status).toBe('complete')
    expect(second.status).toBe('complete')
    db.close()
  })

  test('a resume with nothing left reports the run’s totals and runs nothing', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const calls = {
      recon: 0,
      osv: 0,
      engines: 0,
      patchMine: 0,
      toctou: 0,
      reach: 0,
      replay: 0,
      report: 0,
    }
    const deps = createScanDeps({}, calls)

    const first = await runScan(
      options(db, { deps, resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }) }),
    )
    expect(first.counts.confirmed).toBe(1)

    const again = await runScan(options(db, { runId: first.runId, deps }))

    expect(calls.engines).toBe(1)
    expect(calls.report).toBe(1)
    expect(again.status).toBe('complete')
    expect(again.resumeFrom).toBeNull()
    expect(again.warnings).toContain('every requested stage was already complete')
    // Totals come from the run’s records, so a no-op resume does not report
    // zeros for work an earlier invocation did.
    expect(again.counts.confirmed).toBe(1)
    expect(again.counts.triaged).toBe(1)
    expect(again.counts.candidates).toBe(1)
    db.close()
  })

  test('a resume inherits the recorded mode when no flag is passed', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const first = await runScan(
      options(db, { staticOnly: true, deps: createScanDeps() }),
    )

    const inherited = await runScan(
      options(db, {
        runId: first.runId,
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )

    expect(stageOf(inherited, 'triage').reason).toBe(STATIC_ONLY_SKIP)
    expect(inherited.status).toBe('complete')
    db.close()
  })

  test('an explicit flag overrides the recorded mode', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const first = await runScan(options(db, { staticOnly: true, deps: createScanDeps() }))

    const widened = await runScan(
      options(db, {
        runId: first.runId,
        staticOnly: false,
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )

    expect(stageOf(widened, 'triage').status).toBe('complete')
    expect(widened.counts.confirmed).toBe(1)
    db.close()
  })

  test('the opt-in library update is attempted only when the flag is present', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const result = await runScan(
      options(db, {
        updateLibrary: true,
        deps: createScanDeps(),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )

    const library = stageOf(result, 'library-update')
    // The synthesis call is answered by the triage fixture, so it fails its
    // schema — which is the point: the stage *ran* rather than being skipped.
    expect(library.reason).not.toBe(LIBRARY_OPT_IN_SKIP)
    expect(library.status).not.toBe('skipped')
    expect(library.counts.considered).toBe(1)
    db.close()
  })

  test('reporting is told what completed rather than reading the unfinalized run', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    const seen: string[] = []
    const withRunStatus = () =>
      createScanDeps({
        runReport: (async (report: { runStatus?: string }) => {
          const status = report.runStatus ?? '(unset)'
          seen.push(status)
          return reportResult({ findings: 1, partial: status !== 'complete' })
        }) as unknown as ScanDeps['runReport'],
      })

    const complete = await runScan(
      options(db, {
        deps: withRunStatus(),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )
    expect(seen).toEqual(['complete'])
    expect(complete.status).toBe('complete')

    // A partial stage upstream must still make the report say so.
    const partial = await runScan(
      options(db, {
        deps: createScanDeps(
          {
            correlateWithOsv: (async () => ({
              status: 'partial',
              dependencies: [],
              queriedPackages: 0,
              unqueryable: 0,
              packageMatches: [],
              commitMatches: [],
              unsupportedManifests: [],
              failures: 1,
              warnings: [],
            })) as unknown as ScanDeps['correlateWithOsv'],
            runReport: (async (report: { runStatus?: string }) => {
              seen.push(report.runStatus ?? '(unset)')
              return reportResult({ findings: 1, partial: report.runStatus !== 'complete' })
            }) as unknown as ScanDeps['runReport'],
          },
        ),
        resolveInvoker: async () => ({ ok: true, invoker: triageInvoker() }),
      }),
    )
    expect(seen).toEqual(['complete', 'partial'])
    expect(partial.status).toBe('partial')
    db.close()
  })

  test('a resumed run belonging to another target is refused', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })
    seedScanTarget({ db, targetId: 'target-2', location: '/tmp/other' })

    const first = await runScan(options(db, { staticOnly: true, deps: createScanDeps() }))

    await expect(
      runScan(options(db, { runId: first.runId, targetId: 'target-2', deps: createScanDeps() })),
    ).rejects.toThrow(/belongs to target/)
    db.close()
  })

  test('a non-positive budget is refused before anything runs', async () => {
    const db = scanDatabase()
    seedScanTarget({ db })

    await expect(
      runScan(options(db, { budgetSeconds: 0, deps: createScanDeps() })),
    ).rejects.toThrow(/Invalid budget/)
    db.close()
  })

  test('the result carries the language coverage the summary prints', async () => {
    // §20.24.5: the number lives on the result, not only in `warnings`, so the
    // `--json` output and the printed summary answer "what was not swept" the same
    // way — and so a caller cannot report the candidate count without it.
    const db = scanDatabase()
    seedScanTarget({ db })

    const seedSymbol = (name: string, language: string): void => {
      db.prepare(
        `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
         VALUES (?, ?, ?, ?, NULL, 'function', 1, 2, ?)`,
      ).run(`s:${name}`, SCAN_TARGET_ID, `src/${name}`, name, language)
    }
    seedSymbol('a', 'c')
    seedSymbol('b', 'python')

    const result = await runScan(options(db, { staticOnly: true, deps: createScanDeps() }))

    expect(result.languageCoverage.sweptCallables).toBe(1)
    expect(result.languageCoverage.unsweptCallables).toBe(1)
    db.close()
  })
})
