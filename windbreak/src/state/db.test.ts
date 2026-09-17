import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { Database } from 'bun:sqlite'

import {
  listTables,
  openStateDatabase,
  SCHEMA_VERSION,
  SchemaVersionMismatchError,
} from './db'

const EXPECTED_TABLES = [
  'adjudication_queue',
  'budget_events',
  'candidates',
  'checker_replays',
  'checkers',
  // §20.35's automated dynamic confirmation: one row per candidate per run, so the
  // stage can say how often it was unable to run as well as what it reproduced.
  'confirmations',
  'dependencies',
  'findings',
  'investigator_turns',
  'ledger',
  'osv_matches',
  'recon_files',
  'run_metrics',
  'runs',
  'symbol_refs',
  'symbols',
  'targets',
  'verdict_cache',
  'verdicts',
  // §20.30's writable copy of the target, so a turn can name the tree it wrote to.
  'working_copies',
]

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-db-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('openStateDatabase', () => {
  test('creates every table from the spec schema', () => {
    const db = openStateDatabase(path.join(tmpDir, 'state.db'))
    try {
      expect(listTables(db).sort()).toEqual([...EXPECTED_TABLES].sort())
    } finally {
      db.close()
    }
  })

  test('records the schema version', () => {
    const db = openStateDatabase(path.join(tmpDir, 'state.db'))
    try {
      const version = db
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version
      expect(version).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  test('is idempotent', () => {
    const databasePath = path.join(tmpDir, 'state.db')

    openStateDatabase(databasePath).close()
    const reopened = openStateDatabase(databasePath)
    try {
      expect(listTables(reopened).sort()).toEqual([...EXPECTED_TABLES].sort())
    } finally {
      reopened.close()
    }
  })

  test('refuses a database written by a different schema version', () => {
    const databasePath = path.join(tmpDir, 'stale.db')
    const stale = new Database(databasePath, { create: true })
    stale.exec('PRAGMA user_version = 999;')
    stale.close()

    expect(() => openStateDatabase(databasePath)).toThrow(
      SchemaVersionMismatchError,
    )
  })

  test('works in memory', () => {
    const db = openStateDatabase(':memory:')
    try {
      expect(listTables(db)).toContain('candidates')
    } finally {
      db.close()
    }
  })

  test('creates missing parent directories', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'state.db')

    const db = openStateDatabase(nested)
    try {
      expect(fs.existsSync(nested)).toBe(true)
      expect(listTables(db)).toContain('symbols')
    } finally {
      db.close()
    }
  })
})
