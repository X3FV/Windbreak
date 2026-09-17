import React, { useMemo } from 'react'

import { LOGO, LOGO_SMALL, SHADOW_CHARS } from '../login/constants'
import { parseLogoLines } from '../login/utils'
import { BRAND, BRAND_NAME_UPPER, WORDMARK_ROWS } from '../utils/brand'

interface UseLogoOptions {
  /**
   * Available width for rendering the logo
   */
  availableWidth: number
  /**
   * Optional function to apply styling to each character (e.g., for sheen animation)
   * If not provided, default coloring is applied (white blocks, accent shadows)
   */
  applySheenToChar?: (char: string, charIndex: number, lineIndex: number) => React.ReactNode
  /**
   * Color to apply to the text variant
   */
  textColor?: string
  /**
   * Accent color for shadow/border characters (defaults to the brand's own)
   */
  accentColor?: string
  /**
   * Block color for solid block characters (white for dark mode, black for light mode)
   */
  blockColor?: string
  /**
   * Optional vertical budget (in rows) for the logo. When fewer than the
   * ASCII art's 6 lines are available, the hook downgrades to the single-line
   * text variant so callers on short terminals don't have to special-case it.
   */
  maxHeight?: number
}

interface LogoResult {
  /**
   * The formatted logo as a React component ready to render in UI
   */
  component: React.ReactNode
  /**
   * The formatted logo string for plain text contexts (e.g., chat messages)
   * Empty string for narrow widths, formatted ASCII art otherwise
   */
  textBlock: string
}

/**
 * Hook to render a logo based on available width
 * Returns a fully formatted React component and text block that "just work"
 *
 * Returns:
 * - Full ASCII logo for width >= 70
 * - Small ASCII logo for width >= 20
 * - Text variant, the bare brand name or its CLI form, below that
 *
 * The hook handles ALL formatting internally including:
 * - Line parsing and width limiting
 * - Optional character-level styling (sheen animation) for React component
 * - Text wrapping and block formatting for plain text contexts
 * - No consumer needs to know about parseLogoLines, split, join, etc.
 */
/**
 * Widths at which each form of the mark is drawn.
 *
 * Kept as fixed thresholds rather than derived from each mark's own width, which
 * is how this hook has always decided: Freebuff's art is 66 columns wide but has
 * always been drawn from 70, and "draw it as soon as it fits" would move that
 * boundary for the two upstream identities. The fork's mark is 62 wide and sits
 * comfortably inside the same threshold, so it needs no rule of its own.
 */
const FULL_WORDMARK_MIN_WIDTH = 70
const MONOGRAM_MIN_WIDTH = 20

/**
 * Below this, the text variant drops the "CLI" suffix — "Freebuff CLI" reads as
 * filler in a space that is already too narrow for the art.
 */
const CLI_NAME_MIN_WIDTH = 30

export const useLogo = ({
  availableWidth,
  applySheenToChar,
  textColor,
  accentColor = BRAND.accent,
  blockColor = '#ffffff',
  maxHeight,
}: UseLogoOptions): LogoResult => {
  // The brand's art is `WORDMARK_ROWS` tall, and the monogram shares that height.
  // A caller who cannot spare the rows gets the text variant rather than clipped
  // art. Both bounds are the art's own measurements, so neither has to be kept in
  // step with it by hand.
  const rawLogoString = useMemo(() => {
    if (maxHeight != null && maxHeight < WORDMARK_ROWS) {
      return BRAND_NAME_UPPER
    }
    if (availableWidth >= FULL_WORDMARK_MIN_WIDTH) return LOGO
    if (availableWidth >= MONOGRAM_MIN_WIDTH) return LOGO_SMALL
    return BRAND_NAME_UPPER
  }, [availableWidth, maxHeight])

  // Format text block for plain text contexts (chat messages, etc.)
  const textBlock = useMemo(() => {
    if (rawLogoString === BRAND_NAME_UPPER) {
      return '' // Don't show ASCII art for text-only variant in plain text contexts
    }
    // Parse and format for plain text display
    return parseLogoLines(rawLogoString)
      .map((line) => line.slice(0, availableWidth))
      .join('\n')
  }, [rawLogoString, availableWidth])

  // Format component for React contexts (login modal, etc.)
  const component = useMemo(() => {
    // Text-only variant for very narrow widths
    if (rawLogoString === BRAND_NAME_UPPER) {
      // When we collapsed to text purely to fit a short terminal (not because
      // the terminal is narrow), keep it to the bare brand name.
      const forcedByHeight = maxHeight != null && maxHeight < WORDMARK_ROWS
      const displayText =
        availableWidth < CLI_NAME_MIN_WIDTH || forcedByHeight
          ? BRAND.name
          : BRAND.cliName

      return (
        <text style={{ wrapMode: 'none' }}>
          <b>
            {textColor ? (
              <span fg={textColor}>{displayText}</span>
            ) : (
              <>{displayText}</>
            )}
          </b>
        </text>
      )
    }

    // ASCII art variant
    const logoLines = parseLogoLines(rawLogoString)
    const displayLines = logoLines.map((line) => line.slice(0, availableWidth))

    // Default coloring function: blockColor for blocks, accent color for shadows
    const defaultColorChar = (char: string, charIndex: number) => {
      if (char === ' ' || char === '\n') {
        return <span key={charIndex}>{char}</span>
      }
      // Block characters use blockColor (white in dark mode, black in light mode)
      if (char === '█') {
        return <span key={charIndex} fg={blockColor}>{char}</span>
      }
      // Shadow/border characters get accent color
      if (SHADOW_CHARS.has(char)) {
        return <span key={charIndex} fg={accentColor}>{char}</span>
      }
      // Other characters use accent color
      return <span key={charIndex} fg={accentColor}>{char}</span>
    }

    return (
      <>
        {displayLines.map((line, lineIndex) => (
          <text key={`logo-line-${lineIndex}`} style={{ wrapMode: 'none' }}>
            {line
              .split('')
              .map((char, charIndex) =>
                applySheenToChar
                  ? applySheenToChar(char, charIndex, lineIndex)
                  : defaultColorChar(char, charIndex),
              )}
          </text>
        ))}
      </>
    )
  }, [rawLogoString, availableWidth, applySheenToChar, textColor, accentColor, blockColor, maxHeight])

  return { component, textBlock }
}
