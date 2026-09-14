import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { applySchema, openStateDatabase } from '../state/db'
import { createProgramContext } from './program-context'
import { readCandidatesForTriage } from './persist'
import { runPipeline } from './run'
import { createFakeInvoker, candidateNormalized } from './test-support'

import type { Database } from 'bun:sqlite'
import type { ModelInvoker } from './types'

/**
 * §2.1.3 is an MVP gate: re-running the same target with the same config must
 * reproduce identical stage outputs **from cache**. This runs the real pipeline
 * against a real on-disk database twice and asserts the second run is a pure
 * replay.
 *
 * The model itself is the one scripted seam (a live provider call needs the
 * codebuff client environment and a network round trip, neither of which belongs
 * in a test). Everything else — SQLite schema, WAL, the symbol index, the
 * evidence renderer, the §8.4 cache, the §9 governor, the §5.3 disposition
 * matrix — is the shipping code path.
 *
 * The cache key deliberately excludes the run id and candidate id, so a second
 * *scan* of the same target (a new run row, new candidate rows) is what this
 * test models: identical evidence in, identical verdicts out, no model calls.
 */

let tmpDir: string | null = null
let db: Database | null = null

afterEach(() => {
  db?.close()
  db = null
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = null
})

const SOURCE = [
  '#include <string.h>',
  'void copy(char *src) {',
  '  char buf[32];',
  '  strcpy(buf, src);',
  '}',
].join('\n')

const seedRun = (input: {
  database: Database
  targetId: string
  runId: string
  candidates: Array<{ id: string; filePath: string }>
}): void => {
  input.database
    .prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES (?, ?, '{}', 'abc123', 'running')`,
    )
    .run(input.runId, input.targetId)

  const insert = input.database.prepare(
    `INSERT INTO candidates
       (id, run_id, source, pattern_id, origin_patch_sha, file_path, start_line, end_line,
        cwe, normalized_json, injection_signals_json, state, osv_match_json, triage)
     VALUES (?, ?, 'semgrep', 'wb-c-unbounded-string-op', NULL, ?, 4, 4,
             'CWE-120', ?, NULL, 'new', NULL, NULL)`,
  )

  for (const candidate of input.candidates) {
    insert.run(
      candidate.id,
      input.runId,
      candidate.filePath,
      candidateNormalized({ filePath: candidate.filePath }),
    )
  }
}

const runOnce = async (input: {
  database: Database
  targetId: string
  runId: string
  invoker: ModelInvoker
}) =>
  runPipeline({
    db: input.database,
    runId: input.runId,
    targetId: input.targetId,
    candidates: readCandidatesForTriage(input.database, input.runId),
    invoker: input.invoker,
    programContext: createProgramContext(input.database, input.targetId),
    log: () => {},
  })

const verdictsFor = (
  database: Database,
  runId: string,
): Array<{ role: string; output_json: string }> =>
  database
    .query<{ role: string; output_json: string }, [string]>(
      `SELECT v.role, v.output_json FROM verdicts v
         JOIN candidates c ON c.id = v.candidate_id
        WHERE c.run_id = ? ORDER BY v.role`,
    )
    .all(runId)

describe('pipeline determinism across runs (§2.1.3)', () => {
  test('a second scan of the same target replays every verdict from cache', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-pipe-'))
    const databasePath = path.join(tmpDir, 'state.db')

    // First scan.
    const first = openStateDatabase(databasePath)
    db = first
    applySchema(first)
    first
      .prepare('INSERT INTO targets (id, location, commit_sha) VALUES (?, ?, ?)')
      .run('target-1', tmpDir, 'abc123')
    seedRun({
      database: first,
      targetId: 'target-1',
      runId: 'run-1',
      candidates: [
        { id: 'cand-1', filePath: 'src/a.c' },
        { id: 'cand-2', filePath: 'src/b.c' },
      ],
    })

    const scripted = createFakeInvoker({
      respond: (call) => {
        if (call.role === 'triage') {
          return call.count === 0
            ? { label: 'likely-real', rationale: 'first candidate looks real' }
            : { label: 'likely-noise', rationale: 'second is a false positive' }
        }
        return {
          verdict: 'real',
          reasoning: `${call.role} reasoning`,
          preconditions: ['attacker controls src'],
        }
      },
    })

    const firstResult = await runOnce({
      database: first,
      targetId: 'target-1',
      runId: 'run-1',
      invoker: scripted,
    })

    expect(firstResult.triage.cached).toBe(0)
    expect(firstResult.verification.cached).toBe(0)
    // 2 triage calls, plus a proposer/refuter pair for the one likely-real one.
    expect(scripted.calls).toHaveLength(4)

    const firstVerdicts = verdictsFor(first, 'run-1')
    expect(firstVerdicts).toHaveLength(4)

    // Second scan of the same target: new run row, new candidate rows, identical
    // evidence.
    seedRun({
      database: first,
      targetId: 'target-1',
      runId: 'run-2',
      candidates: [
        { id: 'cand-3', filePath: 'src/a.c' },
        { id: 'cand-4', filePath: 'src/b.c' },
      ],
    })

    const throwingInvoker = createFakeInvoker({
      respond: () => new Error('the cache should have answered this'),
    })

    const secondResult = await runOnce({
      database: first,
      targetId: 'target-1',
      runId: 'run-2',
      invoker: throwingInvoker,
    })

    expect(throwingInvoker.calls).toHaveLength(0)
    expect(secondResult.triage.cached).toBe(2)
    expect(secondResult.verification.cached).toBe(2)
    expect(secondResult.triage.failed).toBe(0)
    expect(secondResult.verification.failed).toBe(0)

    // Both runs reached the same disposition, and the recorded outputs are
    // byte-identical.
    const secondVerdicts = verdictsFor(first, 'run-2')
    expect(secondVerdicts.map((v) => v.output_json)).toEqual(
      firstVerdicts.map((v) => v.output_json),
    )

    const stateOf = (runId: string) =>
      first
        .query<{ state: string }, [string]>(
          `SELECT state FROM candidates WHERE run_id = ? ORDER BY id`,
        )
        .all(runId)
        .map((row) => row.state)

    expect(stateOf('run-2')).toEqual(stateOf('run-1'))
  })

  test("--no-cache forces fresh calls even when the cache is warm", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-pipe-'))
    const databasePath = path.join(tmpDir, 'state.db')

    const database = openStateDatabase(databasePath)
    db = database
    applySchema(database)
    database
      .prepare('INSERT INTO targets (id, location, commit_sha) VALUES (?, ?, ?)')
      .run('target-1', tmpDir, 'abc123')
    seedRun({
      database,
      targetId: 'target-1',
      runId: 'run-1',
      candidates: [{ id: 'cand-1', filePath: 'src/a.c' }],
    })

    const first = createFakeInvoker({
      respond: (call) =>
        call.role === 'triage'
          ? { label: 'likely-noise', rationale: 'noise' }
          : { verdict: 'benign', reasoning: 'benign', preconditions: [] },
    })

    await runOnce({ database, targetId: 'target-1', runId: 'run-1', invoker: first })

    seedRun({
      database,
      targetId: 'target-1',
      runId: 'run-2',
      candidates: [{ id: 'cand-2', filePath: 'src/a.c' }],
    })

    const second = createFakeInvoker({
      respond: (call) =>
        call.role === 'triage'
          ? { label: 'likely-noise', rationale: 'noise' }
          : { verdict: 'benign', reasoning: 'benign', preconditions: [] },
    })

    const result = await runPipeline({
      db: database,
      runId: 'run-2',
      targetId: 'target-1',
      candidates: readCandidatesForTriage(database, 'run-2'),
      invoker: second,
      programContext: createProgramContext(database, 'target-1'),
      cacheDisabled: true,
      log: () => {},
    })

    // Fresh calls happened, so a disabled cache is not silently ignored.
    expect(second.calls.map((call) => call.role)).toEqual(['triage'])
    expect(result.triage.cached).toBe(0)
  })
})
