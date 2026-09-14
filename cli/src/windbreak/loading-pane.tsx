import React, { useMemo } from 'react'

import { useTheme } from '../hooks/use-theme'
import { BORDER_CHARS } from '../utils/ui-constants'

import { WindbreakColorsProvider } from './colors-context'
import { resolveWindbreakColors } from './theme'

import type { WindbreakPreferences } from './preferences'

/**
 * What is drawn between the renderer existing and the app being ready
 * (spec §20.29.6).
 *
 * The gap this fills is real and was introduced deliberately: §20.29.5 moved the
 * investigator's construction away from the screen so a missing client became a *stated
 * reason* on the pane rather than an error raised inside the alternate screen. The side
 * effect is that resolving credentials and opening the second database connection happens
 * before anything is drawn — on a cold start, that is the SDK being imported, and it reads
 * as the terminal hanging.
 *
 * So the order is: renderer, this, the bridge, then the app. The screen still lands on the
 * queue, which is §5.3's subject; this only means the wait has a face.
 *
 * Two rules it keeps from the rest of the screen:
 *
 * - **It says what it is waiting for.** "Loading" with no subject leaves an operator
 *   unsure whether anything is happening at all, and the path the screen was pointed at
 *   is the one fact that tells them they pointed it at the right place — the database
 *   when there is one, and the repository the fallback listing will walk when there is
 *   not (§20.31).
 * - **It uses the screen's own palette** (`resolveWindbreakColors`), so a researcher who
 *   set `contrast` does not get a flash of a different theme before the queue appears.
 *
 * It is deliberately not a spinner. Animation would need a timer and a re-render loop for
 * a wait that is normally a few hundred milliseconds, and a stalled spinner says the
 * opposite of what is happening.
 */

/** The one line that says what the wait is for. */
const LOADING_MESSAGE = 'preparing the investigator — credentials and the target'

interface LoadingPaneProps {
  /**
   * The path this screen was pointed at: the state database, or — for a checkout
   * nothing has scanned — the repository the file pane will list (§20.31).
   */
  subject: string
  preferences: WindbreakPreferences
}

export const LoadingPane: React.FC<LoadingPaneProps> = ({ subject, preferences }) => {
  const theme = useTheme()
  const colors = useMemo(
    () => resolveWindbreakColors(theme, preferences.theme, preferences.colors),
    [theme, preferences],
  )

  return (
    <WindbreakColorsProvider colors={colors}>
      <box
        style={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <box
          title=" WindBreak "
          style={{
            flexDirection: 'column',
            borderStyle: 'single',
            borderColor: colors.frame,
            titleColor: colors.title,
            customBorderChars: BORDER_CHARS,
            paddingLeft: 2,
            paddingRight: 2,
          }}
        >
          <text style={{ fg: colors.headerText }}>{LOADING_MESSAGE}</text>
          <text style={{ fg: colors.headerMeta }}>{subject}</text>
        </box>
      </box>
    </WindbreakColorsProvider>
  )
}
