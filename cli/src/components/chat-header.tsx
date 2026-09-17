import { memo, useState } from 'react'

import { useLogo } from '../hooks/use-logo'
import { useSheenAnimation } from '../hooks/use-sheen-animation'
import { useTerminalDimensions } from '../hooks/use-terminal-dimensions'
import { useTheme } from '../hooks/use-theme'
import { BRAND } from '../utils/brand'
import { openFileAtPath } from '../utils/open-file'
import { formatCwd } from '../utils/path-helpers'
import { getLogoAccentColor, getLogoBlockColor } from '../utils/theme-system'
import { TerminalLink } from './terminal-link'

export const ChatHeader = memo(function ChatHeader({
  projectRoot,
  animationEnabled,
}: {
  projectRoot: string
  animationEnabled: boolean
}) {
  const { contentMaxWidth, terminalWidth } = useTerminalDimensions()
  const theme = useTheme()
  const [sheenPosition, setSheenPosition] = useState(0)
  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { applySheenToChar } = useSheenAnimation({
    enabled: animationEnabled,
    logoColor: theme.foreground,
    accentColor,
    blockColor,
    terminalWidth,
    sheenPosition,
    setSheenPosition,
  })
  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    accentColor,
    blockColor,
    applySheenToChar,
  })

  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexDirection: 'column',
          marginBottom: 1,
          marginTop: 2,
        }}
      >
        {logoComponent}
      </box>
      {/* The tagline sits directly under the wordmark in the brand colour, which
          is what makes the header read as a branded surface rather than the
          wordmark plus a paragraph. It is the one line here that is pure
          identity, so it is the one line drawn in the accent — and it is drawn
          only for a brand that asks for it, so the fork's restyle in this header
          does not reach the Freebuff one. */}
      {BRAND.headerTagline && (
        <text style={{ wrapMode: 'word', fg: accentColor }}>
          {BRAND.tagline}
        </text>
      )}
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
        {BRAND.name} will run commands on your behalf
        to help you build.
      </text>
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: theme.foreground }}>
        Directory{' '}
        <TerminalLink
          text={formatCwd(projectRoot)}
          color={theme.muted}
          inline={true}
          underlineOnHover={true}
          onActivate={() => openFileAtPath(projectRoot)}
        />
      </text>
    </box>
  )
})
