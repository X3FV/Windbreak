import { describe, expect, test } from 'bun:test'

import {
  COLUMN_CHROME_ROWS,
  DEFAULT_DECISION_WIDTH,
  DEFAULT_QUEUE_WIDTH,
  LAYOUT_ORDER,
  MIN_CARD_ROWS,
  MIN_DECISION_WIDTH,
  MIN_DETAIL_WIDTH,
  MIN_PANE_ROWS,
  MIN_QUEUE_WIDTH,
  PANE_FRAME_ROWS,
  computeColumnPlan,
  nextLayout,
  resolveLayoutMode,
} from '../layout'

import type { LayoutInput, WindbreakLayout } from '../layout'

const at = (
  columns: number,
  rows = 40,
  layout: WindbreakLayout = 'auto',
  extra: Partial<LayoutInput> = {},
): LayoutInput => ({ columns, rows, layout, ...extra })

describe('resolveLayoutMode', () => {
  test('a wide terminal gets three panes without being asked', () => {
    expect(resolveLayoutMode(at(120))).toBe('columns')
  })

  test('the queue and the decision column are held before the detail is', () => {
    // Three panes need queue + decision + the detail's minimum. One column short
    // of that, the decision column is what gives way — not the argument.
    const needed = DEFAULT_QUEUE_WIDTH + DEFAULT_DECISION_WIDTH + MIN_DETAIL_WIDTH
    expect(resolveLayoutMode(at(needed))).toBe('columns')
    expect(resolveLayoutMode(at(needed - 1))).toBe('split')
  })

  test('a terminal too narrow even for two panes falls back to the stack', () => {
    expect(resolveLayoutMode(at(DEFAULT_QUEUE_WIDTH + MIN_DETAIL_WIDTH))).toBe('split')
    expect(
      resolveLayoutMode(at(DEFAULT_QUEUE_WIDTH + MIN_DETAIL_WIDTH - 1)),
    ).toBe('stacked')
  })

  test('height degrades it too: a short terminal cannot stack side by side', () => {
    const enoughForPanes = MIN_PANE_ROWS + PANE_FRAME_ROWS + COLUMN_CHROME_ROWS
    // Tall enough for the panes but not for the card beneath them.
    expect(resolveLayoutMode(at(120, enoughForPanes))).toBe('columns')
    expect(resolveLayoutMode(at(80, enoughForPanes))).toBe('stacked')
    expect(resolveLayoutMode(at(120, COLUMN_CHROME_ROWS + MIN_PANE_ROWS))).toBe(
      'stacked',
    )
  })

  test('an explicit stacked stays stacked on a wide terminal', () => {
    expect(resolveLayoutMode(at(200, 60, 'stacked'))).toBe('stacked')
  })

  test('an explicit split is honoured while it fits, and degrades when it does not', () => {
    expect(resolveLayoutMode(at(120, 40, 'split'))).toBe('split')
    expect(resolveLayoutMode(at(40, 40, 'split'))).toBe('stacked')
  })

  test('an explicit columns still degrades rather than drawing a zero-width pane', () => {
    // Pinning an arrangement is a preference, not a promise: the screen has to
    // draw something on the terminal it is actually running in.
    expect(resolveLayoutMode(at(120, 40, 'columns'))).toBe('columns')
    expect(resolveLayoutMode(at(80, 40, 'columns'))).toBe('split')
    expect(resolveLayoutMode(at(30, 40, 'columns'))).toBe('stacked')
  })

  test('two panes need room for the card beneath them, three do not', () => {
    const cardBelow =
      MIN_PANE_ROWS + PANE_FRAME_ROWS + MIN_CARD_ROWS + PANE_FRAME_ROWS
    // 80 columns: too few for three panes, enough for two — so the height gate
    // alone decides, because the card has to go under them.
    expect(resolveLayoutMode(at(80, cardBelow + COLUMN_CHROME_ROWS))).toBe('split')
    expect(resolveLayoutMode(at(80, cardBelow + COLUMN_CHROME_ROWS - 1))).toBe(
      'stacked',
    )
    // The same height at 120 columns is fine: there the card is a column and
    // costs no rows at all.
    expect(
      resolveLayoutMode(at(120, cardBelow + COLUMN_CHROME_ROWS - 1)),
    ).toBe('columns')
  })
})

describe('computeColumnPlan', () => {
  test('the detail takes what is left, so a pinned queue cannot starve it', () => {
    const plan = computeColumnPlan(at(120, 40, 'auto', { queueWidth: 200 }))
    expect(plan.detailWidth).toBeGreaterThanOrEqual(MIN_DETAIL_WIDTH)
    expect(plan.queueWidth).toBe(120 - DEFAULT_DECISION_WIDTH - plan.detailWidth)
  })

  test('a pinned queue width is clamped up to the minimum, not rejected', () => {
    const plan = computeColumnPlan(at(120, 40, 'auto', { queueWidth: 2 }))
    expect(plan.queueWidth).toBe(MIN_QUEUE_WIDTH)
  })

  test('a pinned decision width is clamped to its own range', () => {
    expect(computeColumnPlan(at(120, 40, 'auto', { decisionWidth: 5 })).decisionWidth).toBe(
      MIN_DECISION_WIDTH,
    )
    expect(
      computeColumnPlan(at(120, 40, 'auto', { decisionWidth: 500 })).decisionWidth,
    ).toBeLessThan(500)
  })

  test('the three outer widths add up to the terminal exactly', () => {
    for (const columns of [94, 100, 120, 200, 240]) {
      const plan = computeColumnPlan(at(columns))
      expect(plan.mode).toBe('columns')
      expect(plan.queueWidth + plan.detailWidth + plan.decisionWidth).toBe(columns)
    }
  })

  test('a two-pane plan has no decision width', () => {
    const plan = computeColumnPlan(at(80, 40))
    expect(plan.mode).toBe('split')
    expect(plan.decisionWidth).toBe(0)
    expect(plan.queueWidth + plan.detailWidth).toBe(80)
  })

  test('a stacked plan gives every row the full width', () => {
    const plan = computeColumnPlan(at(60, 40))
    expect(plan.mode).toBe('stacked')
    expect(plan.queueWidth).toBe(60)
    expect(plan.detailWidth).toBe(60)
    expect(plan.decisionWidth).toBe(0)
  })

  test('every mode leaves the detail its minimum', () => {
    for (const columns of [40, 60, 62, 80, 93, 94, 120]) {
      const plan = computeColumnPlan(at(columns))
      if (plan.mode === 'stacked') continue
      expect(plan.detailWidth).toBeGreaterThanOrEqual(MIN_DETAIL_WIDTH)
    }
  })
})

describe('nextLayout', () => {
  test('walks every mode and wraps back to the start', () => {
    const seen: WindbreakLayout[] = []
    let current: WindbreakLayout = LAYOUT_ORDER[0]!
    for (let step = 0; step < LAYOUT_ORDER.length; step += 1) {
      seen.push(current)
      current = nextLayout(current)
    }

    expect(seen).toEqual([...LAYOUT_ORDER])
    expect(current).toBe(LAYOUT_ORDER[0]!)
  })

  test('an unknown value starts the cycle rather than getting stuck', () => {
    expect(nextLayout('nonsense' as WindbreakLayout)).toBe(LAYOUT_ORDER[0]!)
  })
})
