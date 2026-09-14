/**
 * Untrusted-content pre-pass (spec §5.1 rule 2).
 *
 * Repo text is always data, never instruction. This module does not delete
 * instruction-like content — deleting it would change the code under analysis —
 * it *flags* it, and the escalation stage escapes it before anything reaches a
 * prompt. Recording the signals on the candidate means a hostile repository is
 * visible in state before any model reads it.
 */

export interface InjectionSignal {
  kind: InjectionSignalKind
  /** The offending text, truncated so state rows stay small. */
  evidence: string
  line: number
}

export type InjectionSignalKind =
  | 'instruction-override'
  | 'role-marker'
  | 'tool-call-syntax'
  | 'agent-directed'
  | 'encoded-blob'

const MAX_EVIDENCE_CHARS = 120

interface SignalRule {
  kind: InjectionSignalKind
  pattern: RegExp
}

/**
 * Ordered so the most specific kind wins for a line; a `system:` message is
 * recorded as a role marker rather than as a generic override.
 */
const SIGNAL_RULES: SignalRule[] = [
  {
    kind: 'instruction-override',
    pattern:
      /\b(ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(previous|prior|above|earlier|foregoing)\b/i,
  },
  { kind: 'instruction-override', pattern: /\bdo\s+not\s+(?:flag|report|warn|mention)\b/i },
  {
    kind: 'role-marker',
    pattern: /^\s*(?:system|assistant|developer)\s*:/i,
  },
  {
    kind: 'role-marker',
    pattern: /<\|?\s*(?:im_start|im_end|system|assistant|endoftext)\s*\|?>/i,
  },
  {
    kind: 'agent-directed',
    pattern:
      /\b(you\s+are|as\s+an?\s+ai|language\s+model|assistant|agent)\b[^.\n]{0,40}\b(must|should|will|shall)\b/i,
  },
  {
    kind: 'agent-directed',
    pattern: /\b(this\s+(?:code|function|file)\s+is\s+(?:safe|benign|secure|already\s+(?:checked|validated)))/i,
  },
  {
    kind: 'tool-call-syntax',
    pattern: /(?:^|\s)(?:tool_call|function_call|invoke|tool_use)\s*[(<:]/i,
  },
  { kind: 'tool-call-syntax', pattern: /^\s*```(?:json|tool_call)/i },
  {
    kind: 'encoded-blob',
    pattern: /(?:base64|atob|fromCharCode|eval)\s*\(/i,
  },
  {
    kind: 'encoded-blob',
    pattern: /[A-Za-z0-9+/]{200,}={0,2}/,
  },
]

const truncate = (text: string): string =>
  text.length <= MAX_EVIDENCE_CHARS
    ? text
    : `${text.slice(0, MAX_EVIDENCE_CHARS)}…`

/**
 * Scan text for instruction-like content. Line numbers are 1-based and relative
 * to the text passed in, so callers must pass the slice they intend to reason
 * about (the candidate's snippet or enclosing function).
 */
export const detectInjectionSignals = (text: string): InjectionSignal[] => {
  const signals: InjectionSignal[] = []
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    for (const rule of SIGNAL_RULES) {
      if (rule.pattern.test(line)) {
        signals.push({
          kind: rule.kind,
          evidence: truncate(line.trim()),
          line: index + 1,
        })
        break
      }
    }
  }

  return signals
}

/** Compact form stored on the candidate row. */
export const injectionSignalSummary = (signals: InjectionSignal[]): string[] =>
  signals.map((signal) => `${signal.kind}@L${signal.line}: ${signal.evidence}`)
