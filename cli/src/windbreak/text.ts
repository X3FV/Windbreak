/**
 * Layout helpers for the adjudication screen.
 *
 * OpenTUI renders a `<text>` node as a single line — it does not wrap — so a
 * model's reasoning has to be broken into lines before it is rendered. Doing it
 * here rather than with a CSS-ish width keeps the panes' heights predictable,
 * which matters because the detail pane scrolls.
 */

/**
 * Wrap `text` to `width` columns.
 *
 * Explicit newlines are honoured, because a model's reasoning is prose but its
 * evidence snippet is code and the line breaks in it are part of the evidence.
 * A word longer than the pane is broken rather than allowed to overflow: an
 * identifier that runs off the edge is worse than one split across two lines.
 *
 * Returns `[]` for empty or whitespace-only input, so a caller can render
 * nothing rather than a blank line it did not ask for.
 */
export const wrapText = (text: string, width: number): string[] => {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (word.length === 0) continue

      if (current.length + word.length <= limit) {
        current += word
        continue
      }

      if (current.trim().length > 0) {
        lines.push(current.trimEnd())
        current = ''
      }

      // A single token longer than the pane: cut it into limit-sized pieces.
      let rest = word.trimStart()
      while (rest.length > limit) {
        lines.push(rest.slice(0, limit))
        rest = rest.slice(limit)
      }
      current = rest
    }

    if (current.trim().length > 0) lines.push(current.trimEnd())
  }

  // Trailing blank lines from a trailing newline are not worth a row.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines
}

/**
 * Cut `text` to `width` columns, marking the cut.
 *
 * The queue is a column now, and a queue row is the one place on the screen that
 * can be too long for its width. Without the ellipsis, a clipped row reads as a
 * shorter name rather than a truncated one — and two patterns that differ only
 * past the cut would look identical.
 */
export const truncateEnd = (text: string, width: number): string => {
  const limit = Math.max(1, Math.floor(width))
  if (text.length <= limit) return text
  if (limit === 1) return '…'
  return `${text.slice(0, limit - 1)}…`
}

export interface HintLineInput {
  columns: number
  /** True when the resolved entries are on screen, which flips what `a` does. */
  includeResolved: boolean
  layoutLabel: string
  themeLabel: string
  /**
   * The chat segment, supplied by the screen.
   *
   * Empty when there is no investigator, and `escape chat · enter send · …` while the
   * pane has the keyboard — because the keys a researcher can press are not the same in
   * the two modes, and a hint row that listed `r real` while `r` was being typed into a
   * question would be telling them something false.
   */
  chatHint?: string | undefined
  /**
   * The codebase segment, supplied by the screen.
   *
   * Empty when the target has no file inventory, `f files` when it has one and the
   * arguments are showing, and `esc back · ↑↓ scroll` while the listing has the slot —
   * the same rule the chat segment follows, for the same reason.
   */
  codebaseHint?: string | undefined
}

/**
 * The one line of keys under the panes.
 *
 * Tiered rather than truncated, because the renderer clips a long `<text>` from
 * the left: a 140-column hint line on a 78-column terminal lost `↑↓/jk move` and
 * kept `q quit`, which is exactly backwards. Each tier drops the least useful
 * thing first and keeps the keys a researcher cannot guess.
 */
export const buildHintLine = ({
  columns,
  includeResolved,
  layoutLabel,
  themeLabel,
  chatHint,
  codebaseHint,
}: HintLineInput): string => {
  const toggle = includeResolved ? 'pending' : 'all'
  // Omitted entirely when there is no investigator, rather than shown greyed: a key that
  // does nothing is worse than a key that is not offered. The codebase segment follows
  // the same rule for the same reason — a target with no inventory is not offered `f`.
  const chat = chatHint && chatHint.length > 0 ? ` · ${chatHint}` : ''
  const files = codebaseHint && codebaseHint.length > 0 ? ` · ${codebaseHint}` : ''

  // Ordered most informative first, and chosen by measuring rather than by a
  // column threshold: the labels the researcher chose are part of the line, so a
  // tier that fits `L stacked` may not fit `L queue + detail`.
  const tiers = [
    `↑↓/jk move · wheel scrolls · PgUp/PgDn argument · r real · b benign · a ${toggle}${files}${chat} · L ${layoutLabel} · t ${themeLabel} · q quit`,
    `↑↓/jk move · wheel · PgUp/PgDn · r real · b benign · a ${toggle}${files}${chat} · L ${layoutLabel} · t ${themeLabel} · q quit`,
    `↑↓/jk · r/b decide · a ${toggle}${files}${chat} · L ${layoutLabel} · t ${themeLabel} · q`,
    `↑↓/jk · r/b · a ${toggle}${files}${chat} · L ${layoutLabel} · t ${themeLabel}`,
    // The names live in the card at this size; the keys do not. The chat hint survives
    // longest of the optional segments, because it is the one thing on the line that
    // cannot be guessed from the panes above it.
    `↑↓/jk · r/b · a · L · t · q${files}${chat}`,
  ]

  const usable = Math.max(1, columns - 2)
  return tiers.find((line) => line.length <= usable) ?? tiers[tiers.length - 1]!
}

/** Shorten a path to `…/project/src/handler.c` for a one-line header. */
export const shortenPath = (filePath: string, keep = 3): string => {
  const parts = filePath.split('/').filter((part) => part.length > 0)
  if (parts.length <= keep) return filePath
  return `…/${parts.slice(-keep).join('/')}`
}
