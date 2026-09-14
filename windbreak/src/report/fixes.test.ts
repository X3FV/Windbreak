import { describe, expect, test } from 'bun:test'

import { suggestedFixFor } from './fixes'

const suggest = (cwe: string | null, patternId: string | null = null, snippet: string | null = null) =>
  suggestedFixFor({ cwe, patternId, snippet })

describe('suggestedFixFor', () => {
  test('names a concrete change for known buffer classes', () => {
    expect(suggest('CWE-120')).toContain('length-limited copy')
    expect(suggest('CWE-122')).toContain('input length')
    expect(suggest('CWE-476')).toContain('NULL')
    expect(suggest('CWE-416')).toContain('free')
  })

  test('is case- and prefix-insensitive on the CWE', () => {
    expect(suggest('cwe-120')).toBe(suggest('CWE-120'))
    expect(suggest('CWE-134')).toContain('format argument')
  })

  test('falls back to the pattern id when the class is unknown', () => {
    const fix = suggest('CWE-9999', 'wb-c-cwe-120-unbounded')
    expect(fix).toContain('length-limited copy')
  })

  test('refuses to invent a fix for an unfamiliar class', () => {
    const fix = suggest('CWE-9999', 'something-else')

    expect(fix).toContain('No pattern-based fix is known for CWE-9999')
    expect(fix).toContain('Review the call site')
  })

  test('names what it does not know when there is no class at all', () => {
    expect(suggest(null, null)).toContain('No pattern-based fix is known for this class')
  })

  test('never claims certainty about the specific code', () => {
    for (const cwe of ['CWE-120', 'CWE-476', 'CWE-9999', null]) {
      const fix = suggest(cwe)
      expect(fix).not.toMatch(/\bis exploitable\b|\bconfirmed\b/i)
    }
  })
})
