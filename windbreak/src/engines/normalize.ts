import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import { detectInjectionSignals, injectionSignalSummary } from '../trust/injection'

import type { Candidate, CandidateState, NormalizedCandidate, RawFinding } from './types'

/**
 * Raw engine finding -> §4.5 candidate.
 *
 * The candidate is bound to the exact source it was derived from by a slice
 * hash. If the file changes under a run, the hash stops matching and a
 * downstream stage can invalidate the candidate instead of reasoning about
 * different code than the engine saw.
 */

export const DEFAULT_CONTEXT_LINES = 2
export const DEFAULT_MAX_SOURCE_BYTES = 2_000_000

/** How many lines of the matched region a candidate carries. */
export const DEFAULT_MAX_SNIPPET_LINES = 40

export const candidateId = (
  runId: string,
  finding: RawFinding,
): string =>
  `cand_${createHash('sha256')
    .update(
      `${runId}:${finding.engine}:${finding.ruleId}:${finding.filePath}:${finding.startLine}`,
    )
    .digest('hex')
    .slice(0, 24)}`

export const hashSlice = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 32)

/**
 * Reads target files once per run.
 *
 * Engines routinely report many findings in one file, and reading it per
 * finding would dominate the stage's cost on a large target.
 */
export class SourceCache {
  private readonly files = new Map<string, string[] | null>()

  constructor(
    private readonly root: string,
    private readonly maxBytes: number = DEFAULT_MAX_SOURCE_BYTES,
  ) {}

  lines(filePath: string): string[] | null {
    const cached = this.files.get(filePath)
    if (cached !== undefined) return cached

    let result: string[] | null = null
    try {
      const absolute = path.join(this.root, filePath)
      const stat = fs.statSync(absolute)
      if (stat.isFile() && stat.size <= this.maxBytes) {
        const lines = fs.readFileSync(absolute, 'utf8').split('\n')
        // A file ending in a newline splits to a trailing empty element, which
        // is not a line. Keeping it would add a dangling newline to any slice
        // that reaches the end of the file.
        if (lines.length > 1 && lines.at(-1) === '') lines.pop()
        result = lines
      }
    } catch {
      result = null
    }

    this.files.set(filePath, result)
    return result
  }
}

export interface NormalizeOptions {
  runId: string
  targetRoot: string
  sourceCache?: SourceCache
  contextLines?: number
  maxSnippetLines?: number
  state?: CandidateState
}

/**
 * Extract the matched region plus a little context.
 *
 * The engine's own snippet is used only as a fallback: SARIF snippets are
 * truncated and their line offsets are not trustworthy, so a slice read from
 * the file is the authoritative text and the authoritative hash.
 */
export const extractSlice = (
  lines: string[],
  startLine: number,
  endLine: number | null,
  contextLines: number,
  maxSnippetLines: number,
): { text: string; start: number; end: number } | null => {
  if (startLine < 1 || startLine > lines.length) return null

  const last = endLine !== null && endLine >= startLine ? endLine : startLine
  const from = Math.max(1, startLine - contextLines)
  const to = Math.min(
    lines.length,
    Math.min(last + contextLines, from + maxSnippetLines - 1),
  )

  return {
    text: lines.slice(from - 1, to).join('\n'),
    start: from,
    end: to,
  }
}

export const normalizeFinding = (
  finding: RawFinding,
  options: NormalizeOptions,
): Candidate => {
  const sourceCache =
    options.sourceCache ?? new SourceCache(options.targetRoot)
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES
  const maxSnippetLines = options.maxSnippetLines ?? DEFAULT_MAX_SNIPPET_LINES

  const lines = sourceCache.lines(finding.filePath)
  const slice = lines
    ? extractSlice(
        lines,
        finding.startLine,
        finding.endLine,
        contextLines,
        maxSnippetLines,
      )
    : null

  const snippet = slice?.text ?? finding.snippet
  const sliceHash =
    slice !== null ? hashSlice(slice.text) : null

  // Signals are computed from the text the candidate will actually carry, so a
  // hostile repository is visible in state before any model reads it (§5.1).
  const signals = snippet ? detectInjectionSignals(snippet) : []

  const normalized: NormalizedCandidate = {
    engine: finding.engine,
    ruleId: finding.ruleId,
    message: finding.message,
    level: finding.level,
    filePath: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    snippet,
    sliceHash,
    precision: finding.precision,
  }

  return {
    id: candidateId(options.runId, finding),
    source: finding.engine,
    patternId: finding.ruleId,
    filePath: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    cwe: finding.cwe,
    state: options.state ?? 'new',
    normalized,
    injectionSignals: injectionSignalSummary(signals),
  }
}

export interface NormalizeResult {
  candidates: Candidate[]
  /** Findings whose file could not be read at all. */
  unresolvedSlices: number
  /** Findings dropped as duplicates of an earlier one in the same run. */
  duplicates: number
}

/**
 * Normalize a run's findings and drop duplicates.
 *
 * Duplicates within one engine share a rule, file, and line, so the identity is
 * (engine, ruleId, path, line). Cross-engine duplicates are deliberately kept:
 * two engines agreeing is signal a later stage may want, and collapsing them
 * would destroy provenance the §4.5 schema exists to record.
 */
export const normalizeFindings = (
  findings: readonly RawFinding[],
  options: NormalizeOptions,
): NormalizeResult => {
  const sourceCache =
    options.sourceCache ?? new SourceCache(options.targetRoot)
  const seen = new Set<string>()
  const candidates: Candidate[] = []
  let unresolvedSlices = 0
  let duplicates = 0

  for (const finding of findings) {
    const key = `${finding.engine}:${finding.ruleId}:${finding.filePath}:${finding.startLine}`
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)

    const candidate = normalizeFinding(finding, { ...options, sourceCache })
    if (candidate.normalized.sliceHash === null) unresolvedSlices += 1
    candidates.push(candidate)
  }

  return { candidates, unresolvedSlices, duplicates }
}
