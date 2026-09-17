import { describe, expect, test } from 'bun:test'

import {
  BRAND,
  BRAND_NAME_UPPER,
  MONOGRAM_TEXT,
  WORDMARK_ROWS,
  WORDMARK_TEXT,
  resolveBrand,
} from '../brand'
import { IS_FREEBUFF } from '../constants'
import { findWindbreakCommand } from '../windbreak-launch'
import { SHADOW_CHARS } from '../../login/constants'

/**
 * The number of rows the landing screen's layout reserves for the logo
 * (`freebuff-landing-screen`'s height budget). Pinned here because the two are
 * coupled by that budget rather than by code: a mark taller than this would be
 * drawn into space the screen has already spent on something else.
 */
const LANDING_RESERVED_LOGO_ROWS = 6

const IDENTITIES = [
  resolveBrand(true, true), // the shipped Freebuff build, run as `windbreak`
  resolveBrand(false, true), // the shipped Freebuff build, run plainly
  resolveBrand(false, false), // the non-Freebuff build
] as const

describe('resolveBrand', () => {
  test('a windbreak invocation draws Windbreak in either build', () => {
    expect(resolveBrand(true, true).name).toBe('Windbreak')
    // The subcommand is the fork's, not the build's: a codebuff build asked to
    // work the queue should say so rather than claim to be upstream.
    expect(resolveBrand(true, false).name).toBe('Windbreak')
  })

  test('a plain invocation keeps the build it came from', () => {
    expect(resolveBrand(false, true).name).toBe('Freebuff')
    expect(resolveBrand(false, false).name).toBe('Codebuff')
  })

  test('only the fork restyles the chat header', () => {
    // The tagline line under the wordmark is part of the fork's restyle, so it
    // must not appear on either upstream identity's header.
    expect(resolveBrand(true, true).headerTagline).toBe(true)
    expect(resolveBrand(false, true).headerTagline).toBe(false)
    expect(resolveBrand(false, false).headerTagline).toBe(false)
  })

  test('the upstream identities keep the accent they had', () => {
    // The palette is the part of a rebrand users notice first, so this is the
    // assertion that the fork's cyan has not leaked into the other two.
    expect(resolveBrand(false, true).accent).toBe('#9EFC62')
    expect(resolveBrand(false, false).accent).toBe('#9EFC62')
    expect(resolveBrand(true, true).accent).not.toBe('#9EFC62')
  })
})

describe('the live brand', () => {
  test('follows the invocation rule for this process', () => {
    expect(BRAND).toBe(
      resolveBrand(findWindbreakCommand(process.argv) !== null, IS_FREEBUFF),
    )
  })

  test('the derived exports are read from it', () => {
    expect(WORDMARK_ROWS).toBe(BRAND.wordmark.length)
    expect(WORDMARK_TEXT).toBe(BRAND.wordmark.join('\n'))
    expect(MONOGRAM_TEXT).toBe(BRAND.monogram.join('\n'))
    // The sentinel `use-logo` compares against, so it has to be the live name.
    expect(BRAND_NAME_UPPER).toBe(BRAND.name.toUpperCase())
  })
})

describe('every identity', () => {
  test('draws a mark that fits the landing screen budget', () => {
    for (const brand of IDENTITIES) {
      expect(brand.wordmark, brand.name).toHaveLength(LANDING_RESERVED_LOGO_ROWS)
      expect(brand.monogram, brand.name).toHaveLength(LANDING_RESERVED_LOGO_ROWS)
    }
  })

  test('has somewhere for the accent colour to appear', () => {
    // `use-logo` gives `█` the block colour and reaches the accent only through
    // `SHADOW_CHARS`. A mark drawn purely from blocks therefore renders
    // monochrome, which is exactly how the fork's first mark was wrong.
    for (const brand of IDENTITIES) {
      const art = [...brand.wordmark, ...brand.monogram].join('')
      const hasShadow = [...art].some((char) => SHADOW_CHARS.has(char))
      expect(hasShadow, `${brand.name} has no shadow characters`).toBe(true)
    }
  })

  test('every row of the mark is non-empty', () => {
    for (const brand of IDENTITIES) {
      for (const row of [...brand.wordmark, ...brand.monogram]) {
        expect(row.trim().length, `${brand.name} has a blank row`).toBeGreaterThan(
          0,
        )
      }
    }
  })
})
