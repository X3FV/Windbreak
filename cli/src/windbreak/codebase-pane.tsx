import React from 'react'

import { BORDER_CHARS } from '../utils/ui-constants'

import { WHEEL_ROWS } from './actions'
import { useWindbreakColors } from './colors-context'

import type { CodebaseLine, CodebaseTone } from './codebase-lines'
import type { WindbreakColors } from './theme'
import type { MouseEvent } from '@opentui/core'

/**
 * The codebase listing, in the detail pane's slot (spec §20.30).
 *
 * The *detail* slot rather than the decision card's, which is where the chat pane went:
 * a path is read left to right and the detail pane is the only one sized for prose. The
 * queue and the decision card stay on screen, so opening the files does not cost the
 * researcher their place or the disagreement they were reading — the same reason the chat
 * takes a slot rather than a screen.
 *
 * It is read-only, and that is the point of this slice: it lists what recon indexed, so
 * the codebase on screen is the same set of files the findings are about. Opening the
 * writable working copy a model may edit is §20.30's next slice and belongs beside this
 * one rather than inside it.
 */

interface CodebasePaneProps {
  lines: CodebaseLine[]
  /** First visible row of `lines`. */
  offset: number
  /** Rows of content this pane can show. */
  height: number
  width: number
  /** Wheel movement over the pane, in rows (negative is up). */
  onScroll: (delta: number) => void
  /** The checkout being listed, for the title. Null when there is none. */
  location: string | null
}

const toneColor = (tone: CodebaseTone, colors: WindbreakColors): string => {
  switch (tone) {
    case 'normal':
      return colors.codebaseFileText
    case 'info':
      return colors.codebaseDirText
    case 'muted':
      return colors.codebaseMetaText
    case 'warning':
      return colors.warningText
  }
}

export const CodebasePane: React.FC<CodebasePaneProps> = ({
  lines,
  offset,
  height,
  width,
  onScroll,
  location,
}) => {
  const colors = useWindbreakColors()

  const scrollable = lines.length > height
  const visible = lines.slice(offset, offset + height)
  const lastVisible = Math.min(offset + height, lines.length)

  const title =
    location === null
      ? ' Codebase '
      : ` Codebase — ${location}${
          // The position lives in the title rather than in a row of its own, which is
          // what the detail pane does: a position row would cost one of the rows the
          // pane is scrolling.
          scrollable ? `  lines ${offset + 1}–${lastVisible}/${lines.length}` : ''
        } `

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
      {visible.map((line, index) => (
        <text key={offset + index} style={{ fg: toneColor(line.tone, colors) }}>
          {line.text}
        </text>
      ))}
    </box>
  )
}
