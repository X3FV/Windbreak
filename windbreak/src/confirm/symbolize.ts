/**
 * Resolving the sanitizer's unsymbolized frames (spec §20.35).
 *
 * ## Why this exists at all
 *
 * ASan prints `#1 … in handler /src/unsafe.c:11` only when it can find a
 * symbolizer, and it looks for **`llvm-symbolizer`** specifically. That binary
 * ships with LLVM's tooling rather than with clang, so on a machine that has only
 * clang — the common case, and this one — ASan silently falls back to
 * `(/scratch/bin+0x52bf0d)`, naming no file and no line. The consequence is not
 * cosmetic: the location gate in `attribute.ts` has nothing to check, so a real
 * crash reads as `unattributed` and a genuine reproduction is thrown away.
 *
 * The offsets are still in the report, so the stage resolves them itself with
 * `addr2line` (binutils, present wherever a C toolchain is). Measured on clang 22:
 * the default `-g` emits a DWARF level the installed `addr2line` rejects with
 * *"mangled line number section"*, and `-gdwarf-4` is what it reads — which is
 * why `run.ts` pins that level alongside the sanitizer flags. Two knobs, both
 * load-bearing, neither a preference.
 *
 * ## Where it runs
 *
 * On the host, and that is a deliberate line: this **parses an artifact** rather
 * than executing target code, which is the same treatment recon gives target
 * sources when it builds the program model. It is not a third sandboxed command.
 */

import type { SanitizerFrame, SanitizerReport } from './attribute'

export interface ResolvedFrame {
  functionName: string | null
  filePath: string | null
  line: number | null
}

export interface SymbolizeOptions {
  binaryPath: string
  offsets: readonly number[]
  /** Injected for tests. */
  spawn?: SpawnForSymbolizer
}

export interface SymbolizerResult {
  exitCode: number
  stdout: string
}

export type SpawnForSymbolizer = (argv: string[]) => Promise<SymbolizerResult>

const defaultSpawn: SpawnForSymbolizer = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' })
  const exitCode = await proc.exited
  return { exitCode, stdout: await new Response(proc.stdout).text() }
}

/** `file.c:12`, or nothing when addr2line could not place the address. */
const parseLocation = (raw: string | undefined): { filePath: string | null; line: number | null } => {
  if (!raw) return { filePath: null, line: null }
  const match = /^(.*):(\d+)$/.exec(raw.trim())
  if (!match || match[1] === '??') return { filePath: null, line: null }
  return { filePath: match[1], line: Number.parseInt(match[2]!, 10) }
}

/**
 * Read `addr2line -f -C` output, which is exactly **two lines per address**:
 * the function, then `file:line`. Nothing is emitted for an address it cannot
 * place beyond `??` / `??:0`.
 *
 * Pure and exported so the parsing can be tested against real addr2line output
 * without a compiler.
 */
export const parseAddr2lineOutput = (
  stdout: string,
  offsets: readonly number[],
): Map<number, ResolvedFrame> => {
  const lines = stdout.split('\n')
  const resolved = new Map<number, ResolvedFrame>()

  offsets.forEach((offset, index) => {
    const symbol = lines[index * 2]
    const location = lines[index * 2 + 1]
    if (location === undefined) return

    const where = parseLocation(location)
    resolved.set(offset, {
      functionName: symbol && symbol.trim() !== '??' ? symbol.trim() : null,
      filePath: where.filePath,
      line: where.line,
    })
  })

  return resolved
}

/**
 * Resolve binary offsets to source locations, in one spawn for the whole batch.
 *
 * Returns an empty map on any failure — a missing `addr2line` or an unreadable
 * binary leaves the frames exactly as ASan printed them, which is the honest
 * outcome: attribution then reports that it could not place the crash rather
 * than inventing a location.
 */
export const symbolizeOffsets = async (
  options: SymbolizeOptions,
): Promise<Map<number, ResolvedFrame>> => {
  const offsets = [...new Set(options.offsets)]
  if (offsets.length === 0) return new Map()

  const spawn = options.spawn ?? defaultSpawn
  const argv = [
    'addr2line',
    '-e',
    options.binaryPath,
    '-f',
    // Demangle, so a C++ symbol reads as a name rather than a mangled string.
    '-C',
    ...offsets.map((offset) => `0x${offset.toString(16)}`),
  ]

  const result = await spawn(argv)
  if (result.exitCode !== 0) return new Map()

  return parseAddr2lineOutput(result.stdout, offsets)
}

/**
 * Fill in every frame the sanitizer left as an offset.
 *
 * Frames it *did* symbolize are left alone: ASan's own resolution is at least as
 * trustworthy, and re-resolving it would be work for nothing.
 */
export const enrichReport = async (
  report: SanitizerReport,
  options: { binaryPath: string; spawn?: SpawnForSymbolizer },
): Promise<SanitizerReport> => {
  const needing = report.frames.filter(
    (frame): frame is SanitizerFrame & { moduleOffset: number } =>
      frame.moduleOffset !== null && frame.filePath === null,
  )
  if (needing.length === 0) return report

  const resolved = await symbolizeOffsets({
    binaryPath: options.binaryPath,
    offsets: needing.map((frame) => frame.moduleOffset),
    ...(options.spawn ? { spawn: options.spawn } : {}),
  })
  if (resolved.size === 0) return report

  return {
    ...report,
    frames: report.frames.map((frame) => {
      if (frame.moduleOffset === null || frame.filePath !== null) return frame
      const hit = resolved.get(frame.moduleOffset)
      return hit ? { ...frame, ...hit } : frame
    }),
  }
}
