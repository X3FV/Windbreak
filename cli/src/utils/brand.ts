/**
 * The product's visible identity, in one module.
 *
 * Every branded surface — the wordmark, the name in prose, the accent the
 * wordmark's shadow characters take — reads from `BRAND` rather than restating a
 * string. The point is that renaming or restyling the product is a change *here*
 * and nowhere else; `use-logo`, the login modal and the landing screen all render
 * whatever this module says, so they cannot disagree about what the tool is
 * called.
 *
 * **Three identities, and which one you get is decided by how you launched.**
 * `windbreak` draws Windbreak, plain `freebuff` keeps Freebuff, and the
 * non-Freebuff build keeps Codebuff. That split is deliberate rather than a
 * leftover: the Windbreak identity belongs to the *subcommand*, not the product,
 * so a researcher running `freebuff` for ordinary work still sees the tool they
 * installed. The other two are kept beside the fork's as data rather than as
 * conditionals at the call sites, which is what makes them free.
 *
 * **The selection is read at module load, from `process.argv`.** That timing is
 * load-bearing, not incidental: `consumeWindbreakInvocation` *removes* the
 * subcommand token from `argv` before the argument parser sees it — the main
 * program takes `login` as its only positional and would reject the rest — so a
 * reader that ran any later would find no token and fall back to Freebuff. Module
 * bodies run during import, ahead of anything in `index.tsx`'s `main()`, so this
 * sees the command line as the user actually typed it. `findWindbreakCommand` is
 * reused rather than reimplemented so the two cannot disagree about what counts
 * as a Windbreak invocation.
 *
 * **What is deliberately not here.** The backend URLs, the config directory
 * (`~/.config/manicode`) and the credential environment variables are identity
 * too, but of the kind a running install depends on: a renamed product that
 * looked for its token somewhere new would log every existing user out, and one
 * pointed at a different backend would stop working entirely. So the *visible*
 * brand lives here and the *operational* identity stays where it is — see
 * `./constants.ts` (`IS_FREEBUFF`) and `../login/constants.ts` (the URLs).
 */

import { IS_FREEBUFF } from './constants'
import { findWindbreakCommand } from './windbreak-launch'

export interface BrandIdentity {
  /** Name in prose, sentence case: `Windbreak`. */
  name: string
  /** Name for chrome with slightly more room: `Windbreak CLI`. */
  cliName: string
  /** One line describing what the tool is, for surfaces with room for it. */
  tagline: string
  /**
   * The brand colour in the dark theme.
   *
   * One value, because it is one decision: it is the wordmark's accent characters,
   * the theme's `primary` and `info`, and the user's own lines in the transcript.
   * A rebrand that recoloured the wordmark but left every border and heading the
   * previous product's green would read as a half-applied reskin rather than a
   * different product, which is why the theme reads this rather than restating a
   * hex code of its own.
   */
  accent: string
  /** The same colour for the light theme, where `accent` is too pale to read. */
  accentLight: string
  /** Fallback for 16-colour terminals, which have no truecolor to be given. */
  accentAnsi: string
  /** The landing screen's call to action. */
  heading: string
  /**
   * Whether the chat header draws `tagline` beneath the wordmark.
   *
   * An upstream header is wordmark-only; the Windbreak restyle adds the line, so
   * the difference between the identities is a property of the identity rather
   * than a conditional at the draw site. It also keeps the restyle from reaching
   * the Freebuff header, which is the point of the flag existing.
   */
  headerTagline: boolean
  /**
   * The full wordmark, one entry per row, left-aligned.
   *
   * Rows are data rather than a single newline-joined string so a caller can ask
   * how tall the art is without parsing it — `WORDMARK_ROWS` below is derived,
   * which is why there is no magic `6` at the call site any more. Rows are *not*
   * required to be padded to a common width: the upstream art is not, and padding
   * it here would be a change to how those two render.
   */
  wordmark: readonly string[]
  /** The narrow variant, drawn when the full wordmark will not fit. */
  monogram: readonly string[]
}

/**
 * The accent rule drawn under a mark.
 *
 * A run of `═` rather than another row of blocks, because the renderer gives `═`
 * the *accent* colour and `█` the block colour — see `use-logo`'s
 * `defaultColorChar` and `getSheenColor`, both of which only reach the accent for
 * characters in `SHADOW_CHARS`. A mark drawn purely from `█` therefore has nowhere
 * for the brand colour to appear, which is exactly what the upstream art's
 * box-drawing shadows used to provide. The rule restores that, and it brings the
 * mark to six rows — the height the landing screen's layout already reserves for
 * it, so the extra row costs nothing.
 *
 * Only the fork's mark needs it; the two upstream marks carry their own shadows.
 */
const accentRule = (glyphRows: readonly string[]): string =>
  '═'.repeat(glyphRows[0]!.length)

// 62 columns wide. Narrower than an 8-letter wordmark in the upstream font (66-67
// columns), which is what lets the *whole* name fit an 80-column terminal instead
// of collapsing to a monogram.
const WINDBREAK_GLYPHS: readonly string[] = [
  '█    █ ██████ ██   █ ████   █████  █████  ██████  ████  █    █',
  '█    █   ██   ███  █ █    █ █    █ █    █ █      █    █ █   █ ',
  '█ ██ █   ██   █ ██ █ █    █ █████  █████  █████  ██████ ████  ',
  '██  ██   ██   █  ███ █    █ █    █ █  █   █      █    █ █   █ ',
  '█    █ ██████ █   ██ ████   █████  █   █  ██████ █    █ █    █',
]

// 13 columns wide, and cut from the same glyphs as the wordmark so the two read as
// one mark at different sizes.
const WINDBREAK_MONOGRAM_GLYPHS: readonly string[] = [
  '█    █ █████ ',
  '█    █ █    █',
  '█ ██ █ █████ ',
  '██  ██ █    █',
  '█    █ █████ ',
]

// Upstream's two marks, transcribed from the art this module replaced (they were
// `LOGO_FREEBUFF` / `LOGO_CODEBUFF` in `../login/constants`). Rows carry their own
// leading space and unequal trailing padding, exactly as before, so these two
// render byte-identically to the way they did.
const FREEBUFF_GLYPHS: readonly string[] = [
  ' ███████╗██████╗ ███████╗███████╗██████╗ ██╗   ██╗███████╗███████╗',
  ' ██╔════╝██╔══██╗██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔════╝',
  ' █████╗  ██████╔╝█████╗  █████╗  ██████╔╝██║   ██║█████╗  █████╗',
  ' ██╔══╝  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██║   ██║██╔══╝  ██╔══╝',
  ' ██║     ██║  ██║███████╗███████╗██████╔╝╚██████╔╝██║     ██║',
  ' ╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚═╝     ╚═╝',
]

const FREEBUFF_MONOGRAM_GLYPHS: readonly string[] = [
  ' ███████╗██████╗',
  ' ██╔════╝██╔══██╗',
  ' █████╗  ██████╔╝',
  ' ██╔══╝  ██╔══██╗',
  ' ██║     ██████╔╝',
  ' ╚═╝     ╚═════╝',
]

const CODEBUFF_GLYPHS: readonly string[] = [
  '  ██████╗ ██████╗ ██████╗ ███████╗██████╗ ██╗   ██╗███████╗███████╗',
  ' ██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██║   ██║██╔════╝██╔════╝',
  ' ██║     ██║   ██║██║  ██║█████╗  ██████╔╝██║   ██║█████╗  █████╗',
  ' ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗██║   ██║██╔══╝  ██╔══╝',
  ' ╚██████╗╚██████╔╝██████╔╝███████╗██████╔╝╚██████╔╝██║     ██║',
  '  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝  ╚═════╝ ╚═╝     ╚═╝',
]

const CODEBUFF_MONOGRAM_GLYPHS: readonly string[] = [
  '  ██████╗ ██████╗',
  ' ██╔════╝ ██╔══██╗',
  ' ██║      ██████╔╝',
  ' ██║      ██╔══██╗',
  ' ╚██████╗ ██████╔╝',
  '  ╚═════╝ ╚═════╝',
]

const WINDBREAK: BrandIdentity = {
  name: 'Windbreak',
  cliName: 'Windbreak CLI',
  tagline: 'AI-assisted vulnerability discovery',
  // Cold and bright: a windbreak is a windward barrier, and the palette should not
  // be mistakable for the green it replaced.
  accent: '#5CE1E6',
  accentLight: '#0E7490',
  accentAnsi: 'cyan',
  heading: 'Start coding with Windbreak',
  headerTagline: true,
  wordmark: [...WINDBREAK_GLYPHS, accentRule(WINDBREAK_GLYPHS)],
  monogram: [...WINDBREAK_MONOGRAM_GLYPHS, accentRule(WINDBREAK_MONOGRAM_GLYPHS)],
}

const FREEBUFF: BrandIdentity = {
  name: 'Freebuff',
  cliName: 'Freebuff CLI',
  tagline: 'Free AI coding assistant',
  accent: '#9EFC62',
  accentLight: '#65A83E',
  accentAnsi: 'lime',
  heading: 'Start coding for free',
  // Upstream's header is wordmark-only; the tagline line is part of the fork's restyle.
  headerTagline: false,
  wordmark: FREEBUFF_GLYPHS,
  monogram: FREEBUFF_MONOGRAM_GLYPHS,
}

const CODEBUFF: BrandIdentity = {
  name: 'Codebuff',
  cliName: 'Codebuff CLI',
  tagline: 'AI coding assistant',
  accent: '#9EFC62',
  accentLight: '#65A83E',
  accentAnsi: 'lime',
  heading: 'Start coding for free',
  headerTagline: false,
  wordmark: CODEBUFF_GLYPHS,
  monogram: CODEBUFF_MONOGRAM_GLYPHS,
}

/**
 * Which identity a given invocation draws.
 *
 * Split out from `BRAND` so the rule can be exercised directly: the live constant
 * can only ever show one of these four combinations, because it is resolved once
 * from this process's own `argv`. A Windbreak invocation wins in either build, so a
 * `build:binary:codebuff` binary run as `codebuff windbreak` still draws Windbreak.
 */
export const resolveBrand = (
  invokedAsWindbreak: boolean,
  isFreebuffBuild: boolean,
): BrandIdentity =>
  invokedAsWindbreak ? WINDBREAK : isFreebuffBuild ? FREEBUFF : CODEBUFF

/**
 * Whether this process was launched as the `windbreak` subcommand.
 *
 * Read once, here, because the answer cannot change during a run and because it
 * has to be read before `argv` is rewritten — see this module's header comment for
 * why that timing matters.
 */
const INVOKED_AS_WINDBREAK = findWindbreakCommand(process.argv) !== null

export const BRAND: BrandIdentity = resolveBrand(
  INVOKED_AS_WINDBREAK,
  IS_FREEBUFF,
)

/**
 * Rows in the full wordmark.
 *
 * A caller with less vertical budget than this collapses to the text variant. It
 * is derived rather than written down because the height is a property of the art:
 * every mark happens to be six rows today, but a redrawn one would not have to be,
 * and a shared constant would then be wrong for whichever did not change.
 */
export const WORDMARK_ROWS = BRAND.wordmark.length

/**
 * The full wordmark as one newline-delimited string, for callers that already
 * parse it that way (`parseLogoLines` in `../login/utils`).
 */
export const WORDMARK_TEXT = BRAND.wordmark.join('\n')

/** The monogram as one newline-delimited string. */
export const MONOGRAM_TEXT = BRAND.monogram.join('\n')

/**
 * The uppercase name, which is what the logo hook uses as its sentinel for "the
 * caller asked for the text variant, not art".
 *
 * Derived from `BRAND.name` so the sentinel cannot drift from the identity it
 * stands for — a rename changes both at once, and a stale sentinel would silently
 * render the bare word as ASCII art.
 */
export const BRAND_NAME_UPPER = BRAND.name.toUpperCase()
