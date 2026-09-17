/**
 * End-to-end automated confirmation (spec §20.35).
 *
 * Excluded from the default suite by the `*.integration.test.ts` convention: it
 * really compiles and really fuzzes inside the real sandbox, which is the only
 * way to show the stage works. Against a fixture rather than a mock, because the
 * two things most likely to be wrong — whether the generated target compiles at
 * all, and whether a crash is attributed to the right finding — are exactly the
 * two things a mock would agree with.
 *
 * The fixture carries a **control**: a genuinely safe function in the same
 * checkout, next to the overflow. A test that only showed the vulnerable one
 * confirming would not distinguish "attribution works" from "everything
 * confirms", which is the failure that would matter.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { confirmFinding, resolveConfirmBackend } from './run'

const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-confirm-'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-confirm-scratch-'))

fs.mkdirSync(path.join(checkout, 'src'), { recursive: true })

/** An unbounded copy: the canonical CWE-120, reachable with one string argument. */
const VULNERABLE = `#include <string.h>

void handler(const char *line) {
  char buf[8];
  strcpy(buf, line);
}
`

/** The control. A fuzzer should find nothing here, ever. */
const SAFE = `#include <string.h>

void safe_handler(const char *line) {
  char buf[64];
  size_t n = strlen(line);
  if (n > sizeof(buf) - 1) n = sizeof(buf) - 1;
  memcpy(buf, line, n);
  buf[n] = '\\0';
}
`

/** Cannot compile: no such header. Must read as a build problem, not a verdict. */
const UNBUILDABLE = `#include "windbreak_no_such_header.h"

void broken(void) {}
`

fs.writeFileSync(path.join(checkout, 'src', 'unsafe.c'), VULNERABLE)
fs.writeFileSync(path.join(checkout, 'src', 'safe.c'), SAFE)
fs.writeFileSync(path.join(checkout, 'src', 'unbuildable.c'), UNBUILDABLE)

const before = fs.readFileSync(path.join(checkout, 'src', 'unsafe.c'), 'utf8')

const backend = resolveConfirmBackend({})
/**
 * Skip rather than fail where the host has no usable sandbox — §6 forbids running
 * target code without one, so the absence of a backend is not a test failure.
 */
const unavailable = !backend.ok
const reason = backend.ok ? '' : (backend.reason ?? 'no sandbox backend')

/**
 * A fuzz run is bounded by the clock, so Bun's 5s default is too short for the
 * compile plus the budget.
 */
const TEST_TIMEOUT_MS = 180_000

afterAll(() => {
  fs.rmSync(checkout, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

const confirm = (finding: Parameters<typeof confirmFinding>[0]['finding']) =>
  confirmFinding({
    finding,
    checkoutDir: checkout,
    scratchDir: scratch,
    fuzzSeconds: 15,
  })

describe('confirmFinding (end to end, sandboxed)', () => {
  test.skipIf(unavailable)(
    `confirms a real overflow in the finding's own code (sandbox: ${reason || 'ok'})`,
    async () => {
      const result = await confirm({
        candidateId: 'cand-vulnerable',
        filePath: 'src/unsafe.c',
        startLine: 3,
        endLine: 5,
        functionName: 'handler',
        language: 'c',
        cwe: 'CWE-120',
      })

      expect(result.outcome).toBe('confirmed')
      expect(result.signature).toContain('stack-buffer-overflow')
      // The path is the sandbox's copy of the checkout; the line is in the function.
      expect(result.location).not.toBeNull()
      expect(result.location!.filePath).toContain('unsafe.c')
      // The crash input is saved somewhere a researcher can replay it.
      expect(result.workspaceDir).not.toBeNull()
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(unavailable)(
    'does not confirm the safe control',
    async () => {
      const result = await confirm({
        candidateId: 'cand-safe',
        filePath: 'src/safe.c',
        startLine: 3,
        endLine: 9,
        functionName: 'safe_handler',
        language: 'c',
        cwe: 'CWE-120',
      })

      expect(result.outcome).toBe('not-reproduced')
      expect(result.signature).toBeNull()
      // Silence must never be phrased as disproof.
      expect(result.detail).toContain('cannot disprove')
    },
    TEST_TIMEOUT_MS,
  )

  test.skipIf(unavailable)(
    'keeps a compile failure out of the verdict vocabulary',
    async () => {
      const result = await confirm({
        candidateId: 'cand-broken',
        filePath: 'src/unbuildable.c',
        startLine: 3,
        endLine: 3,
        functionName: 'broken',
        language: 'c',
        cwe: 'CWE-120',
      })

      expect(result.outcome).toBe('build-failed')
      expect(result.detail).toContain('says nothing about the finding')
      expect(result.detail).toContain('windbreak_no_such_header.h')
    },
    TEST_TIMEOUT_MS,
  )

  test('refuses a class one run cannot settle, without compiling anything', async () => {
    const result = await confirm({
      candidateId: 'cand-race',
      filePath: 'src/unsafe.c',
      startLine: 3,
      endLine: 5,
      functionName: 'handler',
      language: 'c',
      cwe: 'CWE-362',
    })

    expect(result.outcome).toBe('ineligible')
    expect(result.compileCommand).toEqual([])
    expect(result.workspaceDir).toBeNull()
  })

  test('leaves the target checkout untouched', () => {
    // §6.2: the checkout is bound read-only, so a run cannot rewrite the tree a
    // finding cites. Asserted on content rather than on a flag.
    expect(fs.readFileSync(path.join(checkout, 'src', 'unsafe.c'), 'utf8')).toBe(before)
  })
})
