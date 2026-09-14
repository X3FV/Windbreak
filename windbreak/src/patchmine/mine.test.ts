import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { readCandidateSummary } from '../engines/persist'
import { seedState } from '../pipeline/test-support'
import { patternId, runPatchMining } from './mine'

import type { SeededState } from '../pipeline/test-support'
import type { GitRunner } from './history'

const UNGUARDED = `int paste(char *dst, const char *src) {
  strcpy(dst, src);
  return 0;
}
`

let seeded: SeededState | null = null
let root: string | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

const checkout = (files: Record<string, string>): string => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-patchmine-mine-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const record = (sha: string, subject: string, patch: string): string =>
  `\x1e${sha}\x1f1700000000\x1f${subject}\n${patch}\n`

/** A commit that added a null check around `strcpy`. */
const NULL_CHECK_COMMIT = (sha: string, subject: string, subjectName = 'dst'): string =>
  record(
    sha,
    subject,
    `diff --git a/src/unsafe.c b/src/unsafe.c
--- a/src/unsafe.c
+++ b/src/unsafe.c
@@ -1,4 +1,5 @@
 int paste(char *dst, const char *src) {
-  strcpy(dst, src);
+  if (${subjectName} == NULL) return -1;
+  strcpy(dst, src);
   return 0;
 }`,
  )

/** A commit that adds a release where there was none: a leak fix, not a shape. */
const LEAK_COMMIT = record(
  'b'.repeat(40),
  'fix: free the buffer',
  `diff --git a/src/leak.c b/src/leak.c
--- a/src/leak.c
+++ b/src/leak.c
@@ -1,3 +1,4 @@
 int load(void) {
   char *buf = malloc(16);
+  free(buf);
 }`,
)

const ONLY_UNRECOGNISED = record(
  'c'.repeat(40),
  'docs: tweak comment',
  `diff --git a/src/note.c b/src/note.c
--- a/src/note.c
+++ b/src/note.c
@@ -1,2 +1,2 @@
-  // old
+  // new
`,
)

const gitReturning = (stdout: string, exitCode = 0): GitRunner =>
  async () => ({ exitCode, stdout })

const seededTarget = (targetRoot: string): SeededState =>
  seedState({
    symbols: [{ filePath: 'src/unsafe.c', name: 'paste', startLine: 1, endLine: 4 }],
  })

describe('runPatchMining', () => {
  test('mines a validated pattern, sweeps it, and emits a persisted candidate', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard strcpy')),
    })

    expect(result.patterns).toHaveLength(1)
    const pattern = result.patterns[0]!
    expect(pattern.shape).toBe('null-check')
    expect(pattern.operation).toBe('strcpy')
    expect(pattern.originPatchSha).toBe('a'.repeat(40))
    expect(pattern.occurrences).toBe(1)
    expect(pattern.validation).toEqual({
      preImageFlagged: true,
      postImageFlagged: false,
      accepted: true,
    })

    expect(result.sites).toHaveLength(1)
    expect(result.candidates).toHaveLength(1)

    const candidate = result.candidates[0]!
    expect(candidate.source).toBe('patch-mined')
    expect(candidate.patternId).toBe(pattern.id)
    // §4.4.1: the candidate carries the originating patch SHA.
    expect(candidate.originPatchSha).toBe('a'.repeat(40))
    expect(candidate.normalized.message).toContain(pattern.id)
    expect(candidate.startLine).toBe(2)

    expect(result.persisted).toBe(1)
    // `seedState` also seeds an engine candidate, so this asserts the patch-mined
    // row was added rather than that it is the only one.
    const summary = readCandidateSummary(seeded.db, seeded.runId)
    expect(summary.bySource).toContainEqual({ source: 'patch-mined', count: 1 })
  })

  test('a guard on a variable the hunk never uses is rejected', async () => {
    // §4.4.1's validation doing its job on a plausible-looking non-pattern: the
    // commit added a null check, and it is a null check on something that does not
    // appear in the code it guards — so the shape does not describe this patch and
    // the pattern is dropped rather than tuned.
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      // `buf` is not used anywhere in the hunk's pre-image.
      runGit: gitReturning(NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard buf', 'buf')),
    })

    expect(result.patterns).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.validation.preImageFlagged).toBe(false)
  })

  test('reports the same shape from two commits as one pattern with two occurrences', async () => {
    // The keying decision, asserted: a pattern is what its sweep is parameterised
    // by — shape and operation — not the commit or the local variable name. Keying
    // on either would produce two patterns that emit the same candidate twice.
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      // Same shape, same operation, different guarded variable — both of which the
      // hunk's pre-image really uses, so both validate.
      runGit: gitReturning(
        NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard dst', 'dst') +
          NULL_CHECK_COMMIT('b'.repeat(40), 'fix: guard src', 'src'),
      ),
    })

    expect(result.patterns).toHaveLength(1)
    expect(result.patterns[0]!.occurrences).toBe(2)
    // The newest commit wins, since `git log` is newest-first.
    expect(result.patterns[0]!.originPatchSha).toBe('a'.repeat(40))
    expect(result.candidates).toHaveLength(1)
  })

  test('drops a shape that does not explain its own patch, and counts it', async () => {
    const targetRoot = checkout({ 'src/leak.c': 'int load(void) {\n  char *buf = malloc(16);\n  free(buf);\n}\n' })
    seeded = seedState({ symbols: [] })

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(LEAK_COMMIT),
    })

    expect(result.patterns).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]!.shape).toBe('lifetime')
    expect(result.rejected[0]!.validation.accepted).toBe(false)
    // Classified, so it is *not* an unrecognised hunk — the two counts mean
    // different things and collapsing them would hide which failure happened.
    expect(result.coverage.hunksUnrecognised).toBe(0)
  })

  test('an unrecognised hunk is counted as unrecognised, not as rejected', async () => {
    const targetRoot = checkout({ 'src/note.c': '// new\n' })
    seeded = seedState({ symbols: [] })

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(ONLY_UNRECOGNISED),
    })

    expect(result.patterns).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.coverage).toEqual({
      commitsRead: 1,
      commitsWithPatches: 1,
      hunksExamined: 1,
      hunksUnrecognised: 1,
    })
  })

  test('the subject heuristic is available and off by default', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)
    const log = NULL_CHECK_COMMIT('a'.repeat(40), 'refactor: rename a variable')

    const byDefault = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(log),
    })
    expect(byDefault.patterns).toHaveLength(1)
    expect(byDefault.commitsConsidered).toBe(1)

    const filtered = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(log),
      fixSubjectsOnly: true,
    })
    expect(filtered.patterns).toEqual([])
    expect(filtered.commitsConsidered).toBe(0)
    // The commit was still read and diffed; only classification was skipped.
    expect(filtered.coverage.commitsWithPatches).toBe(1)
  })

  test('a history that cannot be read degrades to a warning, not a throw', async () => {
    // Patch mining is one discovery path among several. Failing the whole static
    // core because git could not run would trade a thin net for no net.
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning('', 128),
    })

    expect(result.patterns).toEqual([])
    expect(result.warnings[0]).toContain('patch-mined discovery produced nothing')
    expect(result.coverage.commitsRead).toBe(0)
  })

  test('a throwing runner is caught and reported', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: async () => {
        throw new Error('sandbox unavailable')
      },
    })

    expect(result.patterns).toEqual([])
    expect(result.warnings[0]).toContain('sandbox unavailable')
  })

  test('without a database the patterns are still mined, and the gap is named', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })

    const result = await runPatchMining({
      targetRoot,
      targetId: 'target-1',
      runGit: gitReturning(NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard strcpy')),
    })

    expect(result.patterns).toHaveLength(1)
    expect(result.candidates).toEqual([])
    expect(result.persisted).toBe(0)
    expect(result.warnings.some((line) => line.includes('no program model to sweep'))).toBe(true)
  })

  test('the pattern id keys on shape and operation only', () => {
    expect(patternId('null-check', 'strcpy')).toBe(patternId('null-check', 'strcpy'))
    expect(patternId('null-check', 'strcpy')).not.toBe(patternId('null-check', 'memcpy'))
    // A different shape over the same call is a different pattern, because the
    // sweep and the detector are both different.
    expect(patternId('null-check', 'strcpy')).not.toBe(patternId('lock', 'strcpy'))
    // A missing operation is its own key rather than colliding with a named one.
    expect(patternId('bounds-check', null)).not.toBe(patternId('bounds-check', 'strcpy'))
  })

  test('the candidate is slice-hashed like any other, so it binds to its source', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard strcpy')),
    })

    const candidate = result.candidates[0]!
    expect(candidate.normalized.sliceHash).toMatch(/^[0-9a-f]{32}$/)
    expect(candidate.normalized.snippet).toContain('strcpy(dst, src)')
    expect(candidate.normalized.engine).toBe('patch-mined')
  })

  test('the sweep is skipped when the static core is out of budget', async () => {
    const targetRoot = checkout({ 'src/unsafe.c': UNGUARDED })
    seeded = seededTarget(targetRoot)

    const result = await runPatchMining({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(NULL_CHECK_COMMIT('a'.repeat(40), 'fix: guard strcpy')),
      governor: {
        session: () => ({
          stage: 'static-core',
          elapsedSeconds: () => 1_000,
          remainingMs: () => 0,
          exhausted: () => true,
          allowMs: () => 0,
        }),
        resolveOverrun: async () => 'degrade',
      } as unknown as Parameters<typeof runPatchMining>[0]['governor'],
    })

    expect(result.stoppedBy).toBe('budget-degrade')
    expect(result.patterns).toHaveLength(1)
    expect(result.sites).toEqual([])
    expect(result.warnings.some((line) => line.includes('Sibling sweep skipped'))).toBe(true)
  })
})
