import React, { createContext, useContext } from 'react'

import type { WindbreakColors } from './theme'

/**
 * The screen's palette, handed to its panes (spec §20.16).
 *
 * A context rather than props because there is one palette for the whole screen
 * and thirty-odd keys: threading them through every pane would mean every
 * `renderItem`-style callback takes a colour bag it does not use. The panes read
 * `useWindbreakColors()` instead of the CLI theme, which is exactly what makes a
 * per-element override possible — `useTheme` has no idea what a
 * `queueHoverBg` is.
 */
const WindbreakColorsContext = createContext<WindbreakColors | null>(null)

export const WindbreakColorsProvider: React.FC<{
  colors: WindbreakColors
  children: React.ReactNode
}> = ({ colors, children }) => (
  <WindbreakColorsContext.Provider value={colors}>
    {children}
  </WindbreakColorsContext.Provider>
)

export const useWindbreakColors = (): WindbreakColors => {
  const colors = useContext(WindbreakColorsContext)
  if (!colors) {
    throw new Error(
      'useWindbreakColors must be used inside WindbreakColorsProvider',
    )
  }
  return colors
}
