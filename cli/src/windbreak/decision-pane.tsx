import React from 'react'

import { BORDER_CHARS } from '../utils/ui-constants'

import { useWindbreakColors } from './colors-context'

import type { DecisionLine, DecisionSpan, DecisionTone } from './decision-lines'
import type { WindbreakColors } from './theme'

interface DecisionPaneProps {
  /** The card's rows, with `rationaleRow` naming where the input goes. */
  lines: DecisionLine[]
  rationaleRow: number | null
  /** Content rows the pane can show. */
  height: number
  width: number
  /** The rationale input's state, live only while a decision is staged. */
  rationale: string
  onRationaleInput: (value: string) => void
  onRationaleSubmit: () => void
  /** Draws the frame in the focused colour. */
  focused: boolean
}

const toneColor = (tone: DecisionTone, colors: WindbreakColors): string => {
  switch (tone) {
    case 'label':
      return colors.decisionLabel
    case 'value':
      return colors.detailText
    case 'muted':
      return colors.decisionMeta
    case 'idle':
      return colors.decisionIdle
    case 'notice':
      return colors.decisionNotice
    case 'error':
      return colors.decisionError
    case 'real':
      return colors.decisionReal
    case 'benign':
      return colors.decisionBenign
    case 'rule':
      return colors.detailRule
  }
}

const Span: React.FC<{ span: DecisionSpan; colors: WindbreakColors }> = ({
  span,
  colors,
}) => <span style={{ fg: toneColor(span.tone, colors) }}>{span.text}</span>

/**
 * The third pane: the decision card (spec §20.16).
 *
 * It is the acting surface, not a second reading surface. The arguments are the
 * detail pane's job; this one holds the candidate's identity, the staged
 * decision, the rationale input, what was recorded last, and the counters — so a
 * researcher who has finished reading never has to look away from the card to
 * act on what they read.
 *
 * The card does not scroll. It is a fixed handful of fields, and a scrolling
 * decision card would mean a researcher could agree with an argument and not see
 * the control that records it.
 */
export const DecisionPane: React.FC<DecisionPaneProps> = ({
  lines,
  rationaleRow,
  height,
  width,
  rationale,
  onRationaleInput,
  onRationaleSubmit,
  focused,
}) => {
  const colors = useWindbreakColors()

  const visible = lines.slice(0, height)

  return (
    <box
      title=" Decision "
      style={{
        width,
        height: height + 2,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: focused ? colors.frameFocused : colors.frame,
        titleColor: colors.title,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {visible.map((line, index) => {
        if (rationaleRow === index) {
          return (
            <input
              key={`rationale-${index}`}
              value={rationale}
              focused={focused}
              // Deliberately short: the card above the input carries the keys
              // (`Enter records · Esc cancels`) on wrapped lines, because a
              // placeholder in a twenty-column column is clipped mid-word.
              placeholder="why? (optional)"
              onInput={onRationaleInput}
              onSubmit={onRationaleSubmit}
            />
          )
        }

        return (
          <text key={index} style={{ fg: colors.detailText }}>
            {line.spans.map((span, spanIndex) => (
              <Span key={spanIndex} span={span} colors={colors} />
            ))}
          </text>
        )
      })}
    </box>
  )
}
