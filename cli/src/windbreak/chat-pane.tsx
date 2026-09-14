import React from 'react'

import { BORDER_CHARS } from '../utils/ui-constants'

import { CHAT_EXHAUSTED_NOTE, CHAT_HINTS } from './chat-lines'
import { useWindbreakColors } from './colors-context'

/**
 * The chat pane (spec §20.29.4, §20.29.5 slice 5).
 *
 * It used to occupy the decision card's slot. Since §20.32 it takes the body, with the
 * queue kept as a narrow rail beside it — because a model's answer is a *paragraph* and a
 * 30-column slot was showing the first clause of every one of them. The old arrangement's
 * argument (the pane is for asking, the card for recording, and a researcher does one or
 * the other) still holds; what changed is the realisation that it also implied the
 * answering half deserved the room of a whole screen, since a transcript is read and a
 * card is glanced at.
 *
 * The palette is the screen's existing named elements rather than new ones: the body is
 * `detailText` because it is reading text, the frame is `frameFocused` while focused, the
 * notice and error tones are the ones §5.1's evidence already uses for the same purposes.
 * That means a settings file's existing overrides reach this pane, which is the outcome
 * §20.16's per-element naming was for.
 *
 * The pane does not own the transcript's *content* — `chat-lines.ts` builds the lines —
 * and it does not run the turn. It renders what it is given: the same split the other two
 * panes use.
 */

interface ChatPaneProps {
  /** The transcript, already wrapped by `wrapChatLines`. */
  lines: string[]
  /** First visible row. */
  offset: number
  /** Content rows the pane can show. */
  height: number
  width: number
  /**
   * The line above the input: the conversation's budget and what the next question is
   * about (see `describeBudget` and `describeChatTarget`). Joined by the caller because
   * they are two readings of the same row rather than two rows of chrome.
   */
  infoLine: string
  /**
   * Which agent the next question goes to, for the pane's title (§20.30).
   *
   * In the title rather than only in the info line because the title is always
   * drawn: a pane whose active agent is off the right-hand edge of a narrow terminal
   * is a pane that looks the same for both agents.
   */
  agentLabel: string
  /** Set while a turn is running, so the input is disabled and the pane says so. */
  pending: boolean
  /** True once the conversation's ceiling is spent; the input is replaced with why. */
  exhausted: boolean
  /** Null when the investigator is unavailable; the reason when it is. */
  unavailableReason: string | null
  input: string
  onInput: (value: string) => void
  onSubmit: () => void
  focused: boolean
}

/**
 * Colour a transcript line by its prefix.
 *
 * The prefixes are `chat-lines.ts`'s contract, not decoration: `!` is a refusal or a
 * warning, `›` is the researcher, and the recorded-candidate block is the one line a
 * reader must not mistake for the model's prose. Colouring them is how a long answer stays
 * skimmable.
 */
const lineColor = (
  line: string,
  colors: ReturnType<typeof useWindbreakColors>,
): string => {
  if (line.startsWith('  !')) return colors.decisionError
  if (line.startsWith('you(') || line.startsWith('you ')) return colors.headerText
  // `edited` is the working-copy block (§20.30): a write is a recorded fact like a
  // proposal, so it shares the notice tone rather than the prose one.
  if (/^\s+(recorded|refused|edited)/.test(line)) return colors.decisionNotice
  if (line.startsWith('  [')) return colors.decisionMeta
  if (line.startsWith('  ')) return colors.detailText
  return colors.decisionMeta
}

export const ChatPane: React.FC<ChatPaneProps> = ({
  lines,
  offset,
  height,
  width,
  agentLabel,
  infoLine,
  pending,
  exhausted,
  unavailableReason,
  input,
  onInput,
  onSubmit,
  focused,
}) => {
  const colors = useWindbreakColors()

  // The last two rows are the info line and the input; the transcript gets the rest — less
  // one more when there is a "more above" row, which is drawn *inside* this box and would
  // otherwise push the input past the pane's own height.
  const provisionalRows = Math.max(0, height - 2)
  // Decided before the rows are fixed, from the offset the caller asked for: the indicator
  // only appears when the transcript is scrolled off the top, and it is drawn inside this
  // box, so its row has to come out of the transcript's budget rather than out of the
  // pane's chrome.
  const willScroll =
    lines.length > provisionalRows &&
    Math.min(Math.max(0, offset), Math.max(0, lines.length - provisionalRows)) > 0
  const transcriptRows = Math.max(0, provisionalRows - (willScroll ? 1 : 0))
  const maxOffset = Math.max(0, lines.length - transcriptRows)
  const safeOffset = Math.min(Math.max(0, offset), maxOffset)
  const visible = lines.slice(safeOffset, safeOffset + transcriptRows)
  const stillMore = Math.max(0, lines.length - transcriptRows - safeOffset)

  return (
    <box
      title={pending ? ` ${agentLabel} — working ` : ` ${agentLabel} `}
      style={{
        width,
        height: height + 2,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: focused ? colors.frameFocused : colors.frame,
        titleColor: colors.title,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      {visible.map((line, index) => (
        <text key={index} style={{ fg: lineColor(line, colors) }}>
          {line.length > width - 2 ? `${line.slice(0, width - 5)}…` : line}
        </text>
      ))}

      {stillMore > 0 ? (
        <text style={{ fg: colors.decisionMeta }}>{`  … ${stillMore} more above`}</text>
      ) : null}

      <text style={{ fg: exhausted ? colors.decisionError : colors.decisionMeta }}>
        {(unavailableReason ? '! unavailable' : infoLine).slice(0, Math.max(0, width - 2))}
      </text>

      {unavailableReason ? (
        // The reason, not an empty input: a pane that looks ready and silently does
        // nothing is §18 in the screen.
        <text style={{ fg: colors.decisionError }}>{unavailableReason.slice(0, width - 4)}</text>
      ) : exhausted ? (
        // Same rule, one layer in: a spent ceiling is a fact the researcher needs, not an
        // input that quietly refuses to accept anything.
        <text style={{ fg: colors.decisionError }}>
          {CHAT_EXHAUSTED_NOTE.slice(0, width - 4)}
        </text>
      ) : (
        <input
          value={input}
          focused={focused && !pending}
          placeholder={CHAT_HINTS}
          onInput={onInput}
          onSubmit={onSubmit}
        />
      )}
    </box>
  )
}
