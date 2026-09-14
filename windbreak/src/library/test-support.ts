/**
 * Shared fixtures for the pattern-library tests.
 *
 * Every test here needs the same awkward thing: *two* targets with program
 * models in one database, because that is what cross-target replay means. The
 * helper builds both, plus the candidates and `findings` rows the confirmation
 * gate reads, so a test can state only the part it is actually about.
 */

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'

export interface SeedFunction {
  filePath: string
  name: string
  startLine: number
  endLine: number
}

export interface SeedRef {
  filePath: string
  name: string
  line: number
}

export interface SeedTarget {
  id: string
  location?: string
  commitSha?: string | null
  /** Language recorded for every file, unless `files` overrides it. */
  language?: string
  files?: Array<{ path: string; language: string }>
  functions?: SeedFunction[]
  refs?: SeedRef[]
}

export interface SeedCandidate {
  id: string
  targetId: string
  runId?: string
  state?: string
  filePath?: string
  startLine?: number
  cwe?: string | null
  patternId?: string
  source?: string
  normalizedJson?: string
}

export interface SeedFinding {
  candidateId: string
  evidenceTier: string
  id?: string
}

export interface SeedLibraryInput {
  targets?: SeedTarget[]
  candidates?: SeedCandidate[]
  findings?: SeedFinding[]
}

export interface SeededLibraryState {
  db: Database
  targetIds: string[]
  runIds: string[]
}

export const defaultNormalized = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    engine: 'semgrep',
    ruleId: 'wb-c-unbounded-string-op',
    message: 'unbounded copy',
    level: 'error',
    filePath: 'src/handler.c',
    startLine: 5,
    endLine: 5,
    snippet: '  strcpy(name, line);',
    sliceHash: 'deadbeef',
    precision: null,
    ...overrides,
  })

/** A pair of targets whose sources model the classic pre-fix / post-fix shape. */
export const seedLibraryState = (input: SeedLibraryInput = {}): SeededLibraryState => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)

  const targetIds: string[] = []
  const runIds: string[] = []

  for (const target of input.targets ?? []) {
    targetIds.push(target.id)

    db.prepare(
      `INSERT INTO targets (id, location, commit_sha, languages_json, build_model, scope_class, created_at)
       VALUES (?, ?, ?, '[]', 'best-effort', 'userspace-c', '2026-01-01T00:00:00Z')`,
    ).run(target.id, target.location ?? `/tmp/${target.id}`, target.commitSha ?? 'abc123')

    const runId = `run_${target.id}`
    runIds.push(runId)
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES (?, ?, '{}', ?, 'complete')`,
    ).run(runId, target.id, target.commitSha ?? 'abc123')

    const files =
      target.files ??
      [...new Set(target.refs?.map((ref) => ref.filePath) ?? [])].map((filePath) => ({
        path: filePath,
        language: target.language ?? 'c',
      }))

    const insertFile = db.prepare(
      `INSERT OR REPLACE INTO recon_files (target_id, path, language, bytes, binary)
       VALUES (?, ?, ?, 10, 0)`,
    )
    for (const file of files) insertFile.run(target.id, file.path, file.language)

    const insertSymbol = db.prepare(
      `INSERT OR REPLACE INTO symbols
         (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
       VALUES (?, ?, ?, ?, NULL, 'function', ?, ?, ?)`,
    )
    for (const fn of target.functions ?? []) {
      insertSymbol.run(
        `${target.id}:${fn.filePath}:function:${fn.name}:${fn.startLine}`,
        target.id,
        fn.filePath,
        fn.name,
        fn.startLine,
        fn.endLine,
        target.language ?? 'c',
      )
    }

    const insertRef = db.prepare(
      `INSERT OR REPLACE INTO symbol_refs (id, target_id, file_path, name, kind, line, language)
       VALUES (?, ?, ?, ?, 'call', ?, ?)`,
    )
    for (const ref of target.refs ?? []) {
      insertRef.run(
        `${target.id}:${ref.filePath}:${ref.line}:${ref.name}`,
        target.id,
        ref.filePath,
        ref.name,
        ref.line,
        target.language ?? 'c',
      )
    }
  }

  const insertCandidate = db.prepare(
    `INSERT OR REPLACE INTO candidates
       (id, run_id, source, pattern_id, origin_patch_sha, file_path, start_line, end_line,
        cwe, normalized_json, injection_signals_json, state, osv_match_json, triage)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)`,
  )

  for (const candidate of input.candidates ?? []) {
    insertCandidate.run(
      candidate.id,
      candidate.runId ?? `run_${candidate.targetId}`,
      candidate.source ?? 'semgrep',
      candidate.patternId ?? 'wb-c-unbounded-string-op',
      candidate.filePath ?? 'src/handler.c',
      candidate.startLine ?? 5,
      candidate.startLine ?? 5,
      candidate.cwe === undefined ? 'CWE-120' : candidate.cwe,
      candidate.normalizedJson ?? defaultNormalized(),
      candidate.state ?? 'confirmed',
    )
  }

  const insertFinding = db.prepare(
    `INSERT OR REPLACE INTO findings (id, candidate_id, evidence_tier, sarif_path, writeup_path, created_at)
     VALUES (?, ?, ?, NULL, NULL, '2026-01-01T00:00:00Z')`,
  )
  for (const finding of input.findings ?? []) {
    insertFinding.run(
      finding.id ?? `find_${finding.candidateId}`,
      finding.candidateId,
      finding.evidenceTier,
    )
  }

  return { db, targetIds, runIds }
}

/**
 * The canonical set: target A contains the confirmed defect, target B is a
 * different codebase carrying the same idiom, and target C is B *after* the
 * fix — which is what makes a post-image check testable. `withVariants` adds a
 * target that copied the same bug three times, for the candidate cap.
 */
export const seedReplayTargets = (
  options: { withFindings?: boolean; withVariants?: boolean } = {},
): SeededLibraryState => {
  const state = seedLibraryState({
    targets: [
      {
        id: 'target-a',
        commitSha: 'aaaaaaaa',
        functions: [{ filePath: 'src/handler.c', name: 'parse_header', startLine: 3, endLine: 7 }],
        refs: [
          { filePath: 'src/handler.c', name: 'strcpy', line: 5 },
          { filePath: 'src/handler.c', name: 'strlen', line: 6 },
        ],
      },
      {
        id: 'target-b',
        commitSha: 'bbbbbbbb',
        functions: [
          { filePath: 'src/parse.c', name: 'read_name', startLine: 10, endLine: 14 },
          { filePath: 'src/parse.c', name: 'safe_copy', startLine: 20, endLine: 24 },
        ],
        refs: [
          { filePath: 'src/parse.c', name: 'strcpy', line: 12 },
          { filePath: 'src/parse.c', name: 'strlen', line: 13 },
          // Already handled: the bounded variant is present, so a fingerprint
          // that forbids `strncpy` must not match here.
          { filePath: 'src/parse.c', name: 'strncpy', line: 22 },
          { filePath: 'src/parse.c', name: 'snprintf', line: 23 },
        ],
      },
      {
        id: 'target-c',
        commitSha: 'cccccccc',
        functions: [{ filePath: 'src/parse.c', name: 'read_name', startLine: 10, endLine: 14 }],
        refs: [
          { filePath: 'src/parse.c', name: 'strncpy', line: 12 },
          { filePath: 'src/parse.c', name: 'strlen', line: 13 },
        ],
      },
      ...(options.withVariants
        ? [
            {
              id: 'target-d',
              commitSha: 'dddddddd',
              functions: [
                { filePath: 'src/copies.c', name: 'copy_a', startLine: 1, endLine: 4 },
                { filePath: 'src/copies.c', name: 'copy_b', startLine: 6, endLine: 9 },
                { filePath: 'src/copies.c', name: 'copy_c', startLine: 11, endLine: 14 },
              ],
              refs: [
                { filePath: 'src/copies.c', name: 'strcpy', line: 2 },
                { filePath: 'src/copies.c', name: 'strcpy', line: 7 },
                { filePath: 'src/copies.c', name: 'strcpy', line: 12 },
              ],
            },
          ]
        : []),
    ],
    candidates: [
      {
        id: 'cand-a1',
        targetId: 'target-a',
        state: 'confirmed',
        filePath: 'src/handler.c',
        startLine: 5,
      },
    ],
    findings:
      options.withFindings === false
        ? []
        : [{ candidateId: 'cand-a1', evidenceTier: 'human-reproduced' }],
  })

  return state
}

/** The fingerprint the tests use: `strcpy` present, bounded alternatives absent. */
export const unboundedCopyFingerprint = {
  kind: 'function-shape' as const,
  scope: 'function' as const,
  cwe: 'CWE-120',
  summary: 'unbounded copy into a fixed-size buffer',
  languages: ['c'],
  requireCalls: ['strcpy'],
  requireAnyCalls: [],
  forbidCalls: ['strncpy', 'snprintf', 'strlcpy'],
  order: [],
}
