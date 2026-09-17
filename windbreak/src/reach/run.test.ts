import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'

import { readCandidateReachability, readEntryPoints } from './persist'
import { runReachability } from './run'

describe('runReachability', () => {
  let db: Database

  const seedSymbol = (name: string, startLine: number, endLine: number, filePath = 'src/main.c') => {
    db.prepare(
      `INSERT INTO symbols (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
       VALUES (?, 'target-1', ?, ?, NULL, 'function', ?, ?, 'c')`,
    ).run(`target-1:${filePath}:${name}:${startLine}`, filePath, name, startLine, endLine)
  }

  const seedRef = (name: string, line: number, filePath = 'src/main.c') => {
    db.prepare(
      `INSERT INTO symbol_refs (id, target_id, file_path, name, kind, line, language)
       VALUES (?, 'target-1', ?, ?, 'call', ?, 'c')`,
    ).run(`target-1:${filePath}:${line}:${name}`, filePath, name, line)
  }

  const seedCandidate = (id: string, filePath: string | null, startLine: number | null) => {
    db.prepare(
      `INSERT INTO candidates (id, run_id, source, file_path, start_line, normalized_json, state)
       VALUES (?, 'run-1', 'semgrep', ?, ?, '{}', 'new')`,
    ).run(id, filePath, startLine)
  }

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('target-1', '/tmp/target')
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES ('run-1', 'target-1', '{}', 'abc', 'running')`,
    ).run()
  })

  test('records the inventory and classifies every located candidate', () => {
    seedSymbol('main', 1, 10)
    seedSymbol('parse', 20, 30)
    seedSymbol('dead-a', 40, 50)
    seedSymbol('dead-b', 60, 70)
    seedRef('parse', 5)
    seedRef('dead-b', 45)
    seedRef('dead-a', 65)
    seedCandidate('cand-live', 'src/main.c', 25)
    seedCandidate('cand-dead', 'src/main.c', 45)

    const outcome = runReachability({ db, targetId: 'target-1', runId: 'run-1' })

    expect(readEntryPoints(db, 'target-1').map((entry) => entry.name)).toEqual(['main'])
    expect(outcome.annotated).toBe(2)
    expect(outcome.unlocated).toBe(0)
    expect(outcome.counts).toMatchObject({ definitions: 4, attackerInput: 2, unreachable: 2 })

    const live = readCandidateReachability(db, 'cand-live')!
    expect(live.klass).toBe('attacker-input')
    expect(live.distance).toBe(1)
    expect(live.path.map((step) => step.name)).toEqual(['main', 'parse'])
    expect(live.definition!.name).toBe('parse')

    const dead = readCandidateReachability(db, 'cand-dead')!
    expect(dead.klass).toBe('unreachable')
    expect(dead.path).toEqual([])
    // Everything the evidence bundle needs to state the conclusion without the graph.
    expect(dead.coverage).toEqual({ entries: 1, externalCallees: 0, noEntries: false })
  })

  test('a candidate with no location is counted rather than classified', () => {
    seedSymbol('main', 1, 10)
    seedCandidate('cand-unlocated', null, null)

    const outcome = runReachability({ db, targetId: 'target-1', runId: 'run-1' })

    expect(outcome.unlocated).toBe(1)
    expect(outcome.annotated).toBe(0)
    expect(readCandidateReachability(db, 'cand-unlocated')).toBeNull()
  })

  test('a re-run replaces the inventory instead of duplicating it', () => {
    seedSymbol('main', 1, 10)
    seedCandidate('cand-1', 'src/main.c', 5)

    runReachability({ db, targetId: 'target-1', runId: 'run-1' })
    runReachability({ db, targetId: 'target-1', runId: 'run-1' })

    expect(readEntryPoints(db, 'target-1')).toHaveLength(1)
  })

  test('a model with no entry point warns instead of calling anything unreachable', () => {
    seedSymbol('a', 1, 10)
    seedSymbol('b', 20, 30)
    seedRef('b', 5)
    seedRef('a', 25)
    seedCandidate('cand-1', 'src/main.c', 5)

    const outcome = runReachability({ db, targetId: 'target-1', runId: 'run-1' })

    expect(outcome.warnings.join(' ')).toMatch(/no entry point was identified/)
    expect(readCandidateReachability(db, 'cand-1')!.klass).toBe('unknown')
  })

  test('a program model the caller already read is used instead of re-querying', () => {
    // The rows say `main` reaches `parse`; the supplied source says it does not. The
    // pass follows what it was given, which is what keeps a stage that already holds the
    // model from paying for a second read — and from disagreeing with the caller.
    seedSymbol('main', 1, 10)
    seedSymbol('parse', 20, 30)
    seedRef('parse', 5)
    seedCandidate('cand-1', 'src/main.c', 26)

    const outcome = runReachability({
      db,
      targetId: 'target-1',
      runId: 'run-1',
      source: {
        definitions: [
          { filePath: 'src/main.c', name: 'main', startLine: 1, endLine: 10 },
          { filePath: 'src/main.c', name: 'parse', startLine: 20, endLine: 30 },
        ],
        references: [],
      },
    })

    // No references at all, so `parse` has no callers and is an entry of its own; `main`
    // is an attacker-input entry whatever the references say.
    expect(outcome.counts).toEqual({
      definitions: 2,
      entries: 2,
      attackerInput: 1,
      exposedApi: 1,
      unreachable: 0,
      unknown: 0,
    })
    expect(readCandidateReachability(db, 'cand-1')!.klass).toBe('exposed-api')
    // The inventory is written from the supplied model too, so the two cannot disagree.
    expect(readEntryPoints(db, 'target-1').map((entry) => entry.name)).toEqual([
      'main',
      'parse',
    ])
  })

  test('a target with no callables records nothing and says so', () => {
    seedCandidate('cand-1', 'src/main.c', 5)

    const outcome = runReachability({ db, targetId: 'target-1', runId: 'run-1' })

    expect(outcome.counts.definitions).toBe(0)
    expect(outcome.coverage.noEntries).toBe(true)
    expect(readEntryPoints(db, 'target-1')).toEqual([])
    // Still classified — as unknown, because a site outside every indexed callable is a
    // gap in the parse rather than a fact about the program.
    expect(readCandidateReachability(db, 'cand-1')!.klass).toBe('unknown')
  })
})
