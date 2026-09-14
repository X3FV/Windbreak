import { describe, expect, test } from 'bun:test'

import { chatThemes } from '../../utils/theme-system'
import {
  WINDBREAK_COLOR_KEYS,
  WINDBREAK_THEME_NAMES,
  nextWindbreakTheme,
  resolveWindbreakColors,
  windbreakPalette,
} from '../theme'

import type { ChatTheme } from '../../types/theme-system'
import type { WindbreakColors, WindbreakThemeName } from '../theme'

const dark: ChatTheme = chatThemes.dark

describe('windbreakPalette', () => {
  test('every element has a colour, for every variant', () => {
    for (const variant of WINDBREAK_THEME_NAMES) {
      const colors = windbreakPalette(dark, variant)
      for (const key of WINDBREAK_COLOR_KEYS) {
        expect(typeof colors[key]).toBe('string')
        expect(colors[key].length).toBeGreaterThan(0)
      }
    }
  })

  test('the allowlist covers every field of the palette', () => {
    // Guards the one failure a hand-maintained list actually makes: a colour
    // added to the interface and forgotten here, which would silently be
    // un-overridable.
    const colors = windbreakPalette(dark, 'default')
    const fields = (Object.keys(colors) as (keyof WindbreakColors)[]).sort()
    expect([...WINDBREAK_COLOR_KEYS].sort()).toEqual(fields)
  })

  test('a light terminal produces a different palette from a dark one', () => {
    const light = windbreakPalette(chatThemes.light, 'default')
    const colors = windbreakPalette(dark, 'default')
    expect(light).not.toEqual(colors)
  })

  test('contrast raises the chrome that default leaves muted', () => {
    const base = windbreakPalette(dark, 'default')
    const contrast = windbreakPalette(dark, 'contrast')

    expect(contrast.frame).toBe(dark.foreground)
    expect(contrast.detailMuted).toBe(dark.foreground)
    expect(contrast.hintsText).toBe(dark.foreground)
    expect(contrast.frame).not.toBe(base.frame)
  })

  test('reading lets the frames and the evidence recede', () => {
    const base = windbreakPalette(dark, 'default')
    const reading = windbreakPalette(dark, 'reading')

    expect(reading.evidenceText).toBe(dark.muted)
    expect(reading.headerText).toBe(dark.muted)
    expect(reading.evidenceText).not.toBe(base.evidenceText)
  })

  test('the verdict colours keep their meaning in every variant', () => {
    // The one thing a variant must never do is make `real` and `benign` look
    // alike: that distinction is the reason the screen exists.
    for (const variant of WINDBREAK_THEME_NAMES) {
      const colors = windbreakPalette(dark, variant)
      expect(colors.realText).not.toBe(colors.benignText)
    }
  })
})

describe('resolveWindbreakColors', () => {
  const base = windbreakPalette(dark, 'default')

  test('no overrides is the variant exactly', () => {
    expect(resolveWindbreakColors(dark, 'default', undefined)).toEqual(base)
    expect(resolveWindbreakColors(dark, 'default', {})).toEqual(base)
  })

  test('an override wins for its own element and leaves the rest alone', () => {
    const colors = resolveWindbreakColors(dark, 'default', {
      detailRule: '#ff00ff',
    })

    expect(colors.detailRule).toBe('#ff00ff')
    expect(colors.detailText).toBe(base.detailText)
  })

  test('overrides stack on a variant rather than replacing it', () => {
    const colors = resolveWindbreakColors(dark, 'contrast', {
      queueText: '#123456',
    })

    expect(colors.queueText).toBe('#123456')
    expect(colors.frame).toBe(dark.foreground)
  })

  test('a value that is not a colour is ignored rather than painted', () => {
    const colors = resolveWindbreakColors(dark, 'default', {
      detailRule: '',
      queueText: 'has space',
      frame: 'a\nb',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hintsText: 42 as any,
    })

    expect(colors.detailRule).toBe(base.detailRule)
    expect(colors.queueText).toBe(base.queueText)
    expect(colors.frame).toBe(base.frame)
    expect(colors.hintsText).toBe(base.hintsText)
  })

  test('an unknown element name does not land in the palette', () => {
    const colors = resolveWindbreakColors(dark, 'default', {
      notAnElement: '#ffffff',
    } as Partial<WindbreakColors>)

    expect(Object.keys(colors).sort()).toEqual(Object.keys(base).sort())
  })
})

describe('nextWindbreakTheme', () => {
  test('walks every variant and wraps', () => {
    const seen: WindbreakThemeName[] = []
    let current: WindbreakThemeName = WINDBREAK_THEME_NAMES[0]!
    for (let step = 0; step < WINDBREAK_THEME_NAMES.length; step += 1) {
      seen.push(current)
      current = nextWindbreakTheme(current)
    }

    expect(seen).toEqual([...WINDBREAK_THEME_NAMES])
    expect(current).toBe(WINDBREAK_THEME_NAMES[0]!)
  })

  test('an unknown value starts the cycle', () => {
    expect(nextWindbreakTheme('nope' as WindbreakThemeName)).toBe(
      WINDBREAK_THEME_NAMES[0]!,
    )
  })
})
