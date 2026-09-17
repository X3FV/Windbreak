import { describe, expect, test } from 'bun:test'

import { attributeReport, parseSanitizerReport, sameFile } from './attribute'

/** ASan's real shape for a stack overflow, including the frame lines it prints. */
const ASAN_OVERFLOW = `
=================================================================
==1234==ERROR: AddressSanitizer: stack-buffer-overflow on address 0x7ffd0000 at pc 0x0001 bp 0x7ffd sp 0x7ffd
WRITE of size 6 at 0x7ffd0000 thread T0
    #0 0x55f0 in handler /scratch/target/src/unsafe.c:11:4
    #1 0x5a10 in main /scratch/target/src/main.c:30:3
SUMMARY: AddressSanitizer: stack-buffer-overflow /scratch/target/src/unsafe.c:11:4 in handler
`

const UBSAN_OVERFLOW = `
src/math.c:42:7: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type 'int'
`

const ASAN_ELSEWHERE = `
==9==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x60 at pc 0x2 bp 0x3 sp 0x4
    #0 0x11 in parse_other /scratch/target/src/other.c:8:2
`

const finding = {
  filePath: 'src/unsafe.c',
  startLine: 11,
  endLine: 12,
  functionName: 'handler',
}

describe('parseSanitizerReport', () => {
  test('reads the category, the tool, and the frames', () => {
    const report = parseSanitizerReport(ASAN_OVERFLOW)

    expect(report).not.toBeNull()
    expect(report!.signature).toBe('stack-buffer-overflow')
    expect(report!.tool).toBe('AddressSanitizer')
    expect(report!.frames[0]).toMatchObject({
      index: 0,
      functionName: 'handler',
      filePath: '/scratch/target/src/unsafe.c',
      line: 11,
    })
  })

  test('reads UBSan, which prints a line rather than a stack', () => {
    const report = parseSanitizerReport(UBSAN_OVERFLOW)

    expect(report).not.toBeNull()
    // The operands after the colon are not the category.
    expect(report!.signature).toBe('signed integer overflow')
    expect(report!.tool).toBe('UndefinedBehaviorSanitizer')
    expect(report!.reportedAt).toEqual({ filePath: 'src/math.c', line: 42 })
  })

  test('returns null when nothing fired', () => {
    expect(parseSanitizerReport('INFO: running 20 inputs\nDone 20 runs\n')).toBeNull()
  })

  test('reads a summary when no ERROR line survived', () => {
    const report = parseSanitizerReport('SUMMARY: AddressSanitizer: heap-use-after-free f.c:3')
    expect(report?.signature).toBe('heap-use-after-free')
  })
})

describe('sameFile', () => {
  test('matches the sandbox path against the repository-relative one', () => {
    expect(sameFile('/scratch/target/src/unsafe.c', 'src/unsafe.c')).toBe(true)
    expect(sameFile('./src/unsafe.c', 'src/unsafe.c')).toBe(true)
  })

  test('matches on whole path segments, not on a bare suffix', () => {
    expect(sameFile('/scratch/target/src/handler.c', 'src/unsafe.c')).toBe(false)
    expect(sameFile('/scratch/target/src/handlers.c', 'src/handler.c')).toBe(false)
    // The residual imprecision, asserted rather than implied: a report from a
    // *different* directory that ends on the same segments does match, because the
    // finding carries a repository-relative path and the report an absolute one.
    // The class and line/function gates are what bound the consequence.
    expect(sameFile('/scratch/target/other/src/unsafe.c', 'src/unsafe.c')).toBe(true)
  })
})

describe('attributeReport', () => {
  test('confirms when the class and the location both check out', () => {
    const verdict = attributeReport({
      report: parseSanitizerReport(ASAN_OVERFLOW),
      timedOut: false,
      cwe: 'CWE-120',
      ...finding,
    })

    expect(verdict.outcome).toBe('confirmed')
    if (verdict.outcome !== 'confirmed') return
    expect(verdict.signature).toBe('stack-buffer-overflow')
    expect(verdict.location).toEqual({ filePath: '/scratch/target/src/unsafe.c', line: 11 })
  })

  test('refuses a real crash of the wrong class', () => {
    // A heap-use-after-free must not confirm a buffer overrun, however real it is.
    const report = parseSanitizerReport(ASAN_OVERFLOW.replace(/stack-buffer-overflow/g, 'heap-use-after-free'))
    const verdict = attributeReport({ report, timedOut: false, cwe: 'CWE-120', ...finding })

    expect(verdict.outcome).toBe('unattributed')
    if (verdict.outcome !== 'unattributed') return
    expect(verdict.detail).toContain('not one of the categories')
  })

  test('refuses a right-class crash in someone else\u2019s code', () => {
    const verdict = attributeReport({
      report: parseSanitizerReport(ASAN_ELSEWHERE),
      timedOut: false,
      cwe: 'CWE-120',
      ...finding,
    })

    expect(verdict.outcome).toBe('unattributed')
    if (verdict.outcome !== 'unattributed') return
    expect(verdict.detail).toContain('not this finding reproducing')
  })

  test('accepts a line outside the matched range when it is the named function', () => {
    // The finding covers 11-12; the crash is at 19, still inside `handler`.
    const report = parseSanitizerReport(ASAN_OVERFLOW.replace('unsafe.c:11:4', 'unsafe.c:19:9'))
    const verdict = attributeReport({ report, timedOut: false, cwe: 'CWE-120', ...finding })

    expect(verdict.outcome).toBe('confirmed')
  })

  test('never treats silence as disproof', () => {
    const verdict = attributeReport({
      report: null,
      timedOut: false,
      cwe: 'CWE-120',
      ...finding,
    })

    expect(verdict.outcome).toBe('not-reproduced')
    if (verdict.outcome !== 'not-reproduced') return
    expect(verdict.detail).toContain('cannot disprove')
    expect(verdict.detail).toContain('unchanged')
  })

  test('says a spent budget is silence too', () => {
    const verdict = attributeReport({ report: null, timedOut: true, cwe: 'CWE-120', ...finding })

    expect(verdict.outcome).toBe('not-reproduced')
    if (verdict.outcome !== 'not-reproduced') return
    expect(verdict.detail).toContain('time budget')
  })

  test('confirms an integer overflow through UBSan\u2019s line, which has no stack', () => {
    const verdict = attributeReport({
      report: parseSanitizerReport(UBSAN_OVERFLOW),
      timedOut: false,
      cwe: 'CWE-190',
      filePath: 'src/math.c',
      startLine: 40,
      endLine: 45,
      functionName: 'scale',
    })

    expect(verdict.outcome).toBe('confirmed')
  })

  test('refuses to judge a class with no signature table', () => {
    const verdict = attributeReport({
      report: parseSanitizerReport(ASAN_OVERFLOW),
      timedOut: false,
      cwe: 'CWE-9999',
      ...finding,
    })

    expect(verdict.outcome).toBe('unattributed')
    if (verdict.outcome !== 'unattributed') return
    expect(verdict.detail).toContain('no signature table')
  })
})
