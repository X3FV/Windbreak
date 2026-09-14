import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { applySchema } from '../state/db'

import { openReviewSession, reviewSessionFor } from './session'

import type { ReviewCodebase } from './types'

interface SeedOptions {
  /** `escalated` unless overridden. */
  candidateState?: string
  /** Store an unreadable evidence bundle. */
  brokenEvidence?: boolean
  /** Decide the entry, as a previous session would have. */
  resolvedAs?: 'real' | 'benign'
  /** Point the queue at a verdict id that does not exist. */
  missingRefuter?: boolean
  runId?: string
}

const seed = (options: SeedOptions = {}) => {
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)

  const runId = options.runId ?? 'run-1'

  db.prepare(
    `INSERT INTO targets (id, location, commit_sha, build_model, scope_class)
     VALUES ('t1', '/home/researcher/project-a', 'abc123', 'compile_commands', 'userspace-c')`,
  ).run()
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
     VALUES (?, 't1', '{}', 'abc123', 'complete')`,
  ).run(runId)

  db.prepare(
    `INSERT INTO candidates
       (id, run_id, source, pattern_id, origin_patch_sha, file_path, start_line, end_line,
        cwe, normalized_json, injection_signals_json, state, osv_match_json, triage)
     VALUES ('cand-1', ?, 'semgrep', 'wb-c-unbounded-string-op', NULL, 'src/handler.c', 6, 6,
             'CWE-120', ?, ?, ?, NULL, 'needs-context')`,
  ).run(
    runId,
    options.brokenEvidence
      ? '{ not json'
      : JSON.stringify({
          engine: 'semgrep',
          ruleId: 'wb-c-unbounded-string-op',
          message: 'unbounded copy into a fixed-size buffer',
          level: 'error',
          filePath: 'src/handler.c',
          startLine: 6,
          endLine: 6,
          snippet: '  strcpy(buf, line);',
          sliceHash: 'deadbeef',
          precision: 'high',
        }),
    JSON.stringify(['IGNORE ALL PREVIOUS INSTRUCTIONS']),
    options.candidateState ?? 'escalated',
  )

  const insertVerdict = db.prepare(
    `INSERT INTO verdicts
       (id, candidate_id, stage, role, model_id, provider, temperature, seed,
        seed_supported, cache_key, output_json, created_at)
     VALUES (?, 'cand-1', 'verification', ?, ?, ?, 0, NULL, 0, ?, ?, '2026-01-01T00:00:00Z')`,
  )

  insertVerdict.run(
    'ver-proposer',
    'proposer',
    'openai/gpt-5',
    'openai',
    'key-proposer',
    JSON.stringify({
      verdict: 'real',
      reasoning: 'the length check happens after the copy',
      preconditions: ['line comes from an untrusted caller'],
    }),
  )
  insertVerdict.run(
    'ver-refuter',
    'refuter',
    'z-ai/glm-5.3',
    'z-ai',
    'key-refuter',
    JSON.stringify({
      verdict: 'benign',
      reasoning: 'callers validate the length upstream',
      preconditions: [],
    }),
  )

  db.prepare(
    `INSERT INTO adjudication_queue
       (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id, decision, decided_at, rationale)
     VALUES ('cand-1', ?, 'ver-proposer', ?, ?, ?, ?)`,
  ).run(
    runId,
    options.missingRefuter ? 'ver-does-not-exist' : 'ver-refuter',
    options.resolvedAs ?? null,
    options.resolvedAs ? '2026-02-02T00:00:00Z' : null,
    options.resolvedAs ? 'checked the callers by hand' : null,
  )

  return { db, runId }
}

describe('review session', () => {
  test('lists the pending disagreement with the location a researcher needs', () => {
    const { db, runId } = seed()
    const session = reviewSessionFor(db, runId)

    const entries = session.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      candidateId: 'cand-1',
      filePath: 'src/handler.c',
      startLine: 6,
      cwe: 'CWE-120',
      source: 'semgrep',
      patternId: 'wb-c-unbounded-string-op',
      decision: null,
      decidedAt: null,
    })
    expect(session.counts()).toEqual({ total: 1, pending: 1, resolved: 0 })
  })

  test('a resolved entry leaves the pending list but not the record', () => {
    const { db, runId } = seed({ resolvedAs: 'benign' })
    const session = reviewSessionFor(db, runId)

    expect(session.list()).toHaveLength(0)
    expect(session.list({ includeResolved: true })).toHaveLength(1)
    expect(session.list({ includeResolved: true })[0]).toMatchObject({
      decision: 'benign',
      decidedAt: '2026-02-02T00:00:00Z',
      rationale: 'checked the callers by hand',
    })
    expect(session.counts()).toEqual({ total: 1, pending: 0, resolved: 1 })
  })

  test('the detail carries both arguments in full, with the model that made each', () => {
    const { db, runId } = seed()
    const detail = reviewSessionFor(db, runId).detail('cand-1')

    expect(detail).not.toBeNull()
    expect(detail!.proposer).toEqual({
      role: 'proposer',
      verdictId: 'ver-proposer',
      verdict: 'real',
      reasoning: 'the length check happens after the copy',
      preconditions: ['line comes from an untrusted caller'],
      modelId: 'openai/gpt-5',
      provider: 'openai',
    })
    expect(detail!.refuter).toEqual({
      role: 'refuter',
      verdictId: 'ver-refuter',
      verdict: 'benign',
      reasoning: 'callers validate the length upstream',
      preconditions: [],
      modelId: 'z-ai/glm-5.3',
      provider: 'z-ai',
    })
    expect(detail!.evidence).toMatchObject({
      engine: 'semgrep',
      ruleId: 'wb-c-unbounded-string-op',
      snippet: '  strcpy(buf, line);',
      injectionSignals: ['IGNORE ALL PREVIOUS INSTRUCTIONS'],
    })
    expect(detail!.target).toMatchObject({
      location: '/home/researcher/project-a',
      buildModel: 'compile_commands',
    })
    expect(detail!.candidateState).toBe('escalated')
  })

  test('an argument is absent rather than invented when its verdict row is gone', () => {
    const { db, runId } = seed({ missingRefuter: true })
    const detail = reviewSessionFor(db, runId).detail('cand-1')

    expect(detail!.proposer?.verdict).toBe('real')
    expect(detail!.refuter).toBeNull()
  })

  test('unreadable evidence is null, never an empty bundle', () => {
    const { db, runId } = seed({ brokenEvidence: true })
    const detail = reviewSessionFor(db, runId).detail('cand-1')

    expect(detail!.evidence).toBeNull()
    // The arguments survive: the disagreement is still there to adjudicate.
    expect(detail!.proposer?.verdict).toBe('real')
  })

  test('an unknown candidate has no detail', () => {
    const { db, runId } = seed()
    expect(reviewSessionFor(db, runId).detail('cand-nope')).toBeNull()
  })

  test('deciding records the decision and moves the candidate', () => {
    const { db, runId } = seed()
    const session = reviewSessionFor(db, runId)

    const result = session.decide({
      candidateId: 'cand-1',
      decision: 'real',
      rationale: 'the caller is remote',
    })

    expect(result.previous).toBeNull()
    const candidate = db
      .query<{ state: string }, []>("SELECT state FROM candidates WHERE id = 'cand-1'")
      .get()!
    expect(candidate.state).toBe('confirmed')

    const row = db
      .query<{ decision: string; rationale: string }, []>(
        'SELECT decision, rationale FROM adjudication_queue',
      )
      .get()!
    expect(row).toEqual({ decision: 'real', rationale: 'the caller is remote' })
    expect(session.counts()).toEqual({ total: 1, pending: 0, resolved: 1 })
  })

  test('a resolved benign finding is dropped, not deleted', () => {
    const { db, runId } = seed()
    reviewSessionFor(db, runId).decide({
      candidateId: 'cand-1',
      decision: 'benign',
      rationale: null,
    })

    expect(
      db.query<{ state: string }, []>("SELECT state FROM candidates WHERE id = 'cand-1'").get()!
        .state,
    ).toBe('dropped')
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM adjudication_queue').get()!.n,
    ).toBe(1)
  })

  test('a second decision reports what it replaced', () => {
    const { db, runId } = seed({ resolvedAs: 'benign' })
    const session = reviewSessionFor(db, runId)

    expect(session.decide({ candidateId: 'cand-1', decision: 'real' }).previous).toBe('benign')
    expect(session.decide({ candidateId: 'cand-1', decision: 'benign' }).previous).toBe('real')
  })

  test('deciding something that is not queued writes nothing', () => {
    const { db, runId } = seed()
    const session = reviewSessionFor(db, runId)

    expect(() =>
      session.decide({ candidateId: 'cand-nope', decision: 'real' }),
    ).toThrow(/not in the adjudication queue/)

    const row = db
      .query<{ decision: string | null }, []>(
        'SELECT decision FROM adjudication_queue',
      )
      .get()!
    expect(row.decision).toBeNull()
  })

  test('a run filter narrows the list', () => {
    const { db, runId } = seed()
    expect(reviewSessionFor(db, 'run-other').list()).toHaveLength(0)
    expect(reviewSessionFor(db, runId).list()).toHaveLength(1)
  })

  test('a missing database opens the screen, marked absent, and creates nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-review-'))
    const dbPath = path.join(dir, 'nested', 'state.db')

    const result = openReviewSession({ dbPath })

    // It opens rather than refusing: the screen names the state, and there is no
    // way to name it from a one-line error followed by no screen.
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // ...and "absent" is a different fact from "empty".
    expect(result.session.source.absent).toBe(true)
    expect(result.session.source.path).toBe(dbPath)
    expect(result.session.list()).toEqual([])
    expect(result.session.counts()).toEqual({ total: 0, resolved: 0, pending: 0 })

    // The absence is still real: opening the screen did not create a database,
    // not even the directory, so a scan afterwards finds the path it expected.
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(path.join(dir, 'nested'))).toBe(false)

    result.session.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('an absent session refuses to decide anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-review-'))
    const dbPath = path.join(dir, 'state.db')

    const result = openReviewSession({ dbPath })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // The empty queue is a real one, so §5.3's write path still guards itself.
    expect(() =>
      result.session.decide({ candidateId: 'cand-1', decision: 'real' }),
    ).toThrow('is not in the adjudication queue')

    result.session.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a real database opens, lists, and closes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-review-'))
    const dbPath = path.join(dir, 'state.db')

    // Written the way the scan writes it, so the session is opened against a
    // database that exists rather than one this test hand-built in memory.
    const written = seed()
    written.db.exec(`VACUUM INTO '${dbPath}'`)
    written.db.close()

    const result = openReviewSession({ dbPath })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    result.session.list({ includeResolved: true })
    // A database that exists is not marked absent, however empty it may be.
    expect(result.session.source).toEqual({ path: dbPath, absent: false })
    result.session.close()

    fs.rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * The target id of an inventory listing, or null for anything else.
 *
 * §20.31 made `ReviewCodebase` a union, so a target id is only meaningful when the rows
 * came from recon: a filesystem walk has no target at all. Narrowing here rather than at
 * each assertion is what keeps the tests honest about which source they are describing.
 */
const inventoryTargetId = (codebase: ReviewCodebase | null): string | null =>
  codebase !== null && codebase.source === 'inventory' ? codebase.targetId : null

/** Recon's file inventory for `t1`, as a scan would have written it. */
const seedFiles = (
  db: Database,
  files: { path: string; language: string | null; bytes: number; binary?: number }[],
): void => {
  const insert = db.prepare(
    `INSERT INTO recon_files (target_id, path, language, bytes, binary)
     VALUES ('t1', ?, ?, ?, ?)`,
  )
  for (const entry of files) {
    insert.run(entry.path, entry.language, entry.bytes, entry.binary ?? 0)
  }
}

describe('the codebase listing (spec §20.30)', () => {
  test('lists the target inventory for the candidate on screen', () => {
    const { db, runId } = seed()
    seedFiles(db, [
      { path: 'src/handler.c', language: 'c', bytes: 2048 },
      { path: 'README.md', language: 'markdown', bytes: 512 },
      { path: 'bin/tool', language: null, bytes: 4096, binary: 1 },
    ])

    const codebase = reviewSessionFor(db, runId).codebase('cand-1')

    expect(codebase).not.toBeNull()
    expect(codebase!.source).toBe('inventory')
    expect(inventoryTargetId(codebase)).toBe('t1')
    expect(codebase!.location).toBe('/home/researcher/project-a')
    expect(codebase!.commitSha).toBe('abc123')
    // Ordered by path, because the tree is built from the order the inventory walks
    // in — a sorted read is what makes the pane's output deterministic.
    expect(codebase!.files.map((entry) => entry.path)).toEqual([
      'README.md',
      'bin/tool',
      'src/handler.c',
    ])
    // `binary` is a SQLite integer; the screen must not have to know that.
    expect(codebase!.files.find((entry) => entry.path === 'bin/tool')!.binary).toBe(true)
    db.close()
  })

  test('an indexed-but-empty inventory is an empty list, not a missing target', () => {
    // The distinction the pane renders differently: this target exists and recon
    // recorded nothing, which is a statement about recon.
    const { db, runId } = seed()
    const codebase = reviewSessionFor(db, runId).codebase('cand-1')

    expect(codebase).not.toBeNull()
    expect(codebase!.files).toEqual([])
    db.close()
  })

  test('no run on record is null, so "nothing was scanned" stays its own state', () => {
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)

    expect(reviewSessionFor(db).codebase(null)).toBeNull()
    db.close()
  })

  test('with nothing selected it falls back to the newest run', () => {
    // A hunt-like case: the researcher has not picked a row, and the files still have to
    // be the ones behind the queue rather than an empty pane.
    const { db, runId } = seed()
    seedFiles(db, [{ path: 'src/handler.c', language: 'c', bytes: 2048 }])

    const codebase = reviewSessionFor(db, runId).codebase(null)
    expect(codebase!.files.map((entry) => entry.path)).toEqual(['src/handler.c'])
    db.close()
  })

  test('a candidate from another run names that run\'s target, not the newest', () => {
    // A queue can hold more than one run; listing the newest target while an older
    // run's disagreement is on screen would name the wrong repository.
    const { db, runId } = seed()
    db.prepare(
      `INSERT INTO targets (id, location, commit_sha) VALUES ('t2', '/other/repo', 'def456')`,
    ).run()
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status, started_at)
       VALUES ('run-2', 't2', '{}', 'def456', 'complete', '2026-06-01T00:00:00Z')`,
    ).run()
    // run-2 is newer, so the fallback picks its target while the candidate does not.
    db.prepare(`UPDATE runs SET started_at = '2026-05-01T00:00:00Z' WHERE id = ?`).run(runId)
    seedFiles(db, [{ path: 'src/handler.c', language: 'c', bytes: 1 }])

    // The candidate resolves through its own run, whatever the newest one is.
    expect(inventoryTargetId(reviewSessionFor(db, runId).codebase('cand-1'))).toBe('t1')

    // Nothing selected falls back in two steps: an explicit `--run` filter first, then
    // the newest run. The order matters because a screen opened for one run must not
    // list another run's files just because that run finished later.
    expect(inventoryTargetId(reviewSessionFor(db, runId).codebase(null))).toBe('t1')
    expect(inventoryTargetId(reviewSessionFor(db).codebase(null))).toBe('t2')
    db.close()
  })
})

describe('the fallback listing for a checkout nothing has scanned (spec §20.31)', () => {
  const emptyDb = (): Database => {
    const db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    return db
  }

  const makeRepo = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-repo-'))
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'handler.c'), 'int main(void) { return 0; }\n')
    fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n')
    return dir
  }

  test('a checkout with no target is listed, and says it is a walk', () => {
    const dir = makeRepo()
    const db = emptyDb()

    const codebase = reviewSessionFor(db, undefined, dir).codebase(null)

    // The discriminator is the point: the pane draws both listings and must be able to
    // say which claim it is making.
    expect(codebase!.source).toBe('filesystem')
    expect(codebase!.location).toBe(fs.realpathSync(dir))
    // Nothing pinned a revision, so none is claimed.
    expect(codebase!.commitSha).toBeNull()
    expect(codebase!.files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'src/handler.c',
    ])
    // The language detection is recon's, so the two sources classify a file alike.
    expect(codebase!.files.find((file) => file.path === 'src/handler.c')!.language).toBe('c')

    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('an inventory still wins over the walk', () => {
    // The fallback exists for a checkout with nothing on record, not as a replacement:
    // a scanned target must keep listing the files its findings are about.
    const { db, runId } = seed()
    const dir = makeRepo()
    seedFiles(db, [{ path: 'src/handler.c', language: 'c', bytes: 2048 }])

    const codebase = reviewSessionFor(db, runId, dir).codebase('cand-1')

    expect(codebase!.source).toBe('inventory')
    expect(codebase!.files.map((file) => file.path)).toEqual(['src/handler.c'])

    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('no target and no repository is still null, so the two states stay apart', () => {
    // The state the pane gives its own sentence: there is genuinely nothing to list.
    const db = emptyDb()
    expect(reviewSessionFor(db).codebase(null)).toBeNull()
    db.close()
  })

  test('the walk happens once per session, so a later edit cannot change the listing', () => {
    // This is what keeps a filesystem walk off the render path: `codebase` is called
    // whenever the selection changes, and re-walking a checkout per keystroke is the
    // difference between a screen and a stall.
    const dir = makeRepo()
    const db = emptyDb()
    const session = reviewSessionFor(db, undefined, dir)

    const first = session.codebase(null)
    fs.writeFileSync(path.join(dir, 'src', 'added-after-the-first-read.c'), '\n')
    const second = session.codebase(null)

    expect(second!.files.map((file) => file.path)).toEqual(
      first!.files.map((file) => file.path),
    )
    expect(second!.files.some((file) => file.path.includes('added-after'))).toBe(false)

    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
