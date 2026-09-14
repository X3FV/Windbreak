import React from 'react'

import { BORDER_CHARS } from '../utils/ui-constants'

import { WHEEL_ROWS } from './actions'
import { useWindbreakColors } from './colors-context'

import type { DetailLine, DetailSpan, DetailTone } from './detail-lines'
import type { WindbreakColors } from './theme'
import type { ReviewEntryDetail } from '@codebuff/windbreak/review'
import type { MouseEvent } from '@opentui/core'

interface DetailPaneProps {
  detail: ReviewEntryDetail | null
  /** The whole content, already wrapped and toned; the pane shows a window of it. */
  lines: DetailLine[]
  /** First visible row of `lines`. */
  offset: number
  /** Rows of content this pane can show. */
  height: number
  width: number
  /** Wheel movement over the pane, in rows (negative is up). */
  onScroll: (delta: number) => void
  emptyMessage: string
}

const toneColor = (tone: DetailTone, colors: WindbreakColors): string => {
  switch (tone) {
    case 'muted':
      return colors.detailMuted
    case 'warning':
      return colors.warningText
    case 'info':
      return colors.roleLabel
    // `real` is the alarming answer on this screen: two providers disagreed and
    // this one says the bug is there.
    case 'real':
      return colors.realText
    case 'benign':
      return colors.benignText
    case 'rule':
      return colors.detailRule
    case 'evidence':
      return colors.evidenceText
    case 'normal':
      return colors.detailText
  }
}

const Span: React.FC<{ span: DetailSpan; colors: WindbreakColors }> = ({
  span,
  colors,
}) => <span style={{ fg: toneColor(span.tone, colors) }}>{span.text}</span>

export const DetailPane: React.FC<DetailPaneProps> = ({
  detail,
  lines,
  offset,
  height,
  width,
  onScroll,
  emptyMessage,
}) => {
  const colors = useWindbreakColors()

  const scrollable = lines.length > height
  const visible = lines.slice(offset, offset + height)
  const lastVisible = Math.min(offset + height, lines.length)

  const title = detail
    ? ` ${detail.summary.filePath ?? '(unknown)'}:${detail.summary.startLine ?? '?'}${
        // The position lives in the title rather than in a row of its own: a
        // "3 more" line would cost one of the rows the pane is scrolling.
        scrollable ? `  lines ${offset + 1}–${lastVisible}/${lines.length}` : ''
      } `
    : ' Disagreement '

  return (
    <box
      title={title}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction
        if (direction !== 'up' && direction !== 'down') return
        onScroll(direction === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)
      }}
      style={{
        width,
        height: height + 2,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: colors.frame,
        titleColor: colors.title,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {!detail ? (
        <text style={{ fg: colors.detailMuted }}>{emptyMessage}</text>
      ) : (
        visible.map((line, index) => (
          <text key={offset + index} style={{ fg: colors.detailText }}>
            {line.spans.map((span, spanIndex) => (
              <Span key={spanIndex} span={span} colors={colors} />
            ))}
          </text>
        ))
      )}
    </box>
  )
}
