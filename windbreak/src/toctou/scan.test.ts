import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { seedState } from '../pipeline/test-support'
import { buildCallGraph } from './callgraph'
import { atomicityRuleId } from './rules'
import { sweepFunctions } from './scan'

import type { SeededState } from '../pipeline/test-support'
import type { AtomicityRule } from './types'

const PATH_RACE = `int load(const char *path) {
  if (access(path, R_OK) != 0) return -1;
  return open(path, O_RDONLY);
}
`

const UNLOCKED_FIELD = `int read_count(struct s *s) {
  return s->count;
}
`

const LOCKED_FIELD = `int read_count(struct s *s) {
  int value;
  mutex_lock(&s->mu);
  value = s->count;
  mutex_unlock(&s->mu);
  return value;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-toctou-scan-'))
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

const rule = (over: Partial<AtomicityRule> = {}): AtomicityRule => ({
  id: atomicityRuleId('s->count', 's->mu'),
  resource: 's->count',
  lock: 's->mu',
  originPatchSha: 'a'.repeat(40),
  originFile: 'src/a.c',
  occurrences: 1,
  ...over,
})

describe('sweepFunctions', () => {
  test('an FSM site is reported on the file\u2019s own line numbers', () => {
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [{ filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
    })

    expect(result.sites).toHaveLength(1)
    const site = result.sites[0]!
    expect(site.kind).toBe('fsm')
    expect(site.fsm).toBe('path-check-then-use')
    expect(site.functionName).toBe('load')
    // One-based, in the *file*: the detectors work region-relative and the sweep
    // translates, so this is the line a reviewer will open.
    expect(site.checkLine).toBe(2)
    expect(site.matchLine).toBe(3)
    expect(site.ruleId).toBeNull()
    expect(result.coverage.functionsSwept).toBe(1)
    expect(result.coverage.functionsWithEvents).toBe(1)
  })

  test('the evidence names file lines, not region lines', () => {
    // The bug this asserts against was real: the detectors work region-relative, so
    // a site pointing at line 6 while its sentence said "line 2" was sending a
    // reviewer to the wrong lines. The fixture's function deliberately does not start
    // at line 1, or the two coordinate systems would coincide and hide it.
    const source = [
      '// header',
      '// two',
      '// three',
      '// four',
      'int load(const char *path) {',
      '  if (access(path, R_OK) != 0) return -1;',
      '  return open(path, O_RDONLY);',
      '}',
    ].join('\n') + '\n'

    const targetRoot = checkout({ 'src/off.c': source })
    seeded = seedState({
      symbols: [{ filePath: 'src/off.c', name: 'load', startLine: 5, endLine: 8 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
    })

    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.matchLine).toBe(7)
    expect(result.sites[0]!.evidence).toContain('checked at line 6')
    expect(result.sites[0]!.evidence).toContain('re-resolved at line 7')
  })

  test('a rule violation\u2019s evidence names a file line too', () => {
    const source = [
      '// header',
      '// two',
      '// three',
      '// four',
      'int read_count(struct s *s) {',
      '  return s->count;',
      '}',
    ].join('\n') + '\n'

    const targetRoot = checkout({ 'src/off.c': source })
    seeded = seedState({
      symbols: [{ filePath: 'src/off.c', name: 'read_count', startLine: 5, endLine: 7 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.evidence).toContain('`s->count` is accessed at line 6')
    expect(result.sites[0]!.evidence).toContain('never held in this function')
  })

  test('a rule violation is reported when the lock is never held', () => {
    const targetRoot = checkout({ 'src/field.c': UNLOCKED_FIELD })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 3 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites).toHaveLength(1)
    const site = result.sites[0]!
    expect(site.kind).toBe('atomicity')
    expect(site.ruleId).toBe(rule().id)
    expect(site.fsm).toBeNull()
    // An atomicity violation is one line, not a path — there is no check end.
    expect(site.checkLine).toBeNull()
    expect(site.matchLine).toBe(2)
    expect(site.evidence).toContain('never held')
    expect(site.evidence).toContain(rule().id)
  })

  test('the same code with the lock held reports nothing', () => {
    // The whole point of a mined pairing: it separates the two.
    const targetRoot = checkout({ 'src/field.c': LOCKED_FIELD })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 7 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites).toEqual([])
    // The four FSMs, this one rule, the four signal shapes and the interprocedural
    // producer — each accounted for separately, including the ones that found nothing.
    expect(result.outcomes).toHaveLength(10)
    const ruleOutcome = result.outcomes.find(
      (outcome) => outcome.producer === `rule:${rule().id}`,
    )!
    expect(ruleOutcome.sites).toBe(0)
    expect(ruleOutcome.capped).toBe(false)
  })

  test('a lock taken through a local satisfies the rule', () => {
    const source = `int read_count(struct s *s) {
  struct mutex *m = &s->mu;
  int value;
  mutex_lock(m);
  value = s->count;
  mutex_unlock(m);
  return value;
}
`
    const targetRoot = checkout({ 'src/field.c': source })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 8 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites).toEqual([])
  })

  test('an access inside the lock but before the acquire is still a violation', () => {
    // Intervals, not a boolean: a boolean would call a use *before* the lock
    // protected, which is the same defect written in the other order.
    const source = `int read_count(struct s *s) {
  int value = s->count;
  mutex_lock(&s->mu);
  value += s->refs;
  mutex_unlock(&s->mu);
  return value;
}
`
    const targetRoot = checkout({ 'src/field.c': source })
    seeded = seedState({
      symbols: [{ filePath: 'src/field.c', name: 'read_count', startLine: 1, endLine: 7 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites.map((site) => site.matchLine)).toEqual([2])
  })

  test('caps each producer and says the sweep is partial', () => {
    const many = Array.from(
      { length: 5 },
      (_, index) => `int load${index}(const char *p) {\n  if (access(p, R_OK) != 0) return -1;\n  return open(p, O_RDONLY);\n}\n`,
    ).join('\n')
    const targetRoot = checkout({ 'src/many.c': many })
    seeded = seedState({
      symbols: Array.from({ length: 5 }, (_, index) => ({
        filePath: 'src/many.c',
        name: `load${index}`,
        startLine: index * 4 + 1,
        endLine: index * 4 + 4,
      })),
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
      maxSitesPerProducer: 2,
    })

    expect(result.sites).toHaveLength(2)
    expect(result.outcomes[0]!.capped).toBe(true)
    // A truncated sweep must not read as a complete one.
    expect(result.warnings[0]).toContain('reached the 2-site cap')
  })

  test('honours an FSM subset', () => {
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [{ filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 }],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
      fsms: ['double-fetch'],
    })

    expect(result.sites).toEqual([])
    // A restricted FSM set narrows which check-to-use machines run; it does not hide
    // the producers that were not asked for, and it does not disable the signal one or
    // the interprocedural one.
    expect(result.outcomes.map((outcome) => outcome.producer)).toEqual([
      'fsm:double-fetch',
      'signal:unsafe-call',
      'signal:reentrancy-window',
      'signal:shared-state',
      'signal:non-local-jump',
      'interproc',
    ])
  })

  test('no indexed functions is a warning, not a silent empty result', () => {
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({})

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
    })

    expect(result.sites).toEqual([])
    expect(result.warnings[0]).toContain('No indexed functions')
    // Every producer is still accounted for, so "no sites" is attributed to the
    // missing program model rather than to the producers finding nothing.
    expect(result.outcomes).toHaveLength(9)
  })

  test('a file that cannot be read is skipped rather than throwing', () => {
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [
        { filePath: 'src/missing.c', name: 'gone', startLine: 1, endLine: 4 },
        { filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 },
      ],
    })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
    })

    expect(result.sites.map((site) => site.functionName)).toEqual(['load'])
  })
})

/**
 * One handler, registered for two signals, doing three different wrong things.
 *
 * `g_stop` is shared with `main` and is *read before it is written*, so the finding's
 * anchor has to be the write rather than the first mention of the object; `syslog` is
 * not async-signal-safe; and `free(info); info = NULL;` is the textbook defensive pair
 * that is *not* defensive while the handler can be re-entered — which is what the two
 * registrations establish.
 */
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

describe('sweepFunctions \u2014 signal handlers', () => {
  const seedHandler = (targetRoot: string) =>
    seedState({
      symbols: [
        { filePath: 'src/sig.c', name: 'on_term', startLine: 4, endLine: 11 },
        { filePath: 'src/sig.c', name: 'main', startLine: 13, endLine: 18 },
      ],
    })

  test('the shapes are reported on the file\u2019s own line numbers', () => {
    const targetRoot = checkout({ 'src/sig.c': SIGNAL_HANDLER })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })

    expect(result.coverage.signalHandlers).toBe(1)
    // The two objects the handler touches that are not `sig_atomic_t`.
    expect(result.coverage.sharedKeys).toBe(2)

    const signalSites = result.sites.filter((site) => site.kind === 'signal')
    const byShape = Object.fromEntries(signalSites.map((site) => [site.shape, site.matchLine]))

    expect(byShape).toEqual({
      // `g_stop` is read at file line 5 and written at 6, and the anchor is the write —
      // pointing at line 5 would be pointing at a read while saying "written".
      'shared-state': 6,
      // The window points at the clear, with the release as the other end.
      'reentrancy-window': 10,
      // `syslog` only: the `free` on the window's line is superseded by the window.
      'unsafe-call': 8,
    })

    // The window's other end is the release, translated like everything else.
    const window = signalSites.find((site) => site.shape === 'reentrancy-window')!
    expect(window.checkLine).toBe(9)
    expect(window.signals).toEqual(['SIGINT', 'SIGTERM'])
    expect(window.evidence).toContain('released at line 9')

    const shared = signalSites.find((site) => site.shape === 'shared-state')!
    expect(shared.evidence).toContain('written at line 6')
    expect(shared.evidence).toContain('src/sig.c:16')
    expect(shared.evidence).toContain('`main`')
  })

  test('the lifetime FSM does not see the release-to-clear window', () => {
    // The division of labour the two producers rest on: `info = NULL` is not a *use*
    // of `info`, so `lifetime-race` is blind to this shape by construction. If this
    // ever fails, the two producers have started overlapping.
    const targetRoot = checkout({ 'src/sig.c': SIGNAL_HANDLER })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })

    expect(result.sites.filter((site) => site.kind === 'fsm')).toEqual([])
  })

  test('the producers are counted per shape, and a zero is not an absence', () => {
    const targetRoot = checkout({ 'src/sig.c': SIGNAL_HANDLER })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })
    const signalOutcomes = result.outcomes.filter((outcome) =>
      outcome.producer.startsWith('signal:'),
    )

    expect(signalOutcomes.map((outcome) => [outcome.producer, outcome.sites])).toEqual([
      ['signal:unsafe-call', 1],
      ['signal:reentrancy-window', 1],
      ['signal:shared-state', 1],
      ['signal:non-local-jump', 0],
    ])
  })

  test('an egrep-shaped handler with one signal is not re-enterable', () => {
    // The gate end to end: the same code, registered once, loses only the window.
    const targetRoot = checkout({
      'src/sig.c': SIGNAL_HANDLER.replace('signal(SIGTERM, on_term);', 'signal(SIGTERM, other);'),
    })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })
    const shapes = result.sites.map((site) => (site.kind === 'signal' ? site.shape : site.kind))

    expect(shapes).not.toContain('reentrancy-window')
    // `free` is now reported as the plain unsafe call it also is.
    expect(shapes).toContain('unsafe-call')
  })

  test('the signal producer can be declined', () => {
    const targetRoot = checkout({ 'src/sig.c': SIGNAL_HANDLER })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
      signalHandlers: false,
    })

    expect(result.sites).toEqual([])
    expect(result.coverage.signalHandlers).toBe(0)
    // Declined producers are not reported at all, unlike a producer that ran and found
    // nothing — the two are different statements.
    expect(result.outcomes.some((outcome) => outcome.producer.startsWith('signal:'))).toBe(false)
  })

  test('the signal-mask veto suppresses a race with the function that blocks', () => {
    const targetRoot = checkout({
      'src/sig.c': SIGNAL_HANDLER.replace('  while (g_stop == 0) { }', '  sigprocmask(SIG_BLOCK, &set, NULL);\n  while (g_stop == 0) { }'),
    })
    seeded = seedHandler(targetRoot)

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })
    const shapes = result.sites.map((site) => (site.kind === 'signal' ? site.shape : site.kind))

    // `main` blocks delivery around its access, so that access is not a race partner.
    expect(shapes).not.toContain('shared-state')
  })

  test('a handler the program model does not have is warned about, not silently skipped', () => {
    const targetRoot = checkout({
      'src/sig.c': 'void main2(void) {\n  signal(SIGINT, nowhere);\n}\n',
    })
    seeded = seedState({
      symbols: [{ filePath: 'src/sig.c', name: 'main2', startLine: 1, endLine: 3 }],
    })

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })

    expect(result.coverage.signalHandlers).toBe(0)
    expect(result.warnings.some((line) => line.includes('nowhere'))).toBe(true)
  })

  test('a callable in a language with no detector tables is counted, not swept', () => {
    // The regression this pins: widening the program model made Python, Go and
    // Java methods visible to a sweep whose tables are `access`/`open`/`->`.
    // Sweeping them would produce false positives rather than silence; dropping
    // them silently would make an untouched repository read as a clean one.
    // The Python fixture is *deliberately one the C tables would fire on*.
    // `access(path, ...)` then `open(path)` is the C path-check-then-use shape
    // exactly, and the event model does not know it is reading Python, so
    // without the filter below this method yields a second site. A benign
    // fixture would have made the test pass with the guard deleted — the first
    // version of this test did, which is why the fixture is spelled out here.
    //
    // `os.access(...)` deliberately will *not* do: the event model takes the
    // callee as the key for a member call, so it records the check against
    // `os.access` rather than `path` and the FSM never pairs it with the use.
    const pythonRace = [
      'class Loader:',
      '    def load(self, path):',
      '        if access(path, R_OK) != 0:',
      '            return None',
      '        return open(path)',
      '',
    ].join('\n')
    const targetRoot = checkout({
      'src/fs.c': PATH_RACE,
      'src/app.py': pythonRace,
    })
    seeded = seedState({
      symbols: [
        { filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4 },
        {
          filePath: 'src/app.py',
          name: 'load',
          startLine: 2,
          endLine: 5,
          kind: 'method',
          language: 'python',
        },
      ],
    })

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })

    // The C function was swept and found; the Python method was not swept at all.
    expect(result.sites).toHaveLength(1)
    expect(result.sites[0]!.filePath).toBe('src/fs.c')
    expect(result.coverage.functionsSwept).toBeGreaterThan(0)
    expect(result.coverage.noDetectorTables).toBe(1)
  })

  test('a method is swept like a function, because both are callables', () => {
    // The other half of the same change: `kind = 'function'` would have missed
    // this outright. In Python almost all real code is in methods.
    const targetRoot = checkout({ 'src/fs.c': PATH_RACE })
    seeded = seedState({
      symbols: [
        { filePath: 'src/fs.c', name: 'load', startLine: 1, endLine: 4, kind: 'method' },
      ],
    })

    const result = sweepFunctions({ db: seeded.db, targetId: seeded.targetId, targetRoot, rules: [] })

    expect(result.sites).toHaveLength(1)
    expect(result.coverage.noDetectorTables).toBe(0)
  })
})

describe('the caller-lock annotation', () => {
  const UNLOCKED_HELPER = 'int read_count(struct s *s) {\n  return s->count;\n}\n'

  const LOCKED_CALLER =
    'int caller(struct s *s) {\n' +
    '  mutex_lock(&s->mu);\n' +
    '  int value = read_count(s);\n' +
    '  mutex_unlock(&s->mu);\n' +
    '  return value;\n' +
    '}\n'

  const UNLOCKED_CALLER = 'int caller(struct s *s) {\n  return read_count(s);\n}\n'

  const HELPER = { filePath: 'src/helper.c', name: 'read_count', startLine: 1, endLine: 3 }
  const LOCKED_CALLER_SYMBOL = {
    filePath: 'src/main.c',
    name: 'caller',
    startLine: 1,
    endLine: 5,
  }
  const UNLOCKED_CALLER_SYMBOL = {
    filePath: 'src/main.c',
    name: 'caller',
    startLine: 1,
    endLine: 3,
  }

  const graphFor = (references: Array<{ filePath: string; name: string; line: number }>) =>
    buildCallGraph({
      definitions: [HELPER, LOCKED_CALLER_SYMBOL, UNLOCKED_CALLER_SYMBOL],
      references,
    })

  const atomicityOf = (site: { kind: string } | undefined) => {
    if (site?.kind !== 'atomicity') throw new Error('expected an atomicity site')
    return site as { kind: 'atomicity'; callerLock: unknown; evidence: string }
  }

  test('a helper reached only under the lock is annotated, never suppressed', () => {
    const targetRoot = checkout({
      'src/helper.c': UNLOCKED_HELPER,
      'src/main.c': LOCKED_CALLER,
    })
    seeded = seedState({ symbols: [HELPER, LOCKED_CALLER_SYMBOL] })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
      callGraph: graphFor([{ filePath: 'src/main.c', name: 'read_count', line: 3 }]),
    })

    // Option A in one assertion: the finding survives, carrying the caller evidence.
    expect(result.sites).toHaveLength(1)
    const site = atomicityOf(result.sites[0])
    expect(site.callerLock).toEqual({
      callers: 1,
      lockedCallers: 1,
      complete: true,
      allCallersLocked: true,
    })
    expect(site.evidence).toContain('every recorded caller holds `s->mu` across the call')
    expect(result.coverage.callerGuardedSites).toBe(1)
  })

  test('a caller that does not hold the lock is reported as such', () => {
    const targetRoot = checkout({
      'src/helper.c': UNLOCKED_HELPER,
      'src/main.c': UNLOCKED_CALLER,
    })
    seeded = seedState({ symbols: [HELPER, UNLOCKED_CALLER_SYMBOL] })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
      callGraph: graphFor([{ filePath: 'src/main.c', name: 'read_count', line: 2 }]),
    })

    const site = atomicityOf(result.sites[0])
    expect(site.callerLock).toMatchObject({ lockedCallers: 0, allCallersLocked: false })
    expect(site.evidence).toContain('no recorded caller holds `s->mu` across the call')
    expect(result.coverage.callerGuardedSites).toBe(0)
  })

  test('a call site the graph cannot place makes the caller set partial, and says so', () => {
    const targetRoot = checkout({
      'src/helper.c': UNLOCKED_HELPER,
      'src/main.c': LOCKED_CALLER,
    })
    seeded = seedState({ symbols: [HELPER, LOCKED_CALLER_SYMBOL] })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
      // A second call to the same name from a line no function covers: it might be a
      // caller the graph cannot see, so the count below it is a lower bound.
      callGraph: graphFor([
        { filePath: 'src/main.c', name: 'read_count', line: 3 },
        { filePath: 'src/other.c', name: 'read_count', line: 99 },
      ]),
    })

    const site = atomicityOf(result.sites[0])
    expect(site.callerLock).toMatchObject({ complete: false, allCallersLocked: false })
    expect(site.evidence).toContain('the caller set is partial')
    expect(result.coverage.callerGuardedSites).toBe(0)
  })

  test('turning the pass off leaves the annotation absent rather than empty', () => {
    const targetRoot = checkout({ 'src/helper.c': UNLOCKED_HELPER })
    seeded = seedState({ symbols: [HELPER] })

    const result = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
      interprocedural: false,
    })

    const site = atomicityOf(result.sites[0])
    expect(site.callerLock).toBeNull()
    expect(site.evidence).not.toContain('recorded caller')
    expect(result.coverage.callerGuardedSites).toBe(0)
  })
})

describe('the cross-function check-to-use producer', () => {
  const CALLER =
    'int load(const char *cfg) {\n' +
    '  if (access(cfg, R_OK) != 0) return -1;\n' +
    '  return load_config(cfg);\n' +
    '}\n'

  const CALLEE =
    'int load_config(const char *path) {\n' +
    '  FILE *f = fopen(path, "r");\n' +
    '  return f != NULL;\n' +
    '}\n'

  const LOAD = { filePath: 'src/load.c', name: 'load', startLine: 1, endLine: 4 }
  const LOAD_CONFIG = {
    filePath: 'src/config.c',
    name: 'load_config',
    startLine: 1,
    endLine: 4,
  }

  const sweepAcrossTheCall = () => {
    const targetRoot = checkout({ 'src/load.c': CALLER, 'src/config.c': CALLEE })
    seeded = seedState({ symbols: [LOAD, LOAD_CONFIG] })

    return sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
      callGraph: buildCallGraph({
        definitions: [LOAD, LOAD_CONFIG],
        references: [{ filePath: 'src/load.c', name: 'load_config', line: 3 }],
      }),
    })
  }

  test('a check in one function and a re-resolution in another is one site', () => {
    const result = sweepAcrossTheCall()

    expect(result.sites).toHaveLength(1)
    const site = result.sites[0]!
    expect(site.kind).toBe('interproc')
    if (site.kind !== 'interproc') throw new Error('expected an interproc site')

    // The caller's lines are file lines, the callee's is already file-absolute.
    expect(site.checkLine).toBe(2)
    expect(site.matchLine).toBe(3)
    expect(site.resource).toBe('cfg')
    expect(site.other).toEqual({
      filePath: 'src/config.c',
      functionName: 'load_config',
      fileLine: 2,
      callee: 'fopen',
    })
  })

  test('the evidence names both functions and both files', () => {
    const result = sweepAcrossTheCall()
    const site = result.sites[0]!

    expect(site.evidence).toContain('`cfg` is checked at line 2')
    expect(site.evidence).toContain('passed to `load_config` at line 3')
    expect(site.evidence).toContain('`fopen` at src/config.c:2')
  })

  test('the producer is accounted for separately and can be declined', () => {
    const ran = sweepAcrossTheCall()
    expect(ran.outcomes.find((outcome) => outcome.producer === 'interproc')?.sites).toBe(1)

    const targetRoot = checkout({ 'src/load.c': CALLER, 'src/config.c': CALLEE })
    seeded = seedState({ symbols: [LOAD, LOAD_CONFIG] })
    const declined = sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [],
      interprocedural: false,
    })

    expect(declined.sites).toEqual([])
    // Omitted rather than listed at zero: it did not run.
    expect(declined.outcomes.some((outcome) => outcome.producer === 'interproc')).toBe(false)
  })
})

describe('the call graph denominator', () => {
  const PLAIN = 'int read_count(struct s *s) {\n  return s->count;\n}\n'
  const SYMBOL = { filePath: 'src/plain.c', name: 'read_count', startLine: 1, endLine: 3 }

  const sweepWith = (callGraph: ReturnType<typeof buildCallGraph>) => {
    const targetRoot = checkout({ 'src/plain.c': PLAIN })
    seeded = seedState({ symbols: [SYMBOL] })
    return sweepFunctions({
      db: seeded.db,
      targetId: seeded.targetId,
      targetRoot,
      rules: [rule()],
      callGraph,
    })
  }

  test('call sites with no resolved edges warn rather than reading as clean', () => {
    const result = sweepWith(
      // One call site whose callee has no definition: an empty graph, not a clean tree.
      buildCallGraph({ definitions: [SYMBOL], references: [{ filePath: 'src/plain.c', name: 'absent', line: 2 }] }),
    )

    expect(result.coverage.callEdges).toBe(0)
    expect(result.coverage.callSitesSeen).toBe(1)
    expect(
      result.warnings.some((warning) => warning.includes('an empty graph, not a clean tree')),
    ).toBe(true)
  })

  test('a model with no call sites at all is a different statement and is not warned about', () => {
    const result = sweepWith(buildCallGraph({ definitions: [], references: [] }))

    expect(result.coverage.callSitesSeen).toBe(0)
    expect(result.warnings.some((warning) => warning.includes('empty graph'))).toBe(false)
  })

  test('the graph’s own numbers are carried on the coverage, not just in the log', () => {
    const result = sweepWith(
      buildCallGraph({ definitions: [SYMBOL], references: [{ filePath: 'src/plain.c', name: 'read_count', line: 2 }] }),
    )

    expect(result.coverage.callEdges).toBe(1)
    expect(result.coverage.callSitesSeen).toBe(1)
    expect(result.coverage.callSitesUnattributed).toBe(0)
    expect(result.coverage.callSitesAmbiguous).toBe(0)
  })
})
