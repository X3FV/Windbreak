import { describe, expect, test } from 'bun:test'

import { parseSanitizerReport } from './attribute'
import { enrichReport, parseAddr2lineOutput, symbolizeOffsets } from './symbolize'

/**
 * Real `addr2line -e f0 -f -C 0x52bf0d 0x58ac3b` output from the fixture build:
 * two lines per address, the sanitizer's own interceptor first, then the defect.
 */
const REAL_ADDR2LINE = `___interceptor_strcpy
??:?
handler
/tmp/wb-diag/unsafe.c:5
`

/** The unsymbolized form ASan emits when it cannot find a symbolizer. */
const UNSYMBOLIZED_REPORT = `
==2==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7b at pc 0x1 bp 0x2 sp 0x3
WRITE of size 9 at 0x7b thread T0
    #0 0x00000052bf0d  (/scratch/confirm/cand-1/windbreak_fuzz_binary+0x52bf0d) (BuildId: aa)
    #1 0x00000058ac3b  (/scratch/confirm/cand-1/windbreak_fuzz_binary+0x58ac3b) (BuildId: aa)
SUMMARY: AddressSanitizer: stack-buffer-overflow (/scratch/confirm/cand-1/windbreak_fuzz_binary+0x52bf0d)
`

describe('parseSanitizerReport with offsets', () => {
  test('keeps the binary offset when the frame carries no file', () => {
    const report = parseSanitizerReport(UNSYMBOLIZED_REPORT)

    expect(report).not.toBeNull()
    expect(report!.signature).toBe('stack-buffer-overflow')
    expect(report!.frames).toHaveLength(2)
    expect(report!.frames[0]).toMatchObject({
      index: 0,
      functionName: null,
      filePath: null,
      line: null,
      moduleOffset: 0x52bf0d,
    })
  })
})

describe('parseAddr2lineOutput', () => {
  test('pairs each address with its symbol and location', () => {
    const resolved = parseAddr2lineOutput(REAL_ADDR2LINE, [0x52bf0d, 0x58ac3b])

    expect(resolved.get(0x52bf0d)).toEqual({
      functionName: '___interceptor_strcpy',
      filePath: null,
      line: null,
    })
    expect(resolved.get(0x58ac3b)).toEqual({
      functionName: 'handler',
      filePath: '/tmp/wb-diag/unsafe.c',
      line: 5,
    })
  })

  test('treats an unplaceable address as no answer rather than a location', () => {
    const resolved = parseAddr2lineOutput('??\n??:0\n', [0x10])

    expect(resolved.get(0x10)).toEqual({ functionName: null, filePath: null, line: null })
  })
})

describe('symbolizeOffsets', () => {
  test('does not spawn when there is nothing to resolve', async () => {
    let spawned = 0
    const resolved = await symbolizeOffsets({
      binaryPath: '/nonexistent',
      offsets: [],
      spawn: async () => {
        spawned += 1
        return { exitCode: 0, stdout: '' }
      },
    })

    expect(resolved.size).toBe(0)
    expect(spawned).toBe(0)
  })

  test('asks for the whole batch in one spawn, in hex', async () => {
    let argv: string[] = []
    await symbolizeOffsets({
      binaryPath: '/scratch/bin',
      offsets: [0x52bf0d, 0x58ac3b],
      spawn: async (received) => {
        argv = received
        return { exitCode: 0, stdout: REAL_ADDR2LINE }
      },
    })

    expect(argv[0]).toBe('addr2line')
    expect(argv).toContain('/scratch/bin')
    expect(argv.filter((word) => word.startsWith('0x'))).toEqual(['0x52bf0d', '0x58ac3b'])
  })

  test('returns nothing when the symbolizer fails, rather than guessing', async () => {
    const resolved = await symbolizeOffsets({
      binaryPath: '/scratch/bin',
      offsets: [0x10],
      spawn: async () => ({ exitCode: 1, stdout: '' }),
    })

    expect(resolved.size).toBe(0)
  })
})

describe('enrichReport', () => {
  test('fills in the frames the sanitizer left as offsets', async () => {
    const report = parseSanitizerReport(UNSYMBOLIZED_REPORT)!
    const enriched = await enrichReport(report, {
      binaryPath: '/scratch/bin',
      spawn: async () => ({ exitCode: 0, stdout: REAL_ADDR2LINE }),
    })

    // Frame #1 resolves to the fixture's own function and line.
    expect(enriched.frames[1]).toMatchObject({
      functionName: 'handler',
      filePath: '/tmp/wb-diag/unsafe.c',
      line: 5,
    })
  })

  test('leaves a report ASan already symbolized alone', async () => {
    const symbolized = parseSanitizerReport(`
==1==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x1 at pc 0x2 bp 0x3 sp 0x4
    #0 0x5 in handler /src/unsafe.c:11:4
`)
    let spawned = 0
    const enriched = await enrichReport(symbolized!, {
      binaryPath: '/scratch/bin',
      spawn: async () => {
        spawned += 1
        return { exitCode: 0, stdout: '' }
      },
    })

    // Identity, not equality: an already-symbolized report is handed back as-is.
    expect(enriched).toBe(symbolized!)
    expect(spawned).toBe(0)
  })
})
