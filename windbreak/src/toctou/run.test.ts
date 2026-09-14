import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { readCandidateSummary } from '../engines/persist'
import { seedState } from '../pipeline/test-support'
import { runToctou } from './run'

import type { GitRunner } from '../patchmine/history'
import type { SeededState } from '../pipeline/test-support'
import type { ToctouOptions } from './run'

const PATH_RACE = `int load(const char *path) {
  if (access(path, R_OK) != 0) return -1;
  return open(path, O_RDONLY);
}
`

const UNLOCKED_FIELD = `int read_count(struct s *s) {
  return s->count;
}
`

/** The same handler fixture the sweep tests use, at the run level. */
const SIGNAL_HANDLER = `int g_stop = 0;
static char *info = NULL;

void on_term(int sig) {
  if (g_stop == 0) {
    g_stop = 1;
  }
  syslog(LOG_NOTICE, "shutting down");
  free(info);
  info = NULL;
}

int main(void) {
  signal(SIGINT, on_term);
  signal(SIGTERM, on_term);
  while (g_stop == 0) { }
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-toctou-run-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const record = (sha: string, subject: string, patch: string): string =>
  `\x1e${sha}\x1f1700000000\x1f${subject}\n${patch}\n`

/** A commit that added locking around a shared field. */
const LOCK_COMMIT = record(
  'a'.repeat(40),
  'fix: take the mutex around the counter',
  `diff --git a/src/other.c b/src/other.c
--- a/src/other.c
+++ b/src/other.c
@@ -1,4 +1,6 @@
 int inc(struct s *s) {
+  mutex_lock(&s->mu);
   s->count++;
+  mutex_unlock(&s->mu);
   return 0;
 }`,
)

/** A commit that changed nothing about locking. */
const DOC_COMMIT = record(
  'b'.repeat(40),
  'docs: tidy a comment',
  `diff --git a/src/note.c b/src/note.c
--- a/src/note.c
+++ b/src/note.c
@@ -1,2 +1,2 @@
-  // old
+  // new`,
)

const gitReturning = (stdout: string, exitCode = 0): GitRunner =>
  async () => ({ exitCode, stdout })

describe('runToctou', () => {
  test('mines an atomicity rule, sweeps it, and persists a candidate', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 3 }],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(LOCK_COMMIT),
    })

    expect(result.coverage.commitsRead).toBe(1)
    expect(result.coverage.hunksAddingLock).toBe(1)
    expect(result.coverage.functionsSwept).toBe(1)
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]).toMatchObject({
      resource: 's->count',
      lock: 's->mu',
      originPatchSha: 'a'.repeat(40),
    })

    expect(result.sites).toHaveLength(1)
    const site = result.sites[0]!
    expect(site.kind).toBe('atomicity')
    expect(site.functionName).toBe('read_count')
    expect(site.matchLine).toBe(2)

    expect(result.candidates).toHaveLength(1)
    const candidate = result.candidates[0]!
    expect(candidate.source).toBe('toctou-fsm')
    expect(candidate.patternId).toBe(`atomicity:${result.rules[0]!.id}`)
    expect(candidate.normalized.message).toContain('Atomicity violation')
    expect(candidate.normalized.message).toContain(result.rules[0]!.id)
    // The slice is read from the file by the normaliser, so it binds like any other
    // candidate's does.
    expect(candidate.normalized.sliceHash).toMatch(/^[0-9a-f]{32}$/)
    expect(candidate.normalized.snippet).toContain('return s->count;')

    expect(result.persisted).toBe(1)
    const summary = readCandidateSummary(seeded.db, seeded.runId)
    expect(summary.bySource).toContainEqual({ source: 'toctou-fsm', count: 1 })
  })

  test('the FSMs run even when the history yielded no rule', async () => {
    // The two producers are independent, and this is the one that does not need a
    // history at all.
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [{ filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 }],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(DOC_COMMIT),
    })

    expect(result.rules).toEqual([])
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.fsm).toBe('path-check-then-use')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.patternId).toBe('toctou:path-check-then-use')
    expect(result.candidates[0]!.normalized.message).toContain(
      'Check-to-use ordering (path-check-then-use)',
    )
  })

  test('a history that cannot be read degrades to a warning, not a throw', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 3 }],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning('', 128),
    })

    expect(result.rules).toEqual([])
    expect(result.coverage.commitsRead).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('The history walk failed')
  })

  test('a throwing runner is caught and reported', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({ symbols: [] })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: async () => {
        throw new Error('sandbox unavailable')
      },
    })

    expect(result.rules).toEqual([])
    expect(result.warnings[0]).toContain('sandbox unavailable')
  })

  test('without a database the rules are still mined, and the gap is named', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })

    const result = await runToctou({
      targetRoot,
      targetId: 'target-1',
      runGit: gitReturning(LOCK_COMMIT),
    })

    expect(result.rules).toHaveLength(1)
    expect(result.sites).toEqual([])
    expect(result.candidates).toEqual([])
    expect(result.persisted).toBe(0)
    expect(result.warnings.some((line) => line.includes('no program model'))).toBe(true)
  })

  test('an FSM subset is honoured', async () => {
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [{ filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 }],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(DOC_COMMIT),
      fsms: ['double-fetch'],
    })

    expect(result.sites).toEqual([])
    expect(result.candidates).toEqual([])
  })

  test('the sweep is skipped when the static core is out of budget', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 3 }],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(LOCK_COMMIT),
      governor: {
        session: () => ({
          stage: 'static-core',
          elapsedSeconds: () => 1_000,
          remainingMs: () => 0,
          exhausted: () => true,
          allowMs: () => 0,
        }),
        resolveOverrun: async () => 'degrade',
      } as unknown as ToctouOptions['governor'],
    })

    expect(result.stoppedBy).toBe('budget-degrade')
    // Mining is pure and already done, so the rules survive the skipped sweep.
    expect(result.rules).toHaveLength(1)
    expect(result.sites).toEqual([])
    expect(result.candidates).toEqual([])
    expect(result.warnings.some((line) => line.includes('Check-to-use sweep skipped'))).toBe(true)
  })

  test('a budget abort is reported as an abort rather than a degrade', async () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({ symbols: [] })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      runGit: gitReturning(LOCK_COMMIT),
      governor: {
        session: () => ({
          stage: 'static-core',
          elapsedSeconds: () => 1_000,
          remainingMs: () => 100,
          exhausted: () => false,
          allowMs: () => 100,
        }),
        resolveOverrun: async () => 'abort',
      } as unknown as ToctouOptions['governor'],
    })

    expect(result.stoppedBy).toBe('budget-abort')
  })

  test('a signal handler reaches the candidate set under its own source and CWE', async () => {
    const targetRoot = checkout({ 'src/sig.c': SIGNAL_HANDLER })
    seeded = seedState({
      symbols: [
        { filePath: 'src/sig.c', name: 'on_term', startLine: 4, endLine: 11 },
        { filePath: 'src/sig.c', name: 'main', startLine: 13, endLine: 18 },
      ],
    })

    const result = await runToctou({
      targetRoot,
      targetId: seeded.targetId,
      runId: seeded.runId,
      db: seeded.db,
      // No history at all: a signal finding needs no mined rule, which is the point of
      // it being a fixed shape rather than a project-specific pairing.
      runGit: gitReturning(''),
    })

    expect(result.rules).toEqual([])
    expect(result.coverage.signalHandlers).toBe(1)

    const byShape = new Map(result.candidates.map((candidate) => [candidate.patternId, candidate.cwe]))

    // The unsafe call is CWE-828, whose name is what `handlers.ts`'s table was built
    // to; the other three are CWE-364 itself. Filing all four under 364 would be the
    // small overclaim this module exists to avoid.
    expect(byShape.get('signal:unsafe-call')).toBe('CWE-828')
    expect(byShape.get('signal:reentrancy-window')).toBe('CWE-364')
    expect(byShape.get('signal:shared-state')).toBe('CWE-364')

    // A signal candidate is not an engine hit and not an FSM hit: the source reaches
    // the prompt, so naming the wrong producer is a claim about a machine that did not
    // run.
    for (const candidate of result.candidates) {
      expect(candidate.source).toBe('toctou-signal')
      expect(candidate.normalized.message).toContain('Signal handler race')
    }

    expect(readCandidateSummary(seeded.db, seeded.runId).bySource).toContainEqual({
      source: 'toctou-signal',
      count: result.candidates.length,
    })
  })
})
