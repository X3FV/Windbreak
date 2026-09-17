import { describe, test, expect } from 'bun:test'

import {
  computeInputLayoutMetrics,
  getLastNVisualLines,
  wrapToVisualLines,
} from '../text-layout'

describe('wrapToVisualLines', () => {
  test('has no rows for empty text', () => {
    expect(wrapToVisualLines('', 40)).toEqual([])
  })

  test('wraps on whitespace, keeping the break a single row', () => {
    expect(wrapToVisualLines('one two three', 7)).toEqual(['one two', ' three'])
  })

  test('hard-wraps a token wider than the terminal', () => {
    expect(wrapToVisualLines('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
  })

  test('breaks on embedded newlines', () => {
    expect(wrapToVisualLines('a\nb', 40)).toEqual(['a', 'b'])
  })

  test('measures wide glyphs as two columns', () => {
    // The counts a view prints beside a list are only true if the wrap agrees with the
    // terminal about how much room a character takes.
    expect(wrapToVisualLines('日本語', 4)).toEqual(['日本', '語'])
  })
})

describe('getLastNVisualLines', () => {
  test('returns nothing for empty text, so "is there anything to show" stays answerable', () => {
    expect(getLastNVisualLines('', 40, 5)).toEqual({ lines: [], hasMore: false })
  })

  test('keeps the last rows and says whether it dropped any', () => {
    expect(getLastNVisualLines('a\nb\nc\nd\ne', 80, 2)).toEqual({
      lines: ['d', 'e'],
      hasMore: true,
    })
  })

  test('reports no truncation when the text fits', () => {
    expect(getLastNVisualLines('a\nb', 80, 10)).toEqual({
      lines: ['a', 'b'],
      hasMore: false,
    })
  })

  test('takes no rows for a non-positive row budget', () => {
    expect(getLastNVisualLines('a\nb', 80, 0)).toEqual({ lines: [], hasMore: false })
  })
})

describe('computeInputLayoutMetrics', () => {
  test('single-line content keeps height at 1 without gutter', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'hello world',
      cursorProbe: 'hello world',
      cols: 40,
      maxHeight: 5,
    })

    expect(metrics.heightLines).toBe(1)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('counts leading indentation toward wrapped line width', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: '    indent',
      cursorProbe: '    indent',
      cols: 8,
      maxHeight: 2,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('adds gutter when two lines and cursor on second line', () => {
    const layoutContent = 'first line\nsecond line'
    const cursorProbe = 'first line\nsecond line'

    const metrics = computeInputLayoutMetrics({
      layoutContent,
      cursorProbe,
      cols: 40,
      maxHeight: 5,
    })

    expect(metrics.heightLines).toBe(3)
    expect(metrics.gutterEnabled).toBe(true)
  })

  test('omits gutter when maxHeight would be exceeded', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'a long first line\nand a second line',
      cursorProbe: 'a long first line\nand a second line',
      cols: 80,
      maxHeight: 2,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('respects a minimum height constraint', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'short',
      cursorProbe: 'short',
      cols: 40,
      maxHeight: 5,
      minHeight: 3,
    })

    expect(metrics.heightLines).toBe(3)
    expect(metrics.gutterEnabled).toBe(false)
  })

  test('caps the minimum height at the max height', () => {
    const metrics = computeInputLayoutMetrics({
      layoutContent: 'tiny',
      cursorProbe: 'tiny',
      cols: 40,
      maxHeight: 2,
      minHeight: 5,
    })

    expect(metrics.heightLines).toBe(2)
    expect(metrics.gutterEnabled).toBe(false)
  })
})
