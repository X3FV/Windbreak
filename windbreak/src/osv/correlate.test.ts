import { beforeEach, describe, expect, test } from 'bun:test'

import { Database } from 'bun:sqlite'

import { OsvClient, OsvHttpError } from './client'
import { collectDependencies, correlateWithOsv } from './correlate'
import { readCorrelationSummary } from './store'
import { applySchema } from '../state/db'

import type { ManifestRef } from '../recon/deps'
import type { OsvTransport } from './types'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    'target-1',
    '/virtual',
  )
})

const MANIFESTS: ManifestRef[] = [
  { type: 'npm-lock', path: 'package-lock.json', ecosystem: 'npm' },
  { type: 'pip-requirements', path: 'requirements.txt', ecosystem: 'PyPI' },
  { type: 'npm', path: 'package.json', ecosystem: 'npm' },
  { type: 'pkg-config', path: 'openssl.pc', ecosystem: 'pkg-config' },
]

const FILES: Record<string, string> = {
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/left-pad': { version: '1.3.0' } },
  }),
  'requirements.txt': 'requests==2.0.0\n',
  'package.json': JSON.stringify({ dependencies: { lodash: '^4.17.0' } }),
  'openssl.pc': 'Name: OpenSSL\nVersion: 3.0.2\n',
}

const readFile = (absolutePath: string): string | null =>
  FILES[absolutePath.replace('/virtual/', '')] ?? null

const transportFor = (
  results: unknown[],
  details: Record<string, unknown> = {},
): OsvTransport => ({
  post: (path, body) => {
    if (path === '/v1/querybatch') {
      const queries = (body as { queries: unknown[] }).queries
      return Promise.resolve({
        results: queries.map((_, index) => results[index] ?? {}),
      })
    }
    return Promise.resolve({})
  },
  get: (path) => {
    const id = path.replace('/v1/vulns/', '')
    return Promise.resolve(details[id] ?? { id })
  },
})

const statusOf = (): string | null =>
  db
    .query<{ osv_status: string | null }, [string]>(
      'SELECT osv_status FROM targets WHERE id = ?',
    )
    .get('target-1')!.osv_status

describe('collectDependencies', () => {
  test('parses readable manifests and reports the ones it cannot', () => {
    const { dependencies, unsupportedManifests } = collectDependencies({
      targetRoot: '/virtual',
      manifests: [
        ...MANIFESTS,
        { type: 'go-mod', path: 'missing/go.mod', ecosystem: 'Go' },
      ],
      readFile,
    })

    expect(dependencies.map((d) => d.name).sort()).toEqual([
      'OpenSSL',
      'left-pad',
      'requests',
    ])
    expect(unsupportedManifests.map((m) => m.path)).toEqual([
      'package.json',
      'missing/go.mod',
    ])
  })
})

describe('correlateWithOsv', () => {
  test('queries only queryable dependencies and persists matches', async () => {
    const client = new OsvClient({
      transport: transportFor(
        [{ vulns: [{ id: 'GHSA-left-pad' }] }, {}],
        { 'GHSA-left-pad': { id: 'GHSA-left-pad', summary: 'prototype pollution' } },
      ),
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: MANIFESTS,
      targetId: 'target-1',
      commitSha: 'unknown',
      client,
      db,
      readFile,
    })

    expect(result.status).toBe('complete')
    // package.json is range-pinned, so it is recorded but never sent.
    expect(result.queriedPackages).toBe(2)
    expect(result.unqueryable).toBe(1)
    expect(result.packageMatches).toHaveLength(1)
    expect(result.packageMatches[0]!.vulns[0]).toMatchObject({
      id: 'GHSA-left-pad',
      summary: 'prototype pollution',
    })

    const summary = readCorrelationSummary(db, 'target-1')
    expect(summary).toEqual({ dependencies: 3, queryable: 2, matches: 1 })
    expect(statusOf()).toBe('complete')
  })

  test('records unavailable, not clean, when OSV cannot be reached', async () => {
    const client = new OsvClient({
      transport: {
        post: () => Promise.reject(new TypeError('fetch failed')),
        get: () => Promise.reject(new TypeError('fetch failed')),
      },
      sleep: async () => {},
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: MANIFESTS,
      targetId: 'target-1',
      commitSha: 'unknown',
      client,
      db,
      readFile,
    })

    expect(result.status).toBe('unavailable')
    expect(result.packageMatches).toEqual([])
    expect(result.failures).toBeGreaterThan(0)
    expect(statusOf()).toBe('unavailable')
    // Dependencies are still recorded: "we could not look" is different from
    // "there is nothing to look at".
    expect(readCorrelationSummary(db, 'target-1').dependencies).toBe(3)
    expect(readCorrelationSummary(db, 'target-1').matches).toBe(0)
  })

  test('degrades a failed detail fetch to an id-only record without failing the run', async () => {
    const client = new OsvClient({
      transport: {
        post: () => Promise.resolve({ results: [{ vulns: [{ id: 'GHSA-a' }] }] }),
        get: () => Promise.reject(new OsvHttpError(500, '/v1/vulns/x', 'boom')),
      },
      sleep: async () => {},
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: [MANIFESTS[0]!],
      targetId: 'target-1',
      commitSha: 'unknown',
      client,
      db,
      readFile,
    })

    // A missing detail degrades to the id-only record but is still a match, so
    // the run stays complete rather than being called partial.
    expect(result.status).toBe('complete')
    expect(result.packageMatches[0]!.vulns[0]!.id).toBe('GHSA-a')
  })

  test('records partial when the package batch succeeds but the commit query is rejected', async () => {
    const client = new OsvClient({
      transport: {
        post: (path) => {
          if (path === '/v1/query') {
            return Promise.reject(new OsvHttpError(400, path, 'bad commit'))
          }
          return Promise.resolve({ results: [{ vulns: [] }, { vulns: [] }] })
        },
        get: (path) => Promise.resolve({ id: path.replace('/v1/vulns/', '') }),
      },
      sleep: async () => {},
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: MANIFESTS,
      targetId: 'target-1',
      commitSha: 'abc123',
      client,
      db,
      readFile,
    })

    expect(result.status).toBe('partial')
    // Partial is still not clean: the target keeps a status downstream must
    // treat as unresolved rather than as "no known vulnerabilities".
    expect(statusOf()).toBe('partial')
  })

  test('queries the commit and attaches commit-sourced matches', async () => {
    const client = new OsvClient({
      transport: {
        post: (path) => {
          if (path === '/v1/query') {
            return Promise.resolve({
              vulns: [{ id: 'GHSA-fix', summary: 'fixed by this commit' }],
            })
          }
          return Promise.resolve({ results: [{ vulns: [] }, { vulns: [] }] })
        },
        get: (path) => Promise.resolve({ id: path.replace('/v1/vulns/', '') }),
      },
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: MANIFESTS,
      targetId: 'target-1',
      commitSha: 'abc123',
      client,
      db,
      readFile,
    })

    expect(result.commitMatches).toHaveLength(1)
    expect(result.commitMatches[0]!.vulns[0]!.id).toBe('GHSA-fix')
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM osv_matches WHERE source = 'commit'",
        )
        .get()!.n,
    ).toBe(1)
  })

  test('re-running replaces rows instead of duplicating them', async () => {
    const client = new OsvClient({
      transport: transportFor(
        [{ vulns: [{ id: 'GHSA-left-pad' }] }, {}],
        { 'GHSA-left-pad': { id: 'GHSA-left-pad', summary: 'x' } },
      ),
    })

    const run = () =>
      correlateWithOsv({
        targetRoot: '/virtual',
        manifests: MANIFESTS,
        targetId: 'target-1',
        commitSha: 'unknown',
        client,
        db,
        readFile,
      })

    await run()
    const first = readCorrelationSummary(db, 'target-1')
    await run()

    expect(readCorrelationSummary(db, 'target-1')).toEqual(first)
  })

  test('enrich: false keeps hits as id-only records and makes no detail request', async () => {
    let detailCalls = 0
    const client = new OsvClient({
      transport: {
        post: () =>
          Promise.resolve({ results: [{ vulns: [{ id: 'GHSA-a', modified: 'm' }] }, {}] }),
        get: () => {
          detailCalls += 1
          return Promise.resolve({ id: 'x' })
        },
      },
    })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: [MANIFESTS[0]!, MANIFESTS[1]!, MANIFESTS[3]!],
      targetId: 'target-1',
      commitSha: 'unknown',
      client,
      enrich: false,
      db,
      readFile,
    })

    expect(detailCalls).toBe(0)
    expect(result.packageMatches[0]!.vulns[0]).toEqual({
      id: 'GHSA-a',
      modified: 'm',
    })
    expect(readCorrelationSummary(db, 'target-1').matches).toBe(1)
  })

  test('without a database the result is still returned, just not persisted', async () => {
    const client = new OsvClient({ transport: transportFor([{ vulns: [] }, {}]) })

    const result = await correlateWithOsv({
      targetRoot: '/virtual',
      manifests: MANIFESTS,
      client,
      readFile,
    })

    expect(result.status).toBe('complete')
    expect(statusOf()).toBeNull()
  })
})
