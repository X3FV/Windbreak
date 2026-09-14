/**
 * The screen's arrangement as arithmetic (spec D32, §20.16).
 *
 * Kept out of the component for the same reason the key table is: the cascade
 * below is the part that can be *wrong* — a pane that silently loses its last
 * column, or a mode that reports "three panes" while one of them is zero wide —
 * and that is testable without a renderer.
 *
 * The default is three panes. Narrow terminals drop the decision column, then
 * the arrangement itself, rather than squeezing a pane into uselessness.
 */

export type WindbreakLayout = 'auto' | 'columns' | 'split' | 'stacked'

/** A layout with no `auto` left in it — what the screen actually draws. */
export type ResolvedLayout = 'columns' | 'split' | 'stacked'

/** The cycle order for the `L` key, and the order a help line lists them in. */
export const LAYOUT_ORDER: readonly WindbreakLayout[] = [
  'auto',
  'columns',
  'split',
  'stacked',
]

export const LAYOUT_LABELS: Record<WindbreakLayout, string> = {
  auto: 'auto',
  columns: 'three panes',
  split: 'queue + detail',
  stacked: 'stacked',
}

/**
 * Columns a bordered pane spends on its frame and padding: one column of border
 * and one of padding on each side. Everything a pane *shows* gets the rest.
 */
export const PANE_CHROME = 4

export const MIN_QUEUE_WIDTH = 24
export const DEFAULT_QUEUE_WIDTH = 34
export const MAX_QUEUE_WIDTH = 48

export const MIN_DETAIL_WIDTH = 30

export const MIN_DECISION_WIDTH = 22
export const DEFAULT_DECISION_WIDTH = 30
export const MAX_DECISION_WIDTH = 42

/**
 * The queue's width in the full-size chat, and the prose floor that can remove it
 * (§20.32).
 *
 * A *rail* rather than a column, and deliberately narrower than `MIN_QUEUE_WIDTH`: in
 * this arrangement the queue is not being read, it is the seat the researcher is sitting
 * in — which row the question is about, and where they are in the list. The chat is what
 * is being read, so it gets everything the rail does not need.
 *
 * `MIN_CHAT_WIDTH` is the floor at which a paragraph is still a paragraph. Below it the
 * rail is dropped rather than the transcript being squeezed, because a chat too narrow to
 * read is no chat at all — and the rail's information is recoverable with one `esc`,
 * where a mangled answer is not.
 */
export const CHAT_RAIL_WIDTH = 26
export const MIN_CHAT_WIDTH = 44

export interface ChatColumns {
  /** The rail's outer width, or null when this terminal has no room for it. */
  rail: number | null
  /** The chat pane's outer width. Always `columns` when there is no rail. */
  chat: number
}

/**
 * Split the body between the queue rail and the chat.
 *
 * The rail is kept while the chat can still be read, and dropped when it cannot — the
 * same "give up the optional thing rather than the content" rule the hint line and the
 * three-column arrangement follow.
 */
export const chatColumnsFor = (columns: number): ChatColumns => {
  if (columns - CHAT_RAIL_WIDTH >= MIN_CHAT_WIDTH) {
    return { rail: CHAT_RAIL_WIDTH, chat: columns - CHAT_RAIL_WIDTH }
  }
  return { rail: null, chat: columns }
}

/**
 * Rows a pane needs before it is worth standing beside another one — a pane
 * shorter than this shows a title and almost nothing else, which reads as a
 * rendering bug rather than a layout choice.
 */
export const MIN_PANE_ROWS = 6

/** Border top and bottom of a side-by-side pane row. */
export const PANE_FRAME_ROWS = 2

/**
 * The decision card's smallest useful height, in content rows.
 *
 * Below this the card is a title with nothing under it. It is part of the
 * arranging rather than the card's own business because it is what decides
 * whether the card can stand *beside* the arguments or has to go under them.
 */
export const MIN_CARD_ROWS = 8

/**
 * Non-pane rows above and below the side-by-side row: the header and the hints.
 * The decision card is a *pane* in the three-column arrangement, so it does not
 * appear here; in the degraded arrangements it is counted with the other
 * bottom blocks, which the screen owns because its height depends on content.
 */
export const COLUMN_CHROME_ROWS = 2

export interface LayoutInput {
  columns: number
  rows: number
  /** What the researcher asked for (or the settings file pinned). */
  layout: WindbreakLayout
  /** Pinned outer widths, when the settings file sets them. */
  queueWidth?: number | undefined
  decisionWidth?: number | undefined
}

export interface ColumnPlan {
  /** The arrangement after degradation. */
  mode: ResolvedLayout
  /** Outer widths, borders included. `decisionWidth` is 0 unless `mode` is `columns`. */
  queueWidth: number
  detailWidth: number
  decisionWidth: number
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value))

const positiveOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

/**
 * The queue's width, given a ceiling that depends on the arrangement.
 *
 * Requested widths are clamped rather than rejected: a settings file that pins a
 * 90-column queue is a wish, and honouring it by hiding the argument the
 * researcher is supposed to be reading would be the wrong way to be faithful to
 * it.
 */
export const queueWidthFor = (input: LayoutInput, ceiling: number): number =>
  clamp(
    Math.round(positiveOr(input.queueWidth, DEFAULT_QUEUE_WIDTH)),
    MIN_QUEUE_WIDTH,
    Math.max(MIN_QUEUE_WIDTH, ceiling),
  )

export const decisionWidthFor = (input: LayoutInput): number =>
  clamp(
    Math.round(positiveOr(input.decisionWidth, DEFAULT_DECISION_WIDTH)),
    MIN_DECISION_WIDTH,
    MAX_DECISION_WIDTH,
  )

/** Which of the three arrangements a request resolves to at this terminal size. */
export const resolveLayoutMode = (input: LayoutInput): ResolvedLayout => {
  const body = input.rows - COLUMN_CHROME_ROWS
  // Side by side needs room for the panes; the degraded arrangement puts the
  // card *below* them, so it needs room for the card as well. Three columns do
  // not, because there the card is one of the columns.
  const roomForPanes = body >= MIN_PANE_ROWS + PANE_FRAME_ROWS
  const roomForCardBelow =
    body >= MIN_PANE_ROWS + PANE_FRAME_ROWS + MIN_CARD_ROWS + PANE_FRAME_ROWS

  const queue = queueWidthFor(input, MAX_QUEUE_WIDTH)
  const decision = decisionWidthFor(input)
  const roomForColumns = input.columns >= queue + decision + MIN_DETAIL_WIDTH
  const roomForSplit = input.columns >= queue + MIN_DETAIL_WIDTH

  switch (input.layout) {
    case 'stacked':
      return 'stacked'
    case 'split':
      return roomForSplit && roomForCardBelow ? 'split' : 'stacked'
    // `auto` and an explicit `columns` degrade the same way: asking for three
    // panes on a terminal that cannot hold them still has to draw something.
    case 'auto':
    case 'columns':
      if (roomForColumns && roomForPanes) return 'columns'
      return roomForSplit && roomForCardBelow ? 'split' : 'stacked'
  }
}

/**
 * The widths the screen draws with.
 *
 * The detail pane takes what is left rather than a share, because it is the only
 * pane holding prose: a queue row is a fixed shape, the decision card is a
 * handful of fields, and every column a wrapped sentence does not get is a line
 * the researcher scrolls.
 */
export const computeColumnPlan = (input: LayoutInput): ColumnPlan => {
  const mode = resolveLayoutMode(input)

  if (mode === 'stacked') {
    return {
      mode,
      queueWidth: input.columns,
      detailWidth: input.columns,
      decisionWidth: 0,
    }
  }

  if (mode === 'split') {
    const queueWidth = queueWidthFor(input, input.columns - MIN_DETAIL_WIDTH)
    return {
      mode,
      queueWidth,
      detailWidth: input.columns - queueWidth,
      decisionWidth: 0,
    }
  }

  const decisionWidth = decisionWidthFor(input)
  const queueWidth = queueWidthFor(
    input,
    input.columns - decisionWidth - MIN_DETAIL_WIDTH,
  )

  return {
    mode,
    queueWidth,
    detailWidth: input.columns - queueWidth - decisionWidth,
    decisionWidth,
  }
}

/** Content rows inside a side-by-side pane, border excluded. */
export const columnPaneRows = (input: LayoutInput): number =>
  Math.max(0, input.rows - COLUMN_CHROME_ROWS - PANE_FRAME_ROWS)

/** The next layout in the `L` cycle. */
export const nextLayout = (current: WindbreakLayout): WindbreakLayout => {
  const index = LAYOUT_ORDER.indexOf(current)
  return LAYOUT_ORDER[(index + 1) % LAYOUT_ORDER.length] as WindbreakLayout
}
