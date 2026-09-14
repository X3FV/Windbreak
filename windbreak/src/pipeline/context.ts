/**
 * Context isolation (spec §5.1).
 *
 * Repo content is always data, never instruction. This module builds the one
 * evidence bundle every role sees, and renders it into a delimited, escaped
 * block. §5.1 rule 4 requires the rendering to be byte-identical across triage,
 * Proposer, and Refuter, so there is exactly one render function and every role
 * calls it with the same bundle.
 *
 * Instruction-like lines are *neutralized, not deleted* (§5.1 rule 2): deleting
 * them would change the code under analysis, and escaping preserves semantics
 * while making the attempt structurally inert and visible.
 */

import { detectInjectionSignals } from '../trust/injection'
import { MODEL_PROPOSED_SOURCES } from '../engines/types'
import { normalizeArtifactUri } from '../engines/sarif'

import type { CallSite, EvidenceBundle } from './types'
import type { InjectionSignal } from '../trust/injection'
import type { NormalizedCandidate } from '../engines/types'

/**
 * Bump when a prompt template changes shape. It is part of the §8.4 cache key,
 * so a stale template cannot silently replay a verdict produced under a
 * different prompt (spec §18, "cache poisoning / stale template").
 */
export const PROMPT_TEMPLATE_VERSION = 'windbreak-prompt-v1'

/**
 * Read-only lookups against the recon program model (§14.1 `symbols`,
 * `symbol_refs`). Injected so the bundle builder stays testable and so a
 * missing program model degrades to "no context" rather than throwing.
 */
export interface ProgramContextSource {
  /** The function containing a line, per the symbol index. */
  enclosingFunction(
    filePath: string,
    line: number,
  ): { name: string; startLine: number; endLine: number } | null
  /** Recorded call sites of a symbol, most recent last. */
  callers(name: string): CallSite[]
}

export interface BuildEvidenceInput {
  filePath: string | null
  startLine: number | null
  endLine: number | null
  language: string | null
  normalized: NormalizedCandidate | null
  programContext?: ProgramContextSource | undefined
  /** Skip program-model lookups entirely; used for the un-enriched first pass. */
  enrich?: boolean
}

/**
 * Assemble the evidence bundle.
 *
 * `enrich: false` is the §4.6 first pass. The second pass (`enrich: true`) adds
 * the enclosing function and its callers — the context a `needs-context` label
 * is asking for — and nothing else, so the two passes differ only by added
 * context.
 */
export const buildEvidenceBundle = (input: BuildEvidenceInput): EvidenceBundle => {
  const snippet = input.normalized?.snippet ?? null
  const enrich = input.enrich ?? true

  let enclosingFunction: string | null = null
  let callers: CallSite[] = []

  if (
    enrich &&
    input.programContext &&
    input.filePath !== null &&
    input.startLine !== null
  ) {
    const enclosing = input.programContext.enclosingFunction(
      input.filePath,
      input.startLine,
    )
    if (enclosing) {
      enclosingFunction = enclosing.name
      callers = input.programContext.callers(enclosing.name)
    }
  }

  // Recomputing from the snippet guarantees the escape below matches the exact
  // text being rendered; the stored summary stays the audit trail.
  const injectionSignals: InjectionSignal[] = snippet
    ? detectInjectionSignals(snippet)
    : []

  return {
    filePath: input.filePath ?? '(unknown)',
    startLine: input.startLine ?? 0,
    endLine: input.endLine,
    language: input.language,
    snippet,
    enclosingFunction,
    callers,
    injectionSignals,
  }
}

const KIND_LABEL: Record<InjectionSignal['kind'], string> = {
  'instruction-override': 'instruction-override',
  'role-marker': 'role-marker',
  'tool-call-syntax': 'tool-call-syntax',
  'agent-directed': 'agent-directed',
  'encoded-blob': 'encoded-blob',
}

export const OPEN_FENCE = '<<<TARGET_CONTENT_UNTRUSTED>>>'
export const CLOSE_FENCE = '<<<END_TARGET_CONTENT_UNTRUSTED>>>'

/**
 * Wrap flagged lines in the `<untrusted-escaped>` element.
 *
 * The same wrapper as the evidence bundle, and it is exported for the same reason
 * `TRUST_PREAMBLE` is: the investigator's tool results (§20.29.3) are the *second*
 * place target text reaches a model, and a second implementation of the escape
 * would be a second thing to keep in step with §5.1. The fence characters stay
 * outside this function so a tool result and an evidence bundle cannot drift apart
 * in how they delimit untrusted content.
 */
export const escapeUntrustedLines = (
  text: string,
  signals: InjectionSignal[],
): { text: string; escapedLines: number } => {
  const flagged = new Map<number, InjectionSignal['kind']>()
  for (const signal of signals) {
    if (!flagged.has(signal.line)) flagged.set(signal.line, signal.kind)
  }

  const lines = text.length > 0 ? text.split('\n') : []
  const rendered: string[] = []
  let escapedLines = 0

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const kind = flagged.get(lineNumber)
    if (kind) {
      escapedLines += 1
      rendered.push(
        `<untrusted-escaped signal="${KIND_LABEL[kind]}" line="${lineNumber}">${lines[index]}</untrusted-escaped>`,
      )
    } else {
      rendered.push(lines[index]!)
    }
  }

  return { text: rendered.join('\n'), escapedLines }
}

/**
 * neutralize-and-delimit arbitrary target text, for callers that are not the
 * evidence bundle.
 *
 * Detection, escaping, and fencing in one call, so a tool result cannot be escaped
 * without also being fenced — the two are one operation because a fence without the
 * escape leaks instruction-like lines and an escape without the fence leaves the
 * model to guess whether the text is data. The signals come back so the caller can
 * record what it neutralized, which is what makes §20.29.3's second consequence
 * possible: a stored investigator answer can be read back with its signals.
 */
export const neutralizeUntrustedText = (
  label: string,
  text: string,
): { text: string; signals: InjectionSignal[]; escapedLines: number } => {
  const signals = detectInjectionSignals(text)
  const escaped = escapeUntrustedLines(text, signals)

  return {
    text: [OPEN_FENCE, label, '', escaped.text, CLOSE_FENCE].join('\n'),
    signals,
    escapedLines: escaped.escapedLines,
  }
}

export interface RenderedEvidence {
  /** The escaped, delimited block. Identical for every role. */
  text: string
  /** Number of lines that were neutralized as instruction-like. */
  escapedLines: number
}

/**
 * Render a bundle into the escaped block.
 *
 * A flagged line is wrapped in an element that names the signal and its line,
 * rather than being prefixed or stripped. The original text survives verbatim
 * inside the wrapper, so the code under analysis is unchanged, and the model is
 * told once — outside the fence — that everything inside is data.
 */
export const renderEvidence = (bundle: EvidenceBundle): RenderedEvidence => {
  const snippet = bundle.snippet ?? ''
  const lines = snippet.length > 0 ? snippet.split('\n') : []
  const escaped = escapeUntrustedLines(snippet, bundle.injectionSignals)

  const header: string[] = [
    `file: ${normalizeArtifactUri(bundle.filePath)}`,
    `lines: ${bundle.startLine}${bundle.endLine !== null ? `-${bundle.endLine}` : ''}`,
  ]
  if (bundle.language) header.push(`language: ${bundle.language}`)
  if (bundle.enclosingFunction) {
    header.push(`enclosing function: ${bundle.enclosingFunction}`)
  }
  if (bundle.callers.length > 0) {
    header.push(
      'known call sites:',
      ...bundle.callers
        .slice(0, 10)
        .map((site) => `  - ${site.name} @ ${site.filePath}:${site.line}`),
    )
  }

  const body = lines.length > 0 ? escaped.text : '(no source text available for this location)'

  return {
    text: [OPEN_FENCE, ...header, '', body, CLOSE_FENCE].join('\n'),
    escapedLines: escaped.escapedLines,
  }
}

/**
 * Sources that are not detectors, and so must not be described as one.
 *
 * `CANDIDATE_SOURCES` mixes two kinds of thing, and the name of the field (`source`) is
 * what hid it: most of the union is an engine that ran and reported, while these are
 * facts about where a candidate came from that no detector produced. `primevul` is a
 * corpus, and `investigator` is a model that read the target.
 *
 * The distinction is not stylistic. This string is the *front matter of a prompt*: the
 * Proposer and Refuter read it before they read the evidence, and "detected by:
 * investigator" tells two models that a scanner flagged this. §20.29.4 is explicit that
 * a model's opinion must not read as an engine match, and §15 records that a framing
 * difference like this one moves detection by up to 93%.
 */
const NON_DETECTOR_SOURCES = new Set<string>([
  // A corpus: the function was seeded by §11.1, not flagged by anything.
  'primevul',
  // A model that read the target and proposed a location.
  ...MODEL_PROPOSED_SOURCES,
])

export const describeCandidateProvenance = (input: {
  source: string
  patternId: string | null
  cwe: string | null
  ruleMessage: string | null
}): string => {
  const proposed = NON_DETECTOR_SOURCES.has(input.source)

  const parts = [
    proposed ? `proposed by: ${input.source}` : `detected by: ${input.source}`,
  ]

  if (proposed) {
    // One line, because the two roles otherwise have no way to tell this apart from an
    // engine finding: a scanner did not run, and a model — not a rule — chose the
    // location. §20.29.4's "chat-then-confirm and engine-then-verify fail in completely
    // different ways" is a fact the reviewer needs at the point of judgement.
    parts.push(
      'provenance: no detector produced this; a model read the target and proposed the ' +
        'location. Weigh it accordingly, and judge the code rather than the claim.',
    )
  }

  if (input.patternId) parts.push(`pattern: ${input.patternId}`)
  if (input.cwe) parts.push(`class: ${input.cwe}`)
  if (input.ruleMessage) {
    parts.push(
      proposed ? `proposed claim: ${input.ruleMessage}` : `engine message: ${input.ruleMessage}`,
    )
  }
  return parts.join('\n')
}
