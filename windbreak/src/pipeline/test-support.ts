/**
 * Shared fixtures for the pipeline tests.
 *
 * Not imported by any shipping module: the CLI entry never reaches it, so it
 * costs nothing at runtime. It exists so every stage test exercises the same
 * fake invoker and the same state database shape, rather than ten slightly
 * different hand-rolled stubs.
 */

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'

import type { ModelRole } from '../models'
import type {
  ModelIdentity,
  ModelInvoker,
  StructuredOutputSpec,
} from './types'

export interface FakeInvokerCall {
  role: ModelRole
  userPrompt: string
  /** 0-based index of this call among calls for the same role. */
  count: number
}

export interface FakeInvokerOptions {
  /** Overridable identity fields; provider defaults to one per role. */
  identity?: Partial<ModelIdentity>
  /**
   * Return the value the role should answer with, or an `Error` to make the
   * call fail. The returned value is validated against the role's real schema,
   * so a malformed fixture exercises the parse-failure path for real.
   */
  respond: (call: FakeInvokerCall) => unknown | Error
}

export interface FakeInvoker extends ModelInvoker {
  readonly calls: FakeInvokerCall[]
}

export const createFakeInvoker = (options: FakeInvokerOptions): FakeInvoker => {
  const calls: FakeInvokerCall[] = []
  const counts = new Map<ModelRole, number>()

  const identityFor = (role: ModelRole): ModelIdentity => ({
    modelId: `${role}-model`,
    provider: `vendor-${role}`,
    temperature: 0,
    seed: 42,
    seedSupported: false,
    ...options.identity,
  })

  return {
    calls,
    identity: identityFor,

    async invoke<T>(
      request: { role: ModelRole; userPrompt: string },
      output: StructuredOutputSpec<T>,
    ) {
      const count = counts.get(request.role) ?? 0
      counts.set(request.role, count + 1)

      const call: FakeInvokerCall = { role: request.role, userPrompt: request.userPrompt, count }
      calls.push(call)

      const value = options.respond(call)
      const identity = identityFor(request.role)

      if (value instanceof Error) {
        return { ...identity, ok: false as const, error: value.message }
      }

      const parsed = output.schema.safeParse(value)
      if (!parsed.success) {
        return {
          ...identity,
          ok: false as const,
          error: `fixture did not match ${output.name}`,
        }
      }

      return { ...identity, ok: true as const, value: parsed.data }
    },
  }
}

export const SAMPLE_SNIPPET = [
  '#include <string.h>',
  'void copy(char *src) {',
  '  char buf[32];',
  '  strcpy(buf, src);',
  '}',
].join('\n')

export const candidateNormalized = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy',
    level: 'error',
    filePath: 'src/a.c',
    startLine: 4,
    endLine: 4,
    snippet: SAMPLE_SNIPPET,
    sliceHash: 'deadbeef',
    precision: null,
    ...overrides,
  })

export interface SeededState {
  db: Database
  targetId: string
  runId: string
  candidateIds: string[]
}

/**
 * A state database with one target, one run, and the given candidates, wired the
 * way the engines stage leaves it.
 */
export const seedState = (input: {
  /** The revision the seeded run records. Defaults to `abc123`. */
  commitSha?: string
  /** The seeded run's status. Defaults to `complete`. */
  runStatus?: string
  /** The seeded run's `config_json`, verbatim. */
  configJson?: string
  candidates?: Array<{
    id?: string
    filePath?: string
    startLine?: number
    cwe?: string | null
    snippet?: string
    source?: string
    patternId?: string
    /** §5.3 state. Defaults to `new`. */
    state?: string
    /** §4.6 label. Defaults to NULL, i.e. triage never produced one. */
    triage?: string | null
    /**
     * Queue this candidate in `adjudication_queue`, which is what tells §11's
     * post-adjudication row that the human stage existed.
     */
    adjudicated?: 'real' | 'benign' | null
  }>
  /** Rows written into `osv_matches` for the rediscovery check. */
  knownVulns?: Array<{
    vulnId: string
    aliases?: string[]
    summary?: string | null
    details?: string | null
  }>
  /** Rows written into the symbol index, for enrichment and rediscovery. */
  symbols?: Array<{
    filePath: string
    name: string
    startLine: number
    endLine: number
    /**
     * Symbol kind, defaulting to `function`. The C-shaped sweeps are pinned to
     * the languages they have tables for, so a test that wants to prove a
     * Python callable is *skipped* rather than swept needs both.
     */
    kind?: string
    language?: string
  }>
  symbolRefs?: Array<{ filePath: string; name: string; line: number }>
  fileLanguages?: Array<{ path: string; language: string }>
} = {}): SeededState => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)

  const targetId = 'target-1'
  const runId = 'run-1'

  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    targetId,
    '/tmp/target',
  )
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, targetId, input.configJson ?? '{}', input.commitSha ?? 'abc123', input.runStatus ?? 'complete')

  const candidateIds: string[] = []
  const insertCandidate = db.prepare(
    `INSERT INTO candidates
       (id, run_id, source, pattern_id, origin_patch_sha, file_path, start_line, end_line,
        cwe, normalized_json, injection_signals_json, state, osv_match_json, triage)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
  )

  const seeded: Array<{ id: string; adjudicated: 'real' | 'benign' | null | undefined }> = []

  for (const candidate of input.candidates ?? [{}]) {
    const id = candidate.id ?? `cand-${candidateIds.length + 1}`
    candidateIds.push(id)
    seeded.push({ id, adjudicated: candidate.adjudicated })
    insertCandidate.run(
      id,
      runId,
      candidate.source ?? 'semgrep',
      candidate.patternId ?? 'wb-c-unbounded-string-op',
      candidate.filePath ?? 'src/a.c',
      candidate.startLine ?? 4,
      candidate.startLine ?? 4,
      candidate.cwe === undefined ? 'CWE-120' : candidate.cwe,
      candidateNormalized({
        ...(candidate.snippet ? { snippet: candidate.snippet } : {}),
        ...(candidate.filePath ? { filePath: candidate.filePath } : {}),
      }),
      candidate.state ?? 'new',
      candidate.triage ?? null,
    )
  }

  // The queue row is the only evidence that §5.3 ran for a candidate, so a
  // candidate that was escalated and then decided needs both the state *and*
  // this row; `adjudicated: undefined` means it was never queued.
  const insertAdjudication = db.prepare(
    `INSERT INTO adjudication_queue
       (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id, decision, decided_at, rationale)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  )
  for (const entry of seeded) {
    if (entry.adjudicated === undefined) continue
    insertAdjudication.run(
      entry.id,
      runId,
      `${entry.id}-proposer`,
      `${entry.id}-refuter`,
      entry.adjudicated,
      entry.adjudicated === null ? null : '2026-01-01T00:00:00Z',
    )
  }

  const insertSymbol = db.prepare(
    `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  )
  for (const symbol of input.symbols ?? []) {
    const kind = symbol.kind ?? 'function'
    insertSymbol.run(
      `${targetId}:${symbol.filePath}:${kind}:${symbol.name}:${symbol.startLine}`,
      targetId,
      symbol.filePath,
      symbol.name,
      kind,
      symbol.startLine,
      symbol.endLine,
      symbol.language ?? 'c',
    )
  }

  const insertRef = db.prepare(
    `INSERT INTO symbol_refs (id, target_id, file_path, name, kind, line, language)
     VALUES (?, ?, ?, ?, 'call', ?, 'c')`,
  )
  for (const ref of input.symbolRefs ?? []) {
    insertRef.run(
      `${targetId}:${ref.filePath}:${ref.line}:${ref.name}`,
      targetId,
      ref.filePath,
      ref.name,
      ref.line,
    )
  }

  const insertFile = db.prepare(
    `INSERT INTO recon_files (target_id, path, language, bytes, binary) VALUES (?, ?, ?, 10, 0)`,
  )
  for (const file of input.fileLanguages ?? []) {
    insertFile.run(targetId, file.path, file.language)
  }

  const insertVuln = db.prepare(
    `INSERT INTO osv_matches
       (id, target_id, source, vuln_id, summary, published, modified, aliases_json, severity_json, raw_json, fetched_at)
     VALUES (?, ?, 'commit', ?, ?, NULL, NULL, ?, NULL, ?, '2026-01-01T00:00:00Z')`,
  )
  for (const vuln of input.knownVulns ?? []) {
    insertVuln.run(
      `${targetId}:${vuln.vulnId}`,
      targetId,
      vuln.vulnId,
      vuln.summary ?? null,
      JSON.stringify(vuln.aliases ?? []),
      JSON.stringify({ id: vuln.vulnId, details: vuln.details ?? null }),
    )
  }

  return { db, targetId, runId, candidateIds }
}

export const candidateState = (db: Database, candidateId: string): string =>
  db
    .query<{ state: string }, [string]>('SELECT state FROM candidates WHERE id = ?')
    .get(candidateId)?.state ?? '(missing)'

export const candidateTriage = (db: Database, candidateId: string): string | null =>
  db
    .query<{ triage: string | null }, [string]>(
      'SELECT triage FROM candidates WHERE id = ?',
    )
    .get(candidateId)?.triage ?? null

export const verdictCount = (db: Database, candidateId: string): number =>
  db
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM verdicts WHERE candidate_id = ?',
    )
    .get(candidateId)?.n ?? 0
