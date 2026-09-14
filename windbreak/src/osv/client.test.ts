import { describe, expect, test } from 'bun:test'

import {
  OsvClient,
  OsvHttpError,
  OsvUnavailableError,
  toVulnDetail,
} from './client'

import type { OsvTransport } from './types'

/** Records every request and replays scripted responses in order. */
const scriptedTransport = (
  responses: Array<unknown | Error>,
): { transport: OsvTransport; calls: Array<{ method: string; path: string; body?: unknown }> } => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  let index = 0

  const next = (method: string, path: string, body?: unknown): unknown => {
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) })
    const response = responses[index++]
    if (response instanceof Error) throw response
    return response
  }

  return {
    calls,
    transport: {
      post: (path, body) => Promise.resolve(next('POST', path, body)),
      get: (path) => Promise.resolve(next('GET', path)),
    },
  }
}

describe('toVulnDetail', () => {
  test('keeps only the fields the pipeline reads', () => {
    const detail = toVulnDetail({
      id: 'GHSA-xxxx',
      summary: 'summary',
      details: 'details',
      aliases: ['CVE-2024-1', 42],
      severity: [{ type: 'CVSS_V3', score: '9.8' }, { type: 'BROKEN' }],
      database_specific: { severity: 'CRITICAL' },
      extra: 'dropped',
    })

    expect(detail).toEqual({
      id: 'GHSA-xxxx',
      summary: 'summary',
      details: 'details',
      aliases: ['CVE-2024-1'],
      severity: [{ type: 'CVSS_V3', score: '9.8' }],
      databaseSpecific: { severity: 'CRITICAL' },
    })
  })

  test('rejects a record with no id', () => {
    expect(toVulnDetail({ summary: 'x' })).toBeNull()
    expect(toVulnDetail(null)).toBeNull()
  })
})

describe('OsvClient.queryPackageBatch', () => {
  test('sends package + version + ecosystem and keeps results positionally aligned', async () => {
    const { transport, calls } = scriptedTransport([
      {
        results: [
          { vulns: [{ id: 'GHSA-a', modified: '2024-01-01T00:00:00Z' }] },
          {},
          { vulns: [{ id: 'GHSA-b' }, { id: 'GHSA-c' }] },
        ],
      },
    ])

    const client = new OsvClient({ transport })
    const results = await client.queryPackageBatch([
      { name: 'a', ecosystem: 'npm', version: '1.0.0' },
      { name: 'b', ecosystem: 'npm', version: '2.0.0' },
      { name: 'c', ecosystem: 'PyPI', version: '3.0.0' },
    ])

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/v1/querybatch',
        body: {
          queries: [
            { package: { name: 'a', ecosystem: 'npm' }, version: '1.0.0' },
            { package: { name: 'b', ecosystem: 'npm' }, version: '2.0.0' },
            { package: { name: 'c', ecosystem: 'PyPI' }, version: '3.0.0' },
          ],
        },
      },
    ])

    expect(results[0]).toEqual([{ id: 'GHSA-a', modified: '2024-01-01T00:00:00Z' }])
    expect(results[1]).toEqual([])
    expect(results[2]!.map((ref) => ref.id)).toEqual(['GHSA-b', 'GHSA-c'])
  })

  test('refuses to align a response whose length differs from the batch', async () => {
    const { transport } = scriptedTransport([{ results: [{ vulns: [] }] }])
    const client = new OsvClient({ transport })

    await expect(
      client.queryPackageBatch([
        { name: 'a', ecosystem: 'npm', version: '1.0.0' },
        { name: 'b', ecosystem: 'npm', version: '2.0.0' },
      ]),
    ).rejects.toThrow(OsvUnavailableError)
  })

  test('batches larger query sets', async () => {
    const { transport, calls } = scriptedTransport([
      { results: [{ vulns: [] }, { vulns: [] }] },
      { results: [{ vulns: [] }] },
    ])

    const client = new OsvClient({ transport, batchSize: 2 })
    const queries = [1, 2, 3].map((n) => ({
      name: `p${n}`,
      ecosystem: 'npm',
      version: '1.0.0',
    }))

    const results = await client.queryPackageBatch(queries)

    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(3)
  })

  test('retries a 5xx then succeeds', async () => {
    const { transport, calls } = scriptedTransport([
      new OsvHttpError(503, '/v1/querybatch', 'unavailable'),
      { results: [{ vulns: [{ id: 'GHSA-a' }] }] },
    ])

    const client = new OsvClient({
      transport,
      maxRetries: 2,
      sleep: async () => {},
    })

    const results = await client.queryPackageBatch([
      { name: 'a', ecosystem: 'npm', version: '1.0.0' },
    ])

    expect(calls).toHaveLength(2)
    expect(results[0]![0]!.id).toBe('GHSA-a')
  })

  test('does not retry a 400', async () => {
    const { transport, calls } = scriptedTransport([
      new OsvHttpError(400, '/v1/querybatch', 'bad request'),
    ])

    const client = new OsvClient({
      transport,
      maxRetries: 3,
      sleep: async () => {},
    })

    await expect(
      client.queryPackageBatch([{ name: 'a', ecosystem: 'npm', version: '1.0.0' }]),
    ).rejects.toThrow(OsvHttpError)

    expect(calls).toHaveLength(1)
  })
})

describe('OsvClient.getVuln', () => {
  test('returns null on 404 rather than throwing', async () => {
    const { transport } = scriptedTransport([
      new OsvHttpError(404, '/v1/vulns/X', 'not found'),
    ])

    const client = new OsvClient({ transport, sleep: async () => {} })

    expect(await client.getVuln('X')).toBeNull()
  })

  test('fetches a full record', async () => {
    const { transport, calls } = scriptedTransport([
      { id: 'GHSA-a', summary: 'a bug' },
    ])

    const client = new OsvClient({ transport })
    const detail = await client.getVuln('GHSA-a')

    expect(detail?.summary).toBe('a bug')
    expect(calls[0]).toEqual({ method: 'GET', path: '/v1/vulns/GHSA-a' })
  })
})

describe('OsvClient.queryCommit', () => {
  test('posts the commit and returns full vulns', async () => {
    const { transport, calls } = scriptedTransport([
      { vulns: [{ id: 'GHSA-a', summary: 'fixed by this commit' }] },
    ])

    const client = new OsvClient({ transport })
    const vulns = await client.queryCommit('abc123')

    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/v1/query',
      body: { commit: 'abc123' },
    })
    expect(vulns).toEqual([
      { id: 'GHSA-a', summary: 'fixed by this commit' },
    ])
  })
})
