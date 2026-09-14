import { describe, expect, test } from 'bun:test'

import { buildHintLine, shortenPath, truncateEnd, wrapText } from '../text'

describe('wrapText', () => {
  test('breaks prose on spaces', () => {
    expect(wrapText('the check happens after the copy', 12)).toEqual([
      'the check',
      'happens',
      'after the',
      'copy',
    ])
  })

  test('honours the newlines in a snippet, because they are the evidence', () => {
    expect(wrapText('char buf[32];\n  strcpy(buf, line);', 40)).toEqual([
      'char buf[32];',
      '  strcpy(buf, line);',
    ])
  })

  test('breaks a token longer than the pane rather than letting it overflow', () => {
    expect(wrapText('averyverylongidentifier', 8)).toEqual([
      'averyver',
      'ylongide',
      'ntifier',
    ])
  })

  test('empty input renders nothing rather than a blank row', () => {
    expect(wrapText('', 10)).toEqual([])
    expect(wrapText('   ', 10)).toEqual([])
    expect(wrapText('\n\n', 10)).toEqual([])
  })

  test('a width below one column is clamped instead of looping', () => {
    expect(wrapText('ab', 0)).toEqual(['a', 'b'])
  })

  test('keeps a long paragraph within the width', () => {
    const text = 'the buffer is written before the length is checked at all'
    for (const line of wrapText(text, 16)) {
      expect(line.length).toBeLessThanOrEqual(16)
    }
  })
})

describe('truncateEnd', () => {
  test('leaves text that fits alone', () => {
    expect(truncateEnd('src/handler.c:6', 30)).toBe('src/handler.c:6')
    expect(truncateEnd('exactly-ten', 11)).toBe('exactly-ten')
  })

  test('marks the cut, so a clipped row does not read as a shorter name', () => {
    expect(truncateEnd('semgrep/wb-c-unbounded-string-op', 20)).toBe('semgrep/wb-c-unboun…')
    expect(truncateEnd('semgrep/wb-c-unbounded-string-op', 20)).toHaveLength(20)
  })

  test('a single column is the mark itself', () => {
    expect(truncateEnd('abc', 1)).toBe('…')
    expect(truncateEnd('abc', 0)).toBe('…')
  })
})

describe('buildHintLine', () => {
  const at = (columns: number, includeResolved = false) =>
    buildHintLine({
      columns,
      includeResolved,
      layoutLabel: 'three panes',
      themeLabel: 'reading',
    })

  test('a wide terminal gets the whole vocabulary', () => {
    const line = at(160)
    expect(line).toContain('wheel scrolls')
    expect(line).toContain('PgUp/PgDn argument')
    expect(line).toContain('L three panes')
    expect(line).toContain('t reading')
  })

  test('every tier fits the terminal it was chosen for', () => {
    // The renderer clips a long <text> from the left, so a tier that overflows
    // loses the movement keys and keeps `q quit` — the wrong half.
    for (const columns of [40, 52, 60, 72, 80, 92, 110, 126, 200]) {
      expect(at(columns).length).toBeLessThanOrEqual(columns - 2)
    }
  })

  test('a long arrangement name costs the detail, not the keys', () => {
    // Measured, not thresholded: the label the researcher chose is part of the
    // line, so `L queue + detail` needs a wider terminal than `L auto`.
    const short = buildHintLine({
      columns: 80,
      includeResolved: false,
      layoutLabel: 'auto',
      themeLabel: 'default',
    })
    const long = buildHintLine({
      columns: 80,
      includeResolved: false,
      layoutLabel: 'queue + detail',
      themeLabel: 'contrast',
    })

    expect(short.length).toBeLessThanOrEqual(78)
    expect(long.length).toBeLessThanOrEqual(78)
    expect(short).toContain('L auto')
  })

  test('the keys a researcher cannot guess survive every tier', () => {
    for (const columns of [40, 60, 72, 92, 126]) {
      const line = at(columns)
      const namesDecisions =
        line.includes('r/b') || (line.includes('r real') && line.includes('b benign'))
      expect(namesDecisions).toBe(true)
      expect(line).toContain('L')
      expect(line).toContain('t')
      expect(line).toContain('q')
    }
  })

  test('a narrow terminal keeps the labels and the narrowest does not', () => {
    expect(at(80)).toContain('L three panes')
    expect(at(40)).not.toContain('three panes')
  })

  test('what `a` does is named, and flips with the filter', () => {
    expect(at(160, false)).toContain('a all')
    expect(at(160, true)).toContain('a pending')
    expect(at(80, true)).toContain('a pending')
  })
})

describe('shortenPath', () => {
  test('keeps the tail of a deep path', () => {
    expect(shortenPath('/home/researcher/projects/a/src/handler.c', 3)).toBe(
      '…/a/src/handler.c',
    )
  })

  test('leaves a short path alone', () => {
    expect(shortenPath('src/handler.c', 3)).toBe('src/handler.c')
  })
})
