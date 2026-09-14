import { describe, expect, test } from 'bun:test'

import {
  findRediscovery,
  knownVulnFromRow,
  symbolsFromSnippet,
} from './rediscovery'

const record = (overrides: Partial<Parameters<typeof findRediscovery>[0]['records'][number]> = {}) => ({
  vulnId: 'GHSA-1234-5678-9abc',
  aliases: [],
  summary: null,
  ...overrides,
})

describe('findRediscovery', () => {
  test('matches when the advisory names the file path', () => {
    const match = findRediscovery({
      filePath: 'src/http.c',
      cwe: 'CWE-120',
      symbols: [],
      records: [
        record({ summary: 'out-of-bounds write in src/http.c when copying headers' }),
      ],
    })

    expect(match?.vulnId).toBe('GHSA-1234-5678-9abc')
    expect(match?.signals).toEqual(['file-path:src/http.c'])
    expect(match?.basis).toContain('GHSA-1234-5678-9abc')
  })

  test('matches when the advisory names a project symbol from the index', () => {
    const match = findRediscovery({
      filePath: 'src/other.c',
      cwe: null,
      symbols: ['parse_header'],
      records: [record({ details: 'parse_header failed to bound the copy' })],
    })

    expect(match?.signals).toEqual(['symbol:parse_header'])
  })

  test('does NOT match on a shared CWE alone', () => {
    // The important property: routing a real bug away from verification on a
    // coincidental class match would be a silent recall loss.
    const match = findRediscovery({
      filePath: 'src/unrelated.c',
      cwe: 'CWE-120',
      symbols: ['process_thing'],
      records: [
        record({
          summary: 'buffer overflow',
          aliases: ['CVE-2020-0001'],
          details: 'a CWE-120 issue elsewhere',
        }),
      ],
    })

    expect(match).toBeNull()
  })

  test('ignores a short generic basename that would match half the database', () => {
    const match = findRediscovery({
      filePath: 'a.c',
      cwe: null,
      symbols: [],
      records: [record({ details: 'issue in a.c' })],
    })

    expect(match).toBeNull()
  })

  test('matches a bare basename once it is long enough to be specific', () => {
    const match = findRediscovery({
      filePath: 'wp-login.php',
      cwe: null,
      symbols: [],
      records: [record({ details: 'auth bypass in wp-login.php' })],
    })

    expect(match?.signals).toEqual(['basename:wp-login.php'])
  })

  test('requires a word boundary, not a substring', () => {
    const match = findRediscovery({
      filePath: 'src/http.c',
      cwe: null,
      symbols: [],
      records: [record({ details: 'src/http-client.c is affected' })],
    })

    expect(match).toBeNull()
  })

  test('returns null with no records or no file path', () => {
    expect(
      findRediscovery({ filePath: 'src/http.c', cwe: null, symbols: [], records: [] }),
    ).toBeNull()
    expect(
      findRediscovery({
        filePath: null,
        cwe: null,
        symbols: [],
        records: [record({ summary: 'anything' })],
      }),
    ).toBeNull()
  })
})

describe('symbolsFromSnippet', () => {
  test('extracts call names and skips libc noise', () => {
    const symbols = symbolsFromSnippet('strcpy(dst, src);\nparse_header(buf);')

    expect(symbols).toContain('parse_header')
    expect(symbols).not.toContain('strcpy')
  })

  test('returns nothing for a null snippet', () => {
    expect(symbolsFromSnippet(null)).toEqual([])
  })
})

describe('knownVulnFromRow', () => {
  test('reads aliases and details out of the stored row', () => {
    const record = knownVulnFromRow({
      vuln_id: 'GHSA-1',
      aliases_json: '["CVE-2020-1"]',
      summary: 'a summary',
      raw_json: '{"id":"GHSA-1","details":"long prose"}',
    })

    expect(record).toEqual({
      vulnId: 'GHSA-1',
      aliases: ['CVE-2020-1'],
      summary: 'a summary',
      details: 'long prose',
    })
  })

  test('survives malformed aliases and raw JSON', () => {
    const record = knownVulnFromRow({
      vuln_id: 'GHSA-2',
      aliases_json: 'not json',
      summary: null,
      raw_json: 'not json',
    })

    expect(record.aliases).toEqual([])
    expect(record.details).toBeNull()
  })
})
