/**
 * The screen's saved choices, and the one place they are validated
 * (spec §20.16).
 *
 * Pure on purpose: `parseWindbreakPreferences` takes whatever `JSON.parse` of the
 * settings file produced and is the only thing that decides what a saved value
 * means. The settings loader is an allowlist that drops unknown keys, so a
 * malformed or hand-edited entry has to be *dropped here*, not trusted and then
 * rendered.
 */

import { LAYOUT_ORDER, type WindbreakLayout } from './layout'
import {
  WINDBREAK_THEME_NAMES,
  isUsableWindbreakColor,
  isWindbreakColorKey,
  type WindbreakColors,
  type WindbreakThemeName,
} from './theme'

export interface WindbreakPreferences {
  /**
   * `auto` is the default: three panes when the terminal holds them, degrading
   * to two and then to the stack. The other values pin an arrangement, which
   * still degrades rather than drawing a pane zero columns wide.
   */
  layout: WindbreakLayout
  theme: WindbreakThemeName
  /** Outer width of the queue column, borders included. */
  queueWidth?: number | undefined
  /** Outer width of the decision column, borders included. */
  decisionWidth?: number | undefined
  /** Per-element colour overrides, applied after the variant. */
  colors?: Partial<WindbreakColors> | undefined
}

export const DEFAULT_WINDBREAK_PREFERENCES: WindbreakPreferences = {
  layout: 'auto',
  theme: 'default',
}

export const isWindbreakLayout = (value: unknown): value is WindbreakLayout =>
  typeof value === 'string' && (LAYOUT_ORDER as readonly string[]).includes(value)

export const isWindbreakThemeName = (
  value: unknown,
): value is WindbreakThemeName =>
  typeof value === 'string' &&
  (WINDBREAK_THEME_NAMES as readonly string[]).includes(value)

/**
 * A width worth keeping.
 *
 * Only "is this a number a pane could be" is checked here; whether it *fits* is
 * the layout's business, and clamping happens there so a terminal resize cannot
 * turn a saved 90-column queue into a pane that hides the argument.
 */
const positiveWidth = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const rounded = Math.round(value)
  return rounded >= 1 ? rounded : undefined
}

const parseColors = (
  raw: unknown,
): Partial<WindbreakColors> | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined

  const colors: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isWindbreakColorKey(key)) continue
    if (!isUsableWindbreakColor(value)) continue
    colors[key] = value
  }

  return Object.keys(colors).length > 0
    ? (colors as Partial<WindbreakColors>)
    : undefined
}

/**
 * Whatever the settings file held, as a preference.
 *
 * Never throws and never returns a partial: a preference is either the whole
 * thing or the default, because a layout choice is not more important than the
 * screen still opening.
 */
export const parseWindbreakPreferences = (raw: unknown): WindbreakPreferences => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_WINDBREAK_PREFERENCES }
  }

  const obj = raw as Record<string, unknown>

  return {
    layout: isWindbreakLayout(obj.layout)
      ? obj.layout
      : DEFAULT_WINDBREAK_PREFERENCES.layout,
    theme: isWindbreakThemeName(obj.theme)
      ? obj.theme
      : DEFAULT_WINDBREAK_PREFERENCES.theme,
    queueWidth: positiveWidth(obj.queueWidth),
    decisionWidth: positiveWidth(obj.decisionWidth),
    colors: parseColors(obj.colors),
  }
}
