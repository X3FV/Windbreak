/**
 * Shared fixtures for the `scan` orchestrator tests.
 *
 * The orchestrator's job is control flow, so its tests are written against a
 * *real* state database and the real pipeline stages, with a fake invoker, and
 * only the environment-touching stage entry points replaced. That is deliberate:
 * the questions worth asking here — which stage runs, what a refusal does to the
 * rest, where a resume picks up, what the metrics say — are all about the
 * interaction between stages, which a fully stubbed scan could not answer.
 */

import { Database } from 'bun:sqlite'

import { persistCandidates } from '../engines'
import { applySchema } from '../state/db'

import type { Candidate } from '../engines'
import type { ScanDeps } from './run'

export const SCAN_TARGET_ID = 'target-1'
export const SCAN_TARGET_ROOT = '/tmp/windbreak-scan-target'

/** The target row a scan needs, since `runs.target_id` is a foreign key. */
export const seedScanTarget = (input: {
  db: Database
  targetId?: string
  location?: string
}): string => {
  const targetId = input.targetId ?? SCAN_TARGET_ID
  input.db
    .prepare(
      `INSERT OR REPLACE INTO targets (id, location, commit_sha, languages_json, build_model, scope_class)
       VALUES (?, ?, 'abc123', '[]', 'best-effort', 'userspace-c')`,
    )
    .run(targetId, input.location ?? SCAN_TARGET_ROOT)
  return targetId
}

export const scanDatabase = (): Database => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  return db
}

/** A candidate shaped the way the engines stage produces one. */
export const engineCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'cand-engine-1',
  source: 'semgrep',
  patternId: 'wb-c-unbounded-string-op',
  originPatchSha: null,
  filePath: 'src/a.c',
  startLine: 4,
  endLine: 4,
  cwe: 'CWE-120',
  state: 'new',
  normalized: {
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy',
    level: 'error',
    filePath: 'src/a.c',
    startLine: 4,
    endLine: 4,
    snippet: '  strcpy(buf, src);',
    sliceHash: 'deadbeef',
    precision: null,
  },
  injectionSignals: [],
  ...overrides,
})

/**
 * A candidate shaped the way §4.4.1's miner produces one.
 *
 * It differs from an engine candidate in the two fields the §4.5 schema exists to
 * carry: the `patch-mined` source, and the originating patch SHA that lets a
 * candidate be traced back to the fix whose shape it came from.
 */
export const patchMineCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'cand-patch-mined-1',
  source: 'patch-mined',
  patternId: 'pm_0000000000000000',
  originPatchSha: 'f'.repeat(40),
  filePath: 'src/b.c',
  startLine: 9,
  endLine: 9,
  cwe: null,
  state: 'new',
  normalized: {
    engine: 'patch-mined',
    ruleId: 'pm_0000000000000000',
    message: '`dst` is used by `strcpy` with no null test',
    level: 'warning',
    filePath: 'src/b.c',
    startLine: 9,
    endLine: 9,
    snippet: '  strcpy(dst, src);',
    sliceHash: 'cafebabe',
    precision: null,
  },
  injectionSignals: [],
  ...overrides,
})

/**
 * A §4.4.3 candidate, so a scan test can check that its candidates join the run's
 * worklist and that its two producers are counted separately.
 *
 * `originPatchSha` is null on purpose: an FSM finding has no originating patch, and
 * only an *atomicity* violation traces to one. Setting it here would make the
 * fixture unable to catch a stage that attached the field to both kinds.
 */
export const toctouCandidate = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'cand-toctou-1',
  source: 'toctou-fsm',
  patternId: 'toctou:path-check-then-use',
  originPatchSha: null,
  filePath: 'src/c.c',
  startLine: 12,
  endLine: 12,
  cwe: null,
  state: 'new',
  normalized: {
    engine: 'toctou-fsm',
    ruleId: 'toctou:path-check-then-use',
    message: 'Check-to-use ordering (path-check-then-use) — `access(path)` is checked at line 11',
    level: 'warning',
    filePath: 'src/c.c',
    startLine: 12,
    endLine: 12,
    snippet: '  return open(path, O_RDONLY);',
    sliceHash: 'deadc0de',
    precision: null,
  },
  injectionSignals: [],
  ...overrides,
})

const reconStub = (input: { fileCount: number; symbols: number; references: number }) =>
  ({
    target: { id: SCAN_TARGET_ID, location: SCAN_TARGET_ROOT },
    inventory: {
      fileCount: input.fileCount,
      totalBytes: 1024,
      truncated: false,
      ignoredDirectories: 0,
    },
    languages: [],
    dependencyManifests: [],
    git: { commit: 'abc123', branch: 'main', dirty: false },
    build: { model: 'best-effort', compiledCommands: 0, status: 'complete' },
    programModel: { symbols: input.symbols, references: input.references, files: [] },
    warnings: [],
  }) as never

const osvStub = () => ({
  status: 'complete' as const,
  dependencies: [],
  queriedPackages: 0,
  unqueryable: 0,
  packageMatches: [],
  commitMatches: [],
  unsupportedManifests: [],
  failures: 0,
  warnings: [],
})

const enginesStub = (input: { candidates: Candidate[]; stoppedBy?: 'budget-abort' | null }) => ({
  executions: [],
  candidates: input.candidates,
  unavailable: [],
  enginesAttempted: input.candidates.length > 0 ? 1 : 0,
  warnings: [],
  stoppedBy: input.stoppedBy ?? null,
})

const replayStub = () => ({
  candidates: [] as Candidate[],
  checkersConsidered: 0,
  outcomes: [],
  warnings: [],
})

/**
 * §4.4.1's miner, empty by default.
 *
 * The default is empty, and that is the honest default rather than a convenience:
 * a real mining result needs a git history and a program model, so a test that
 * wants patch-mined candidates overrides `runPatchMining` with a function that
 * persists them — the same shape `runBaselineEngines` uses, and for the same
 * reason (the stage is the thing that knows the run id).
 */
export const patchMineStub = (
  input: {
    candidates?: Candidate[]
    patterns?: number
    stoppedBy?: 'budget-abort' | 'budget-degrade' | null
    warnings?: string[]
  } = {},
) =>
  ({
    patterns: Array.from({ length: input.patterns ?? 0 }, (_, index) => ({
      id: `pm_stub_${index}`,
      shape: 'null-check' as const,
      originPatchSha: 'a'.repeat(40),
      originFile: 'src/a.c',
      originSubject: 'fix: guard a copy',
      subject: 'dst',
      operation: 'strcpy',
      description: '`dst` was used without a null test',
      validation: { preImageFlagged: true, postImageFlagged: false, accepted: true },
      occurrences: 1,
    })),
    rejected: [],
    sites: [],
    commitsConsidered: 0,
    coverage: { commitsRead: 0, commitsWithPatches: 0, hunksExamined: 0, hunksUnrecognised: 0 },
    warnings: input.warnings ?? [],
    stoppedBy: input.stoppedBy ?? null,
    candidates: input.candidates ?? [],
    persisted: input.candidates?.length ?? 0,
  }) as never

/**
 * A §4.4.3 result with nothing in it, or with the counts and sites a test asks for.
 *
 * `rules` is populated rather than always empty so a test can assert that a mined
 * rule reaches the stage record even when it produced no candidate — the difference
 * between "nothing was mined" and "a rule was mined and nothing violated it".
 */
export const toctouStub = (
  input: {
    candidates?: Candidate[]
    rules?: number
    fsmSites?: number
    atomicitySites?: number
    signalSites?: number
    /** Function(s) the handler pre-pass identified; reported by the stage record. */
    handlers?: number
    stoppedBy?: 'budget-abort' | 'budget-degrade' | null
    warnings?: string[]
  } = {},
) => {
  const rules = Array.from({ length: input.rules ?? 0 }, (_, index) => ({
    id: `ar_stub_${index}`,
    resource: `s->field${index}`,
    lock: 's->mu',
    originPatchSha: 'a'.repeat(40),
    originFile: 'src/a.c',
    occurrences: 1,
  }))

  const sites = [
    ...Array.from({ length: input.fsmSites ?? 0 }, (_, index) => ({
      kind: 'fsm' as const,
      fsm: 'path-check-then-use' as const,
      ruleId: null,
      filePath: 'src/a.c',
      functionName: `load${index}`,
      startLine: 1,
      endLine: 4,
      matchLine: 3,
      checkLine: 2,
      resource: 'path',
      lock: null,
      evidence: '`access(path)` is checked at line 2 and `open` re-resolves it at line 3',
    })),
    ...Array.from({ length: input.atomicitySites ?? 0 }, (_, index) => ({
      kind: 'atomicity' as const,
      fsm: null,
      ruleId: `ar_stub_${index}`,
      filePath: 'src/b.c',
      functionName: `read_count${index}`,
      startLine: 1,
      endLine: 3,
      matchLine: 2,
      checkLine: null,
      resource: `s->field${index}`,
      lock: 's->mu',
      evidence: '`s->field0` is accessed at line 2 with `s->mu` never held in this function',
    })),
    ...Array.from({ length: input.signalSites ?? 0 }, (_, index) => ({
      kind: 'signal' as const,
      fsm: null,
      ruleId: null,
      shape: 'unsafe-call' as const,
      signals: ['SIGINT'],
      filePath: 'src/c.c',
      functionName: `on_int${index}`,
      startLine: 1,
      endLine: 3,
      matchLine: 2,
      checkLine: null,
      resource: 'syslog',
      lock: null,
      evidence: '`syslog` is called at line 2 in a signal handler registered for `SIGINT`',
    })),
  ]

  return {
    rules,
    sites,
    outcomes: [],
    coverage: {
      commitsRead: 0,
      hunksAddingLock: 0,
      hunksWithoutResource: 0,
      functionsSwept: 0,
      functionsWithEvents: 0,
      signalHandlers: input.handlers ?? 0,
      sharedKeys: 0,
    },
    fixesConsidered: 0,
    warnings: input.warnings ?? [],
    stoppedBy: input.stoppedBy ?? null,
    candidates: input.candidates ?? [],
    persisted: input.candidates?.length ?? 0,
  } as never
}

export const reportResult = (input: { findings?: number; partial?: boolean } = {}) => ({
  outDir: '/tmp/windbreak-scan-report',
  sarifPath: '/tmp/windbreak-scan-report/report.sarif',
  indexPath: '/tmp/windbreak-scan-report/report.md',
  findings: Array.from({ length: input.findings ?? 0 }, (_, index) => ({
    candidateId: `cand-${index + 1}`,
    findingId: `find_${index + 1}`,
    title: 't',
    tier: 'statically-verified',
    writeupPath: '/tmp/x.md',
  })),
  rediscoveries: [],
  excluded: [],
  warnings: [],
  partial: input.partial ?? false,
}) as never

/** How often each stub was entered, which is how a test asks "was this run again?". */
export interface ScanDepCalls {
  recon: number
  osv: number
  engines: number
  patchMine: number
  toctou: number
  replay: number
  report: number
}

/**
 * Environment-touching stage stubs. Every one is replaceable per test, and the
 * defaults are a scan that finds one candidate and confirms it.
 */
export const createScanDeps = (
  overrides: Partial<ScanDeps> = {},
  calls: ScanDepCalls = {
    recon: 0,
    osv: 0,
    engines: 0,
    patchMine: 0,
    toctou: 0,
    replay: 0,
    report: 0,
  },
): ScanDeps => ({
  runRecon: (async () => {
    calls.recon += 1
    return reconStub({ fileCount: 3, symbols: 5, references: 6 })
  }) as unknown as ScanDeps['runRecon'],
  correlateWithOsv: (async () => {
    calls.osv += 1
    return osvStub()
  }) as unknown as ScanDeps['correlateWithOsv'],
  requireEngines: (async () => ({ resolved: [], unavailable: [] })) as unknown as ScanDeps['requireEngines'],
  // The real stage persists its own candidates (it is the thing that knows the
  // run id), so the stub has to as well or triage would have nothing to read.
  runBaselineEngines: (async (stage: { db: Database; runId: string }) => {
    calls.engines += 1
    const candidates = [engineCandidate()]
    persistCandidates({ db: stage.db, runId: stage.runId, candidates })
    return enginesStub({ candidates })
  }) as unknown as ScanDeps['runBaselineEngines'],
  // §4.4.1's miner finds nothing by default: it needs a real git history and a
  // program model, so a scan test that wants patch-mined candidates overrides
  // this rather than getting fabricated ones from a stub.
  runPatchMining: (async () => {
    calls.patchMine += 1
    return patchMineStub()
  }) as unknown as ScanDeps['runPatchMining'],
  // §4.4.3's stage: it needs a git history and a program model, so by default it
  // mines no rules and reports no sites. A test that wants check-to-use candidates
  // overrides it with a function that persists them.
  runToctou: (async () => {
    calls.toctou += 1
    return toctouStub()
  }) as unknown as ScanDeps['runToctou'],
  runVariantHunt: (() => {
    calls.replay += 1
    return replayStub()
  }) as unknown as ScanDeps['runVariantHunt'],
  runReport: (async () => {
    calls.report += 1
    return reportResult({ findings: 1 })
  }) as unknown as ScanDeps['runReport'],
  ...overrides,
})

export const readStages = (db: Database, runId: string): Array<{ stage: string; status: string }> => {
  const row = db
    .query<{ stage_json: string }, [string]>(
      'SELECT stage_json FROM run_metrics WHERE run_id = ?',
    )
    .get(runId)
  if (!row) return []
  return JSON.parse(row.stage_json) as Array<{ stage: string; status: string }>
}

export const readRunStatus = (db: Database, runId: string): string | null =>
  db
    .query<{ status: string }, [string]>('SELECT status FROM runs WHERE id = ?')
    .get(runId)?.status ?? null
