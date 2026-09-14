/**
 * Where the screen's preferences are persisted: the CLI settings file, next to
 * the model and mode choices (spec §20.16).
 *
 * This module is the only part of `windbreak/` that touches the filesystem, which
 * is what lets `ReviewApp` take a preferences object and a change callback
 * instead of doing I/O of its own — and what lets its tests cycle the layout
 * without writing to a real home directory.
 */

import { loadSettings, saveSettings } from '../utils/settings'

import {
  DEFAULT_WINDBREAK_PREFERENCES,
  parseWindbreakPreferences,
  type WindbreakPreferences,
} from './preferences'

/** The saved preferences, or the defaults when nothing has been saved. */
export const readWindbreakPreferences = (): WindbreakPreferences =>
  parseWindbreakPreferences(loadSettings().windbreak)

/**
 * Persist a whole preference object.
 *
 * Written whole rather than merged per field: `saveSettings` merges at the top
 * level, so a partial object would leave the old `colors` in place under a new
 * `theme` — which reads as "the override did not apply" when it did.
 */
export const writeWindbreakPreferences = (
  next: WindbreakPreferences,
): void => {
  saveSettings({ windbreak: parseWindbreakPreferences(next) })
}

/** The defaults, for callers that want to be explicit rather than implicit. */
export { DEFAULT_WINDBREAK_PREFERENCES }
