import React, { useState } from 'react'

import { Button } from '../components/button'
import { BORDER_CHARS } from '../utils/ui-constants'

import { WHEEL_ROWS } from './actions'
import { useWindbreakColors } from './colors-context'
import { PANE_CHROME } from './layout'
import { shortenPath, truncateEnd } from './text'

import type { ReviewEntrySummary } from '@codebuff/windbreak/review'
import type { MouseEvent } from '@opentui/core'

interface QueueListProps {
  entries: ReviewEntrySummary[]
  selectedIndex: number
  /** Rows shown before the list scrolls around the selection. */
  maxVisibleRows?: number
  /**
   * Content rows to draw, border excluded.
   *
   * Pinned rather than derived so the queue stands the same height as the panes
   * beside it: a column that ends where its entries end looks like a rendering
   * fault next to two that run the full height.
   */
  height?: number
  width: number
  /** What to say when there is nothing to show. */
  emptyMessage: string
  /** A row was clicked. */
  onSelectIndex: (index: number) => void
  /** The wheel moved over the list, in rows (negative is up). */
  onScroll: (delta: number) => void
  /** Draws the frame in the focused colour. */
  focused?: boolean
}

export const DEFAULT_MAX_VISIBLE_ROWS = 6

/**
 * Keep the selected row inside the window.
 *
 * Mirrors the chat's queue panel: the cursor centres as the list scrolls, so
 * arrowing past the window's edge does not move the selection invisibly.
 */
export const windowStart = (
  selectedIndex: number,
  total: number,
  visible: number,
): number => {
  if (total <= visible) return 0
  const half = Math.floor(visible / 2)
  return Math.max(0, Math.min(total - visible, selectedIndex - half))
}

const entryLabel = (entry: ReviewEntrySummary): string => {
  const location = entry.filePath
    ? `${shortenPath(entry.filePath)}:${entry.startLine ?? '?'}`
    : '(location unknown)'
  const cls = entry.cwe ?? 'unclassified'
  const detected = entry.patternId ? `${entry.source}/${entry.patternId}` : entry.source
  return `${location}  ${cls}  ${detected}`
}

/**
 * The recorded decision, as the row's *first* field.
 *
 * It used to be the last, which cost it its visibility as soon as the queue
 * became a column: a long pattern id filled the row and the marker was the first
 * thing clipped, so a decided entry looked exactly like an undecided one. The
 * most decision-relevant fact now sits where clipping cannot reach it.
 */
const decisionMarker = (entry: ReviewEntrySummary): string =>
  entry.decision === null ? '' : `[${entry.decision}] `

export const QueueList: React.FC<QueueListProps> = ({
  entries,
  selectedIndex,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
  height,
  width,
  emptyMessage,
  onSelectIndex,
  onScroll,
  focused = false,
}) => {
  const colors = useWindbreakColors()
  /**
   * Hover is tracked separately from selection on purpose.
   *
   * The chat's queue panel moves its cursor on hover, which is right for a small
   * panel that owns a single pane. Here the selection drives a *detail* pane, so
   * following the mouse would rewrite a page of text every time the cursor
   * crossed a row. Clicking selects; hovering only highlights what a click would
   * take.
   */
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const start = windowStart(selectedIndex, entries.length, maxVisibleRows)
  const visible = entries.slice(start, start + maxVisibleRows)
  const hiddenAbove = start
  const hiddenBelow = Math.max(0, entries.length - (start + visible.length))

  return (
    <box
      title={entries.length === 0 ? ' Queue ' : ` Queue — ${entries.length} `}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction
        if (direction !== 'up' && direction !== 'down') return
        onScroll(direction === 'down' ? WHEEL_ROWS : -WHEEL_ROWS)
      }}
      style={{
        width,
        height: height === undefined ? undefined : height + 2,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: focused ? colors.frameFocused : colors.frame,
        titleColor: colors.title,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {entries.length === 0 ? (
        <text style={{ fg: colors.detailMuted }}>{emptyMessage}</text>
      ) : (
        <>
          {hiddenAbove > 0 && (
            <text style={{ fg: colors.queueMoreText }}>{`  ↑ ${hiddenAbove} more`}</text>
          )}

          {visible.map((entry, offset) => {
            const index = start + offset
            const isSelected = index === selectedIndex
            const isHovered = index === hoveredIndex
            const marker = decisionMarker(entry)
            // The cursor and the marker are fixed, so the label gets whatever is
            // left — and says so with an ellipsis when it does not fit.
            const label = truncateEnd(
              entryLabel(entry),
              width - PANE_CHROME - 2 - marker.length,
            )

            return (
              <Button
                key={entry.candidateId}
                onClick={(event) => {
                  // Left button only: a right-click should not move the cursor
                  // out from under the researcher.
                  if ((event as MouseEvent | undefined)?.button === 0) {
                    onSelectIndex(index)
                  }
                }}
                onMouseOver={() => setHoveredIndex(index)}
                onMouseOut={() => setHoveredIndex(null)}
                style={{
                  width: '100%',
                  height: 1,
                  backgroundColor:
                    isHovered && !isSelected ? colors.queueHoverBg : undefined,
                }}
              >
                <text
                  style={{
                    fg: isSelected ? colors.queueSelectedFg : colors.queueText,
                    bg: isSelected ? colors.queueSelectedBg : undefined,
                  }}
                >
                  {isSelected ? '❯ ' : '  '}
                  <span style={{ fg: colors.queueResolvedText }}>{marker}</span>
                  {label}
                </text>
              </Button>
            )
          })}

          {hiddenBelow > 0 && (
            <text style={{ fg: colors.queueMoreText }}>{`  ↓ ${hiddenBelow} more`}</text>
          )}
        </>
      )}
    </box>
  )
}
