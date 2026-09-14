/**
 * The adjudication screen's own palette (spec §20.16).
 *
 * Every element the screen paints has a name here, and every name is settable
 * from the settings file. The names are deliberately *element* names
 * (`queueHoverBg`, `detailRule`) rather than semantic ones: this screen has roles
 * the chat theme has no word for — a proposer's verdict, a refuter's, the frame
 * of the pane holding the keyboard — and reusing `warning` for one of them would
 * make the override mean something else everywhere else in the CLI.
 *
 * Nothing here is hard-coded. A variant is a *pointing* at the CLI theme's own
 * tokens, so a user who switches the CLI to light mode gets a light adjudication
 * screen without touching this file.
 */

import type { ChatTheme } from '../types/theme-system'

export type WindbreakThemeName = 'default' | 'contrast' | 'reading'

/** The cycle order for the `t` key. */
export const WINDBREAK_THEME_NAMES: readonly WindbreakThemeName[] = [
  'default',
  'contrast',
  'reading',
]

export const WINDBREAK_THEME_LABELS: Record<WindbreakThemeName, string> = {
  default: 'default',
  contrast: 'contrast',
  reading: 'reading',
}

/**
 * One colour per element.
 *
 * `QueueList`, `DetailPane` and `DecisionPane` read these through
 * `useWindbreakColors` rather than `useTheme`, which is what makes a per-element
 * override possible at all.
 */
export interface WindbreakColors {
  // ---- chrome -------------------------------------------------------------
  /** A pane's border. */
  frame: string
  /** The border of the pane that holds the keyboard. */
  frameFocused: string
  /** A pane's title text. */
  title: string
  /** The screen's name in the header. */
  headerText: string
  /** Counts, database path, run id. */
  headerMeta: string

  // ---- queue --------------------------------------------------------------
  queueText: string
  queueSelectedFg: string
  queueSelectedBg: string
  queueHoverBg: string
  /** An entry that already has a recorded decision. */
  queueResolvedText: string
  /** The `↑ 3 more` / `↓ 2 more` counters. */
  queueMoreText: string

  // ---- detail -------------------------------------------------------------
  detailText: string
  /** Secondary prose: labels, the footer, an absent argument. */
  detailMuted: string
  /** The horizontal rules between evidence and each argument. */
  detailRule: string
  /** The code snippet the arguments are about. */
  evidenceText: string
  /** §5.1's injection notice, and an unreadable evidence bundle. */
  warningText: string
  /** A verdict of `real`. */
  realText: string
  /** A verdict of `benign`. */
  benignText: string
  /** The `proposer` / `refuter` label. */
  roleLabel: string

  // ---- codebase (§20.30) --------------------------------------------------
  /** A directory row in the file listing. Structure, not content. */
  codebaseDirText: string
  /** A source file row. */
  codebaseFileText: string
  /** The target/commit header and a file's language and size. */
  codebaseMetaText: string

  // ---- decision -----------------------------------------------------------
  /** `rationale`, and the card's own labels. */
  decisionLabel: string
  /** The card's resting state. */
  decisionIdle: string
  /** The last recorded decision, or an error from writing one. */
  decisionNotice: string
  decisionError: string
  /** The staged decision, before Enter. */
  decisionReal: string
  decisionBenign: string
  /** Candidate id, state, source, and the key hints inside the card. */
  decisionMeta: string
  /** The rationale input's background while it is focused. */
  rationaleBg: string
  inputFg: string

  // ---- footer -------------------------------------------------------------
  hintsText: string
}

/** The allowlist the settings validator uses. Sorted for a stable diff. */
export const WINDBREAK_COLOR_KEYS = [
  'benignText',
  'codebaseDirText',
  'codebaseFileText',
  'codebaseMetaText',
  'decisionBenign',
  'decisionError',
  'decisionIdle',
  'decisionLabel',
  'decisionMeta',
  'decisionNotice',
  'decisionReal',
  'detailMuted',
  'detailRule',
  'detailText',
  'evidenceText',
  'frame',
  'frameFocused',
  'headerMeta',
  'headerText',
  'hintsText',
  'inputFg',
  'queueHoverBg',
  'queueMoreText',
  'queueResolvedText',
  'queueSelectedBg',
  'queueSelectedFg',
  'queueText',
  'rationaleBg',
  'realText',
  'roleLabel',
  'title',
  'warningText',
] as const satisfies readonly (keyof WindbreakColors)[]

export const isWindbreakColorKey = (key: string): key is keyof WindbreakColors =>
  (WINDBREAK_COLOR_KEYS as readonly string[]).includes(key)

/**
 * Whether a value is a colour worth painting.
 *
 * Any non-empty string is accepted — a colour may be a hex, a name, or an
 * `rgb()` — because this module has no business enumerating what a terminal
 * understands. What it does reject is whitespace and control characters, which
 * are never a colour and would corrupt the frame they were painted into.
 *
 * Shared with the settings parser on purpose: one definition of "usable", so a
 * hand-edited file cannot get past the loader and then be dropped again here.
 */
export const isUsableWindbreakColor = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  return !/[\s\u0000-\u001f\u007f]/.test(value)
}

/** The palette as the CLI theme points at it. */
const palette = (theme: ChatTheme): WindbreakColors => ({
  frame: theme.border,
  frameFocused: theme.info,
  title: theme.muted,
  headerText: theme.info,
  headerMeta: theme.muted,

  queueText: theme.foreground,
  queueSelectedFg: theme.info,
  queueSelectedBg: theme.surface,
  queueHoverBg: theme.surfaceHover,
  queueResolvedText: theme.muted,
  queueMoreText: theme.muted,

  detailText: theme.foreground,
  detailMuted: theme.muted,
  detailRule: theme.border,
  evidenceText: theme.foreground,
  warningText: theme.warning,
  // `real` is the alarming answer on this screen: two providers disagreed and
  // this one says the bug is there. `benign` is the reassuring one.
  realText: theme.warning,
  benignText: theme.success,
  roleLabel: theme.info,

  // The listing is reading text, so the file rows are the same foreground the
  // arguments use; directories get the information colour because they are the
  // shape of the tree rather than its content, and the metadata recedes.
  codebaseDirText: theme.info,
  codebaseFileText: theme.foreground,
  codebaseMetaText: theme.muted,

  decisionLabel: theme.info,
  decisionIdle: theme.muted,
  decisionNotice: theme.success,
  decisionError: theme.error,
  decisionReal: theme.warning,
  decisionBenign: theme.success,
  decisionMeta: theme.muted,
  rationaleBg: theme.surface,
  inputFg: theme.inputFocusedFg,

  hintsText: theme.muted,
})

/**
 * Three pointings, not three palettes.
 *
 * `default` is the CLI theme as-is. `contrast` raises the chrome and the
 * secondary prose to full foreground, for a terminal where `muted` is too close
 * to the background to read. `reading` does the opposite: the frames and the
 * evidence recede so the two arguments carry the colour.
 */
export const windbreakPalette = (
  theme: ChatTheme,
  variant: WindbreakThemeName,
): WindbreakColors => {
  const base = palette(theme)

  switch (variant) {
    case 'default':
      return base

    case 'contrast':
      return {
        ...base,
        frame: theme.foreground,
        frameFocused: theme.primary,
        title: theme.foreground,
        headerText: theme.primary,
        headerMeta: theme.foreground,
        queueMoreText: theme.foreground,
        queueResolvedText: theme.foreground,
        detailMuted: theme.foreground,
        codebaseMetaText: theme.foreground,
        decisionIdle: theme.foreground,
        decisionMeta: theme.foreground,
        hintsText: theme.foreground,
      }

    case 'reading':
      return {
        ...base,
        frame: theme.border,
        // The focused pane stays marked, but only just: on a reading surface the
        // frame is chrome, and the arguments are the content.
        frameFocused: theme.border,
        title: theme.muted,
        headerText: theme.muted,
        headerMeta: theme.muted,
        evidenceText: theme.muted,
        roleLabel: theme.muted,
        detailMuted: theme.muted,
        codebaseDirText: theme.muted,
        codebaseMetaText: theme.muted,
        hintsText: theme.muted,
        queueSelectedFg: theme.foreground,
        queueSelectedBg: theme.surface,
        decisionMeta: theme.muted,
      }
  }
}

/**
 * The palette the screen draws with: a variant, then the settings file's
 * per-element overrides on top.
 *
 * Overrides are applied last and per key, so pinning `detailRule` does not
 * discard the variant the researcher cycled to.
 */
export const resolveWindbreakColors = (
  theme: ChatTheme,
  variant: WindbreakThemeName,
  overrides: Partial<WindbreakColors> | undefined,
): WindbreakColors => {
  const base = windbreakPalette(theme, variant)
  if (!overrides) return base

  const resolved = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (!isUsableWindbreakColor(value)) continue
    if (!isWindbreakColorKey(key)) continue
    resolved[key] = value
  }
  return resolved
}

/** The next theme in the `t` cycle. */
export const nextWindbreakTheme = (
  current: WindbreakThemeName,
): WindbreakThemeName => {
  const index = WINDBREAK_THEME_NAMES.indexOf(current)
  return WINDBREAK_THEME_NAMES[
    (index + 1) % WINDBREAK_THEME_NAMES.length
  ] as WindbreakThemeName
}
