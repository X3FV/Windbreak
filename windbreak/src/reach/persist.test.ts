import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { applySchema } from '../state/db'

import { describeReachability, formatReachabilityCoverage } from './format'
import {
  parseCandidateReachability,
  persistCandidateReachability,
  persistEntryPoints,
  reachabilityToJson,
  readCandidateReachability,
  readEntryPoints,
} from './persist'

import type { EntryPoint } from './entries'
import type { CandidateReachability } from './persist'

const entry = (overrides: Partial<EntryPoint> = {}): EntryPoint => ({
  filePath: 'src/main.c',
  name: 'main',
  kind: 'main',
  reason: 'the program’s entry point',
  sources: [],
  ...overrides,
})

const conclusion = (overrides: Partial<CandidateReachability> = {}): CandidateReachability => ({
  klass: 'attacker-input',
  distance: 2,
  entry: {
    filePath: 'src/main.c',
    name: 'main',
    kind: 'main',
    reason: 'the program’s entry point',
  },
  incomplete: [],
  path: [
    { filePath: 'src/main.c', name: 'main', line: null },
    { filePath: 'src/main.c', name: 'parse', line: 5 },
  ],
  definition: { filePath: 'src/main.c', name: 'parse', startLine: 20, endLine: 30 },
  coverage: { entries: 2, externalCallees: 0, noEntries: false },
  ...overrides,
})

describe('entry point persistence', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('target-1', '/tmp/target')
  })

  test('stores each entry with the reason it counts', () => {
    persistEntryPoints({
      db,
      targetId: 'target-1',
      entries: [
        entry(),
        entry({
          name: 'serve',
          filePath: 'src/net.c',
          kind: 'input-source',
          reason: 'reads input here (recv: reads from a socket)',
          sources: ['recv'],
        }),
      ],
    })

    // Ordered by path, not by insertion, and the reason round-trips: a finding that says
    // "reachable from main" has to be checkable against the row that made the claim.
    expect(readEntryPoints(db, 'target-1')).toEqual([
      {
        filePath: 'src/main.c',
        name: 'main',
        kind: 'main',
        reason: 'the program’s entry point',
        sources: [],
      },
      {
        filePath: 'src/net.c',
        name: 'serve',
        kind: 'input-source',
        reason: 'reads input here (recv: reads from a socket)',
        sources: ['recv'],
      },
    ])
  })

  test('the inventory replaces the previous one instead of growing', () => {
    persistEntryPoints({
      db,
      targetId: 'target-1',
      entries: [entry(), entry({ name: 'serve', filePath: 'src/net.c', kind: 'unrooted' })],
    })
    expect(readEntryPoints(db, 'target-1')).toHaveLength(2)

    persistEntryPoints({ db, targetId: 'target-1', entries: [entry()] })

    expect(readEntryPoints(db, 'target-1')).toHaveLength(1)
  })

  test('one target’s inventory does not disturb another’s', () => {
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('target-2', '/tmp/other')
    persistEntryPoints({ db, targetId: 'target-1', entries: [entry()] })
    persistEntryPoints({
      db,
      targetId: 'target-2',
      entries: [entry({ name: 'LLVMFuzzerTestOneInput', kind: 'fuzz-entry' })],
    })

    persistEntryPoints({ db, targetId: 'target-1', entries: [] })

    expect(readEntryPoints(db, 'target-1')).toHaveLength(0)
    expect(readEntryPoints(db, 'target-2')).toHaveLength(1)
  })
})

describe('candidate reachability persistence', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA foreign_keys = ON;')
    applySchema(db)
    db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run('target-1', '/tmp/target')
    db.prepare(
      `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
       VALUES ('run-1', 'target-1', '{}', 'abc', 'running')`,
    ).run()
    db.prepare(
      `INSERT INTO candidates (id, run_id, source, normalized_json, state)
       VALUES ('cand-1', 'run-1', 'semgrep', '{}', 'new')`,
    ).run()
  })

  test('a conclusion round-trips through the column', () => {
    persistCandidateReachability({
      db,
      candidateId: 'cand-1',
      reachability: conclusion(),
    })

    expect(readCandidateReachability(db, 'cand-1')).toEqual(conclusion())
  })

  test('an unanalyzed candidate reads as null, which is not a class', () => {
    // NULL is "the pass never ran" — a pre-§4.4.4 database. It must not read as a class,
    // because `unreachable` is the one value that excludes a candidate.
    expect(readCandidateReachability(db, 'cand-1')).toBeNull()
    expect(parseCandidateReachability(null)).toBeNull()
  })

  test('an unreadable row is null rather than a guess at a class', () => {
    expect(parseCandidateReachability('{ not json')).toBeNull()
    expect(parseCandidateReachability('[]')).toBeNull()
    expect(parseCandidateReachability('null')).toBeNull()
    // A class with no coverage is not something this module ever wrote, so it is not
    // something it will read: the marker is required rather than defaulted.
    expect(parseCandidateReachability('{"klass":"unreachable"}')).toBeNull()
    expect(parseCandidateReachability('{"klass":"maybe","coverage":{}}')).toBeNull()
    expect(parseCandidateReachability('{"coverage":{}}')).toBeNull()
  })

  test('an unknown class is rejected rather than coerced', () => {
    const written = JSON.parse(reachabilityToJson(conclusion())) as Record<string, unknown>
    written.klass = 'definitely-not-reachable'

    expect(parseCandidateReachability(JSON.stringify(written))).toBeNull()
  })

  test('a conclusion survives the round trip with its caveats intact', () => {
    const unknown = conclusion({
      klass: 'unknown',
      distance: null,
      entry: null,
      incomplete: ['no entry point was identified in this target'],
      path: [],
      definition: null,
      coverage: { entries: 0, externalCallees: 3, noEntries: true },
    })

    expect(parseCandidateReachability(reachabilityToJson(unknown))).toEqual(unknown)
  })
})

describe('formatReachabilityCoverage', () => {
  const counts = {
    definitions: 10,
    entries: 2,
    attackerInput: 3,
    exposedApi: 1,
    unreachable: 4,
    unknown: 2,
  }

  test('a model with no callables says so rather than reporting zeros', () => {
    const line = formatReachabilityCoverage({
      counts: { ...counts, definitions: 0, attackerInput: 2 },
      coverage: { entries: 0, noEntries: true, taintRoots: 0, externalCallees: 0 },
    })

    expect(line).toMatch(/no indexed callables/)
  })

  test('an empty inventory is a statement about the parse, not about the target', () => {
    const line = formatReachabilityCoverage({
      counts,
      coverage: { entries: 0, noEntries: true, taintRoots: 0, externalCallees: 0 },
    })

    expect(line).toMatch(/no entry point was identified/)
    expect(line).toMatch(/reachable or unreachable/)
  })

  test('the classes and their denominator print together', () => {
    const line = formatReachabilityCoverage({
      counts,
      coverage: { entries: 2, noEntries: false, taintRoots: 1, externalCallees: 5 },
    })

    expect(line).toContain('3/10 callable(s) reachable from attacker input')
    expect(line).toContain('1 exposed-api only')
    expect(line).toContain('4 no path')
    expect(line).toContain('2 unknown')
    expect(line).toContain('2 entry points')
    expect(line).toContain('1 incomplete caller set(s)')
    expect(line).toContain('5 name(s) with no definition')
  })

  test('the per-kind breakdown prints only when the caller has it', () => {
    const withKinds = formatReachabilityCoverage({
      counts,
      coverage: {
        entries: 2,
        noEntries: false,
        taintRoots: 0,
        externalCallees: 0,
        entryKinds: { 'fuzz-entry': 1, main: 1, 'input-source': 0, unrooted: 0 },
      },
    })
    const withoutKinds = formatReachabilityCoverage({
      counts,
      coverage: { entries: 2, noEntries: false, taintRoots: 0, externalCallees: 0 },
    })

    expect(withKinds).toContain('1 fuzz')
    expect(withoutKinds).not.toContain('fuzz')
  })
})

describe('describeReachability', () => {
  test('attacker-input states the entry and the path', () => {
    const line = describeReachability(conclusion())

    expect(line).toMatch(/an attacker can reach this/)
    expect(line).toContain('main (src/main.c)')
    expect(line).toContain('2 calls deep')
    expect(line).toContain('main (src/main.c) -> parse (src/main.c:5)')
  })

  test('exposed-api admits it cannot tell a library API from dead code', () => {
    const line = describeReachability(
      conclusion({ klass: 'exposed-api', entry: null, path: [], distance: 0 }),
    )

    expect(line).toMatch(/reachable from outside the indexed program/)
    expect(line).toMatch(/cannot tell which/)
  })

  test('unreachable states the search and the completeness of the caller sets', () => {
    const line = describeReachability(
      conclusion({ klass: 'unreachable', distance: null, entry: null, path: [] }),
    )

    expect(line).toMatch(/no path from any of the 2 entry points/)
    expect(line).toMatch(/every caller set on the way in is complete/)
    // Nothing to disclaim when every callee resolved.
    expect(line).not.toMatch(/function pointer/)
  })

  test('unreachable names the hole a pointer call leaves, when there is one', () => {
    const line = describeReachability(
      conclusion({
        klass: 'unreachable',
        distance: null,
        entry: null,
        path: [],
        coverage: { entries: 2, externalCallees: 7, noEntries: false },
      }),
    )

    expect(line).toMatch(/7 callee names have no indexed definition/)
    expect(line).toMatch(/function pointer/)
  })

  test('unknown carries the reason it could not settle', () => {
    const line = describeReachability(
      conclusion({
        klass: 'unknown',
        distance: null,
        entry: null,
        path: [],
        incomplete: ['1 call site(s) naming it sit outside every indexed callable'],
      }),
    )

    expect(line).toMatch(/unknown/)
    expect(line).toContain('1 call site(s) naming it sit outside every indexed callable')
  })
})
