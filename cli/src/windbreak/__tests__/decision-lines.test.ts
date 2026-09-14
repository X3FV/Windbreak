import { describe, expect, test } from 'bun:test'

import { buildDecisionCard } from '../decision-lines'

import type { DecisionCardInput, DecisionLine } from '../decision-lines'
import type { ReviewEntrySummary } from '@codebuff/windbreak/review'

const entry: ReviewEntrySummary = {
  candidateId: 'cand-1',
  runId: 'run-1',
  filePath: 'src/handler.c',
  startLine: 6,
  cwe: 'CWE-120',
  source: 'semgrep',
  patternId: 'wb-c-unbounded-string-op',
  decision: null,
  decidedAt: null,
  rationale: null,
}

const input = (overrides: Partial<DecisionCardInput> = {}): DecisionCardInput => ({
  entry,
  candidateState: 'escalated',
  counts: { total: 2, pending: 1, resolved: 1 },
  pendingDecision: null,
  mode: 'browse',
  notice: null,
  includeResolved: false,
  layoutLabel: 'auto',
  themeLabel: 'default',
  contentWidth: 40,
  ...overrides,
})

const textOf = (line: DecisionLine): string =>
  line.spans.map((span) => span.text).join('')
const allText = (lines: DecisionLine[]): string => lines.map(textOf).join('\n')

const toneOfSpan = (lines: DecisionLine[], needle: string) =>
  lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))?.tone

describe('buildDecisionCard', () => {
  test('names the entry, its state, where it is, and what found it', () => {
    const text = allText(buildDecisionCard(input()).lines)

    expect(text).toContain('cand-1  escalated')
    expect(text).toContain('handler.c:6')
    expect(text).toContain('semgrep/wb-c-unbounded-string-op')
  })

  test('with nothing selected it says so rather than showing a blank card', () => {
    const text = allText(buildDecisionCard(input({ entry: null })).lines)
    expect(text).toContain('nothing selected')
    expect(text).not.toContain('cand-1')
  })

  test('a staged decision is toned as the verdict it is', () => {
    const asReal = buildDecisionCard(input({ pendingDecision: 'real' })).lines
    const asBenign = buildDecisionCard(
      input({ pendingDecision: 'benign', mode: 'rationale' }),
    ).lines

    expect(toneOfSpan(asReal, 'real')).toBe('real')
    expect(toneOfSpan(asBenign, 'benign')).toBe('benign')
  })

  test('the rationale row exists only while a decision is staged', () => {
    const staged = buildDecisionCard(
      input({ pendingDecision: 'real', mode: 'rationale' }),
    )
    expect(staged.rationaleRow).not.toBeNull()
    // The row it names exists, so the pane can render the input there and the
    // card's row count stays the truth.
    expect(staged.rationaleRow!).toBeGreaterThanOrEqual(0)
    expect(staged.rationaleRow!).toBeLessThan(staged.lines.length)

    const idle = buildDecisionCard(input())
    expect(idle.rationaleRow).toBeNull()
    expect(allText(idle.lines)).toContain('none staged')
  })

  test('the staged line names the keys, because the input owns the letters', () => {
    const text = allText(
      buildDecisionCard(input({ pendingDecision: 'benign' })).lines,
    )
    expect(text).toContain('benign')
  })

  test('a write that failed is an error tone, and a write that landed is not', () => {
    const failed = buildDecisionCard(
      input({ notice: { text: 'constraint failed on adjudication_queue', failed: true } }),
    ).lines
    const landed = buildDecisionCard(
      input({ notice: { text: 'recorded cand-1 as real', failed: false } }),
    ).lines

    expect(toneOfSpan(failed, 'constraint failed')).toBe('error')
    expect(toneOfSpan(landed, 'recorded')).toBe('notice')
  })

  test('the failure tone comes from the caller, not from the words', () => {
    // A success message that happens to mention an error must not be painted as
    // one — §18's distinction is about the write, not the wording.
    const lines = buildDecisionCard(
      input({ notice: { text: 'recorded cand-1 as real (no error)', failed: false } }),
    ).lines

    expect(toneOfSpan(lines, 'recorded')).toBe('notice')
  })

  test('an empty history says so instead of an empty section', () => {
    expect(allText(buildDecisionCard(input()).lines)).toContain('nothing recorded yet')
  })

  test('the counters are the findings counter', () => {
    const text = allText(buildDecisionCard(input()).lines)
    expect(text).toContain('1 pending · 1 resolved')
  })

  test('the resolved filter is only mentioned when it is on', () => {
    expect(allText(buildDecisionCard(input()).lines)).not.toContain('showing resolved')
    expect(
      allText(buildDecisionCard(input({ includeResolved: true })).lines),
    ).toContain('showing resolved')
  })

  test('the current arrangement and palette are named, with the keys that change them', () => {
    const text = allText(
      buildDecisionCard(input({ layoutLabel: 'three panes', themeLabel: 'reading' }))
        .lines,
    )
    expect(text).toContain('three panes · reading')
    expect(text).toContain('L layout · t theme')
  })

  test('long values wrap to the column instead of running out of it', () => {
    const card = buildDecisionCard(
      input({
        entry: { ...entry, patternId: 'an-extremely-long-pattern-identifier-that-cannot-fit' },
        contentWidth: 24,
      }),
    )

    for (const line of card.lines) {
      expect(textOf(line).length).toBeLessThanOrEqual(24)
    }
    expect(allText(card.lines)).toContain('cannot-fit')
  })

  test('the card never ends on a rule with nothing under it', () => {
    const lines = buildDecisionCard(input()).lines
    expect(lines[lines.length - 1]?.spans[0]?.tone).not.toBe('rule')
  })
})
