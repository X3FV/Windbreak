/**
 * Deciding whether a fuzzer's crash is *this* finding reproducing (spec §20.35).
 *
 * A generated target calls a function whose parameter list the symbol index does
 * not record (`target.ts`), so "the process died" is not evidence of anything on
 * its own. This module is the second of the two gates — the first is
 * `decidable.ts` — and both must agree before a run is allowed to move a finding's
 * evidence tier:
 *
 * 1. **the category** — the sanitizer's own signature must be one this class is
 *    known to produce, so a `heap-buffer-overflow` cannot confirm a null
 *    dereference and a bare `SEGV` cannot confirm a buffer overrun;
 * 2. **the location** — the report must land in the finding's own file, at the
 *    finding's line or inside the function the finding named.
 *
 * ## The negative answer is the one to be careful about
 *
 * `not-reproduced` is **not** a refutation. A bounded fuzz run that finds nothing
 * is the normal outcome for a real defect that needs a long or specific input, and
 * `harness.ts` says the same thing in prose for the classes this stage already
 * refuses. So nothing here can lower a tier: the caller records the outcome and
 * leaves the finding exactly as it was. Silence is silence, never a denial.
 *
 * Pure: it reads text and returns a verdict. The spawn is `run.ts`'s job.
 */

import { FUZZ_DECIDABLE, cweKey } from './decidable'

export interface SanitizerFrame {
  index: number
  /** Symbol name, when the frame carries one. */
  functionName: string | null
  filePath: string | null
  line: number | null
  /**
   * Offset into the binary, when the sanitizer could not symbolize the frame.
   *
   * ASan prints `in handler /src/unsafe.c:11` only when it can find a symbolizer,
   * and there is no `llvm-symbolizer` on the machine this was built against — it
   * falls back to `(/scratch/bin+0x52bf0d)`, which names no file and no line. The
   * offset is kept so `symbolize.ts` can resolve it out-of-band; without that step
   * the location gate has nothing to check and every real crash reads as
   * `unattributed`.
   */
  moduleOffset: number | null
}

export interface SanitizerReport {
  /** The sanitizer's own category: `heap-buffer-overflow`, `signed integer overflow`, … */
  signature: string
  /** Which runtime said it, so the record can name the tool. */
  tool: string
  frames: SanitizerFrame[]
  /**
   * Where UBSan reported it.
   *
   * UBSan prints one diagnostic line rather than a stack, so its location does
   * not arrive as a frame and has to be carried separately or the location gate
   * would have nothing to check.
   */
  reportedAt: { filePath: string; line: number } | null
}

/**
 * `==1234==ERROR: AddressSanitizer: heap-buffer-overflow on address …`
 *
 * The `==pid==` prefix is real and is not optional in ASan's output — matching
 * only a bare `ERROR:` silently misses every genuine report and falls through to
 * the SUMMARY branch, which carries no stack at all.
 */
const ASAN_ERROR =
  /^\s*(?:==\d+==)?\s*ERROR:\s*(AddressSanitizer|LeakSanitizer|HWAddressSanitizer):\s*(.+?)\s*$/m
/** `SUMMARY: AddressSanitizer: heap-buffer-overflow …/file.c:12 in fn` */
const ASAN_SUMMARY = /^\s*(?:==\d+==)?\s*SUMMARY:\s*(AddressSanitizer|LeakSanitizer):\s*([^\s(]+)/m
/** `file.c:12:3: runtime error: signed integer overflow: …` */
const UBSAN_ERROR = /^\s*(.+?):(\d+):(\d+):\s*runtime error:\s*(.+?)\s*$/m
/** `    #0 0x55f0 in handler /src/unsafe.c:11:4` — the sanitizer symbolized it. */
const FRAME_SYMBOLIZED = /^\s*#(\d+)\s+0x[0-9a-fA-F]+\s+in\s+(\S+)\s+(.+?)\s*$/
/** `    #0 0x55f0  (/scratch/bin+0x52bf0d) (BuildId: …)` — it could not. */
const FRAME_UNSYMBOLIZED = /^\s*#(\d+)\s+0x[0-9a-fA-F]+\s+\(\S*\+0x([0-9a-fA-F]+)\)/

/**
 * The category alone, out of the rest of ASan's header line.
 *
 * ASan continues after the category with the address and registers —
 * `stack-buffer-overflow on address 0x7ffd… at pc 0x… bp 0x…` — and that is
 * where the report's own details live, not in the signature. LeakSanitizer's
 * `detected memory leaks` has no such tail and passes through whole. Stored
 * normalized because this string goes into the record a reader is shown.
 */
const normaliseSignature = (raw: string): string =>
  raw.split(/\s+on\s+(?:unknown\s+)?address/i)[0]!.trim()

/** Strip a trailing `(discriminator 2)` / `(BuildId: …)` before parsing a location. */
const LOCATION = /^(.*?):(\d+)(?::\d+)?$/

const locationOf = (raw: string): { filePath: string; line: number } | null => {
  const withoutNote = raw.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const match = LOCATION.exec(withoutNote)
  if (!match) return null
  const line = Number.parseInt(match[2]!, 10)
  if (!Number.isFinite(line)) return null
  return { filePath: match[1]!, line }
}

/**
 * The first sanitizer report in a run's output, or null.
 *
 * "First" rather than "worst": a sanitized process usually dies on the first
 * report, and picking the most severe of several would be a judgement this stage
 * has no basis for. ASan is preferred over UBSan because the memory classes are
 * the ones with a reliable location, and that is the gate that matters.
 */
/**
 * Every `#N … in fn file:line` frame in the output.
 *
 * Read from the whole text rather than the ERROR line's tail, because ASan
 * interleaves prose (`WRITE of size 6 at …`) between the header and the stack,
 * and a SUMMARY-only capture can still carry frames worth having.
 */
const parseFrames = (text: string): SanitizerFrame[] => {
  const frames: SanitizerFrame[] = []
  for (const line of text.split('\n')) {
    const symbolized = FRAME_SYMBOLIZED.exec(line)
    if (symbolized) {
      const where = locationOf(symbolized[3]!)
      frames.push({
        index: Number.parseInt(symbolized[1]!, 10),
        functionName: symbolized[2] === '??' ? null : symbolized[2]!,
        filePath: where?.filePath ?? null,
        line: where?.line ?? null,
        moduleOffset: null,
      })
      continue
    }

    const raw = FRAME_UNSYMBOLIZED.exec(line)
    if (raw) {
      frames.push({
        index: Number.parseInt(raw[1]!, 10),
        functionName: null,
        filePath: null,
        line: null,
        moduleOffset: Number.parseInt(raw[2]!, 16),
      })
    }
  }
  return frames
}

export const parseSanitizerReport = (text: string): SanitizerReport | null => {
  const asan = ASAN_ERROR.exec(text)
  if (asan) {
    return {
      signature: normaliseSignature(asan[2]!),
      tool: asan[1]!,
      frames: parseFrames(text),
      reportedAt: null,
    }
  }

  // A truncated capture, or a sanitizer that only reached SUMMARY, still tells us
  // what it saw — and the stack below it may have survived even when the header line did not.
  const summary = ASAN_SUMMARY.exec(text)
  if (summary) {
    return {
      signature: normaliseSignature(summary[2]!),
      tool: summary[1]!,
      frames: parseFrames(text),
      reportedAt: null,
    }
  }

  const ubsan = UBSAN_ERROR.exec(text)
  if (ubsan) {
    // UBSan's message carries the operands after a colon — "signed integer
    // overflow: 2147483647 + 1 cannot be represented …" — and the category is
    // only the head of it.
    const signature = ubsan[4]!.split(':')[0]!.trim()
    return {
      signature,
      tool: 'UndefinedBehaviorSanitizer',
      frames: [],
      reportedAt: { filePath: ubsan[1]!, line: Number.parseInt(ubsan[2]!, 10) },
    }
  }

  return null
}

/**
 * Whether a path from a sanitizer report is the file the finding names.
 *
 * The report carries an absolute path inside the sandbox's scratch tree and the
 * finding carries a repository-relative one, so this compares on the tail.
 *
 * **What that does not guarantee, stated rather than implied:** a file at
 * `other/src/unsafe.c` in the same repository still matches a finding on
 * `src/unsafe.c`, because the tail is all this has. The separator is required so
 * `handlers.c` cannot match `handler.c`, which is the common case, and the class
 * and line/function gates in `attributeReport` are what bound the rest.
 */
export const sameFile = (reported: string, findingPath: string): boolean => {
  const normalise = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '')
  const a = normalise(reported)
  const b = normalise(findingPath)
  return a === b || a.endsWith(`/${b}`)
}

export type AttributionVerdict =
  | {
      outcome: 'confirmed'
      detail: string
      signature: string
      location: { filePath: string; line: number }
    }
  | { outcome: 'unattributed'; detail: string; signature: string }
  | { outcome: 'not-reproduced'; detail: string }

export interface AttributionInput {
  /** Parsed from the run's output; null when nothing fired. */
  report: SanitizerReport | null
  /** True when the run was killed at its budget rather than exiting. */
  timedOut: boolean
  cwe: string | null
  /** The finding's own location and the function it sits in. */
  filePath: string | null
  startLine: number | null
  endLine: number | null
  functionName: string | null
}

export interface LocationMatch {
  filePath: string
  line: number
}

/**
 * The report's own location, when it is the finding's code.
 *
 * Two ways to qualify, and the second exists because the first would be too
 * strict: the line is inside the range the detector matched, **or** the frame is
 * the function the finding named. A crash at line 11 of a function whose finding
 * covers lines 11-12 qualifies both ways; one reported a few lines further into
 * the same function still qualifies, because the function is what was called.
 */
export const locationMatch = (
  report: SanitizerReport,
  input: Pick<AttributionInput, 'filePath' | 'startLine' | 'endLine' | 'functionName'>,
): LocationMatch | null => {
  if (!input.filePath) return null
  const candidates: Array<{ filePath: string; line: number; functionName: string | null }> = [
    ...report.frames.map((frame) => ({
      filePath: frame.filePath ?? '',
      line: frame.line ?? -1,
      functionName: frame.functionName,
    })),
  ]
  if (report.reportedAt) {
    // UBSan's single line has no symbol; the location is all there is.
    candidates.push({ ...report.reportedAt, functionName: null })
  }

  for (const candidate of candidates) {
    if (!candidate.filePath || candidate.line < 0) continue
    if (!sameFile(candidate.filePath, input.filePath)) continue

    const inRange =
      input.startLine !== null &&
      input.endLine !== null &&
      candidate.line >= input.startLine &&
      candidate.line <= input.endLine
    const inFunction =
      input.functionName !== null && candidate.functionName === input.functionName

    if (inRange || inFunction) {
      return { filePath: candidate.filePath, line: candidate.line }
    }
  }

  return null
}

/**
 * The verdict for one run.
 *
 * Order matters: a missing report is reported before the class is consulted, so
 * a class with no decidable entry that never fired says "nothing fired" rather
 * than "unknown class" — the first is what happened, the second is a fact about
 * the table.
 */
export const attributeReport = (input: AttributionInput): AttributionVerdict => {
  const key = cweKey(input.cwe)
  const decidable = key ? FUZZ_DECIDABLE[key] : undefined

  if (!decidable) {
    return {
      outcome: 'unattributed',
      signature: input.report?.signature ?? '',
      detail:
        `no signature table is recorded for ${key ?? 'this class'}, so a report from it cannot be ` +
        'checked against the defect it is supposed to be.',
    }
  }

  if (!input.report) {
    return {
      outcome: 'not-reproduced',
      detail: input.timedOut
        ? 'the fuzz run reached its time budget without a sanitizer report. A bounded run cannot ' +
          'disprove the finding, so its evidence tier is unchanged.'
        : 'the fuzz run finished without a sanitizer report. A bounded run cannot disprove the ' +
          'finding, so its evidence tier is unchanged.',
    }
  }

  const { signature } = input.report
  const accepted = decidable.signatures.some((candidate) =>
    signature.toLowerCase().includes(candidate.toLowerCase()),
  )
  if (!accepted) {
    return {
      outcome: 'unattributed',
      signature,
      detail:
        `${input.report.tool} reported \`${signature}\`, which is not one of the categories ` +
        `${key} is known to produce (${decidable.signatures.join(', ')}). The failure is real but ` +
        'it is not this defect, so it is not evidence for this finding.',
    }
  }

  const location = locationMatch(input.report, input)
  if (!location) {
    const frames = input.report.frames
      .map((frame) => `${frame.functionName ?? '?'} ${frame.filePath ?? '?'}:${frame.line ?? '?'}`)
      .slice(0, 3)
    return {
      outcome: 'unattributed',
      signature,
      detail:
        `${input.report.tool} reported \`${signature}\`, but nothing in the report is in ` +
        `${input.filePath ?? 'the finding\u2019s file'}` +
        (input.startLine !== null && input.endLine !== null
          ? ` at lines ${input.startLine}-${input.endLine}`
          : '') +
        (frames.length > 0 ? ` — the report is at ${frames.join(', ')}` : '') +
        '. A crash somewhere else is not this finding reproducing.',
    }
  }

  return {
    outcome: 'confirmed',
    signature,
    location,
    detail:
      `${input.report.tool} reported \`${signature}\` at ${location.filePath}:${location.line}, ` +
      `inside the finding's code.`,
  }
}
