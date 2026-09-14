import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_WINDBREAK_PREFERENCES,
  isWindbreakLayout,
  isWindbreakThemeName,
  parseWindbreakPreferences,
} from '../preferences'

import type { WindbreakPreferences } from '../preferences'

describe('parseWindbreakPreferences', () => {
  test('nothing saved is the default', () => {
    for (const raw of [undefined, null, 'auto', 7, []]) {
      expect(parseWindbreakPreferences(raw)).toEqual(DEFAULT_WINDBREAK_PREFERENCES)
    }
  })

  test('a settings file written before this key existed parses to the default', () => {
    // `{}` is what an older settings file looks like to this parser.
    expect(parseWindbreakPreferences({})).toEqual(DEFAULT_WINDBREAK_PREFERENCES)
  })

  test('a saved choice round-trips', () => {
    const saved: WindbreakPreferences = {
      layout: 'split',
      theme: 'contrast',
      queueWidth: 40,
      decisionWidth: 26,
      colors: { detailRule: '#ff00ff', frame: 'blue' },
    }

    expect(parseWindbreakPreferences(saved)).toEqual(saved)
  })

  test('an unknown arrangement or palette falls back on its own, not as a whole', () => {
    // A hand-edited file that got the theme wrong should not also discard a
    // perfectly good layout choice.
    expect(parseWindbreakPreferences({ layout: 'grid', theme: 'reading' })).toEqual({
      ...DEFAULT_WINDBREAK_PREFERENCES,
      theme: 'reading',
    })
    expect(parseWindbreakPreferences({ layout: 'columns', theme: 'neon' })).toEqual({
      ...DEFAULT_WINDBREAK_PREFERENCES,
      layout: 'columns',
    })
  })

  test('a width that is not a positive number is dropped, not coerced', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '40', null, {}]) {
      const parsed = parseWindbreakPreferences({ queueWidth: bad, decisionWidth: bad })
      expect(parsed.queueWidth).toBeUndefined()
      expect(parsed.decisionWidth).toBeUndefined()
    }
  })

  test('a fractional width is rounded rather than rejected', () => {
    expect(parseWindbreakPreferences({ queueWidth: 33.7 }).queueWidth).toBe(34)
  })

  test('colours are allowlisted by element name', () => {
    const parsed = parseWindbreakPreferences({
      colors: { detailRule: '#fff', notAnElement: '#000' },
    })

    expect(parsed.colors).toEqual({ detailRule: '#fff' })
  })

  test('a colour that could break a frame is dropped', () => {
    const parsed = parseWindbreakPreferences({
      colors: {
        frame: '',
        title: 'has space',
        headerText: 'a\nb',
        hintsText: 'x'.repeat(65),
        queueText: '#00ff00',
      },
    })

    expect(parsed.colors).toEqual({ queueText: '#00ff00' })
  })

  test('a colours block with nothing usable in it is absent, not empty', () => {
    expect(parseWindbreakPreferences({ colors: { nope: 'x' } }).colors).toBeUndefined()
    expect(parseWindbreakPreferences({ colors: 'red' }).colors).toBeUndefined()
    expect(parseWindbreakPreferences({ colors: ['#fff'] }).colors).toBeUndefined()
  })
})

describe('the type guards', () => {
  test('accept exactly the vocabularies they name', () => {
    expect(isWindbreakLayout('columns')).toBe(true)
    expect(isWindbreakLayout('grid')).toBe(false)
    expect(isWindbreakLayout(1)).toBe(false)

    expect(isWindbreakThemeName('reading')).toBe(true)
    expect(isWindbreakThemeName('neon')).toBe(false)
    expect(isWindbreakThemeName(null)).toBe(false)
  })
})
