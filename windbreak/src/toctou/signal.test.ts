import { describe, expect, test } from 'bun:test'

import { buildBindings } from './alias'
import { extractEvents } from './events'
import {
  fileScopeDeclarations,
  globalTouches,
  invalidatedKeys,
  masksSignals,
  nonLocalJumps,
  reentrancyWindows,
  runSignalShapes,
  sharedStateRaces,
  signalFindingCheckLine,
  signalFindingLine,
  unsafeCalls,
} from './signal'

import type { SignalHandler, SignalOtherLocation } from './types'

const handler = (over: Partial<SignalHandler> = {}): SignalHandler => ({
  name: 'on_int',
  signals: ['SIGINT'],
  via: 'signal',
  nodefer: false,
  filePath: 'src/main.c',
  line: 3,
  ...over,
})

const scope = (globals: string[], sigAtomic: string[] = []) => ({
  globals: new Set(globals),
  sigAtomic: new Set(sigAtomic),
})

const other = (over: Partial<SignalOtherLocation> = {}): SignalOtherLocation => ({
  filePath: 'src/main.c',
  functionName: 'main',
  fileLine: 12,
  written: true,
  isHandler: false,
  ...over,
})

/** Analyse real source through the real event model, as `fsm.test.ts` does. */
const analyze = (
  lines: readonly string[],
  over: {
    handler?: SignalHandler
    scope?: ReturnType<typeof scope>
    otherTouches?: Map<string, SignalOtherLocation[]>
  } = {},
) =>
  runSignalShapes({
    lines,
    events: extractEvents(lines),
    bindings: buildBindings(lines),
    handler: over.handler ?? handler(),
    scope: over.scope ?? scope([]),
    otherTouches: over.otherTouches ?? new Map(),
  })

describe('fileScopeDeclarations', () => {
  test('finds the objects a file declares outside every function', () => {
    const { globals } = fileScopeDeclarations([
      'int g_count = 0;',
      'static char *info = NULL;',
      'unsigned long g_a, g_b;',
      // A macro-sized bound, which is the normal spelling: the bound must not become
      // the object's name.
      'int g_buf[MAX_LEN];',
      'void on_int(int sig) {',
      '  g_count = 1;',
      '}',
    ])

    expect([...globals].sort()).toEqual(['g_a', 'g_b', 'g_buf', 'g_count', 'info'])
  })

  test('an empty function body does not swallow what follows it', () => {
    // A body with no statement in it never reaches a `;`, so a scanner that waited for
    // one to close the declaration would stay open across the next declaration and lose
    // it. An empty stub handler is exactly how that code gets written.
    const { globals } = fileScopeDeclarations([
      'void on_int(int sig) {',
      '}',
      'int g_stop = 0;',
      'void on_term(int sig) {',
      '  return;',
      '}',
      'static char *info = NULL;',
    ])

    expect([...globals].sort()).toEqual(['g_stop', 'info'])
  })

  test('a multi-line signature is abandoned at its brace', () => {
    const { globals } = fileScopeDeclarations([
      'static void',
      'on_int(int sig)',
      '{',
      '  return;',
      '}',
      'int g_stop = 0;',
    ])

    expect([...globals]).toEqual(['g_stop'])
  })

  test('a function body is not read as declarations', () => {
    // The load-bearing case: without telling a body apart from a file-scope
    // initialiser, the scanner swallows the body and reports parameters as globals.
    const { globals } = fileScopeDeclarations([
      'int g_count = 0;',
      'void on_int(int sig) {',
      '  int local = 1;',
      '  g_count = local;',
      '}',
    ])

    expect([...globals]).toEqual(['g_count'])
    expect(globals.has('sig')).toBe(false)
    expect(globals.has('local')).toBe(false)
  })

  test('a file-scope initialiser list is one declaration, not a body', () => {
    const { globals } = fileScopeDeclarations([
      'static const char *names[] =',
      '{',
      '  "a",',
      '};',
    ])

    expect([...globals]).toEqual(['names'])
  })

  test('a table initialised with a call or a sizeof keeps its name', () => {
    // `{ .len = sizeof(x) }` is one of the most common shapes a file-scope table has,
    // and a prototype test that looked at the whole declaration instead of the
    // declarator head dropped every one of them.
    const { globals, sigAtomic } = fileScopeDeclarations([
      'static const struct op ops[] = { { .name = dup("x"), .len = sizeof(int) } };',
      'volatile sig_atomic_t eflag = 0;',
    ])

    expect([...globals]).toEqual(['ops', 'eflag'])
    expect([...sigAtomic]).toEqual(['eflag'])
  })

  test('a struct definition contributes no names', () => {
    const { globals } = fileScopeDeclarations(['struct point {', '  int x;', '  int y;', '};'])

    expect([...globals]).toEqual([])
  })

  test('a prototype is not an object', () => {
    const { globals } = fileScopeDeclarations(['int helper(int x);'])

    expect([...globals]).toEqual([])
  })

  test('sig_atomic_t is separated out, because it is the fix', () => {
    const { globals, sigAtomic } = fileScopeDeclarations([
      'volatile sig_atomic_t eflag = 0;',
      'int g_count = 0;',
    ])

    expect([...sigAtomic]).toEqual(['eflag'])
    expect(globals.has('g_count')).toBe(true)
  })
})

describe('globalTouches', () => {
  const lines = (body: string[]): string[] => ['void on_int(int sig) {', ...body, '}']

  test('a read and a write are both touches, and are told apart', () => {
    const touches = globalTouches({
      lines: lines(['  if (g_stop == 0) {', '    g_stop = 1;', '  }']),
      scope: scope(['g_stop']),
    })

    expect(touches).toHaveLength(1)
    // One entry per object, at the first line it appears — with the write recorded on
    // the line the write is *on*, which is not always the same line.
    expect(touches[0]).toMatchObject({ key: 'g_stop', line: 2, wroteAt: 3, wrote: true })
  })

  test('a read-only touch has no write line at all', () => {
    const touches = globalTouches({ lines: lines(['  return g_flag;']), scope: scope(['g_flag']) })

    expect(touches[0]).toMatchObject({ line: 2, wroteAt: null, wrote: false })
  })

  test('a comparison is not a write', () => {
    const touches = globalTouches({ lines: lines(['  return g_flag == 1;']), scope: scope(['g_flag']) })

    expect(touches[0]!.wrote).toBe(false)
  })

  test('a subscript target is a write to the global', () => {
    const touches = globalTouches({
      lines: lines(['  g_buf[i] = 0;']),
      scope: scope(['g_buf']),
    })

    expect(touches[0]!.wrote).toBe(true)
  })

  test('a compound assignment is a write', () => {
    const touches = globalTouches({ lines: lines(['  g_total += 1;']), scope: scope(['g_total']) })

    expect(touches[0]!.wrote).toBe(true)
  })

  test('a field access through a global is a touch, not a write', () => {
    const touches = globalTouches({ lines: lines(['  return g_state->n;']), scope: scope(['g_state']) })

    expect(touches).toHaveLength(1)
    expect(touches[0]!.wrote).toBe(false)
  })

  test('a local that is not declared at file scope is not a touch', () => {
    // The precision property the whole shape rests on: two unrelated locals that
    // happen to share a name are not one shared object.
    const touches = globalTouches({ lines: lines(['  int n = 1;', '  return n;']), scope: scope([]) })

    expect(touches).toEqual([])
  })
})

describe('invalidatedKeys', () => {
  const lines = (body: string[]): string[] => ['void on_int(int sig) {', ...body, '}']

  test('NULL, nullptr and zero all clear a reference', () => {
    const found = invalidatedKeys(lines(['  info = NULL;', '  other = nullptr;', '  third = 0;']))

    expect(found.map((entry) => entry.key)).toEqual(['info', 'other', 'third'])
    expect(found.map((entry) => entry.line)).toEqual([2, 3, 4])
  })

  test('an identifier that merely starts with NULL is not a clear', () => {
    expect(invalidatedKeys(lines(['  info = NULL_MESSAGE;']))).toEqual([])
  })

  test('an equality test is not a clear', () => {
    expect(invalidatedKeys(lines(['  if (info == NULL) return;']))).toEqual([])
  })
})

describe('masksSignals', () => {
  test('recognises a blocking call', () => {
    expect(masksSignals(['void f(void) {', '  sigprocmask(SIG_BLOCK, &set, NULL);', '}'])).toBe(true)
    expect(masksSignals(['void f(void) {', '  pthread_sigmask(SIG_BLOCK, &set, NULL);', '}'])).toBe(true)
  })

  test('a function that never blocks does not', () => {
    expect(masksSignals(['void f(void) {', '  write(2, "x", 1);', '}'])).toBe(false)
  })
})

describe('unsafeCalls', () => {
  const events = (body: string[]) => extractEvents(['void on_int(int sig) {', ...body, '}'])

  test('a non-async-signal-safe call is reported at its own line', () => {
    const found = unsafeCalls(events(['  syslog(LOG_NOTICE, "gone");']))

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ shape: 'unsafe-call', callee: 'syslog', line: 2 })
  })

  test('close is safe and fclose is not, on adjacent lines', () => {
    // `close` is in the POSIX list; `fclose` is stdio with a buffer behind it. A table
    // that lumped them together would either miss the stdio family or ban closing fds.
    const found = unsafeCalls(events(['  close(fd);', '  fclose(stream);']))

    expect(found).toHaveLength(1)
    expect(found[0]!.callee).toBe('fclose')
  })

  test('a release is reported once', () => {
    const found = unsafeCalls(events(['  free(info);']))

    expect(found).toHaveLength(1)
    expect(found[0]!.callee).toBe('free')
  })

  test('a safe call is not reported', () => {
    expect(unsafeCalls(events(['  write(2, "x", 1);']))).toEqual([])
  })
})

describe('nonLocalJumps', () => {
  test('longjmp is its own shape, not an unsafety', () => {
    const events = extractEvents(['void on_int(int sig) {', '  longjmp(env, 1);', '}'])
    const found = nonLocalJumps(events)

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ shape: 'non-local-jump', callee: 'longjmp', line: 2 })
  })
})

describe('reentrancyWindows', () => {
  const RELEASE_THEN_CLEAR = [
    'void on_int(int sig) {',
    '  free(info);',
    '  info = NULL;',
    '}',
  ]

  test('a single-signal handler cannot re-enter, so there is no window', () => {
    // This precondition is the shape's entire precision story: a handler installed for
    // one signal is blocked against itself while it runs.
    const found = reentrancyWindows({
      events: extractEvents(RELEASE_THEN_CLEAR),
      lines: RELEASE_THEN_CLEAR,
      bindings: buildBindings(RELEASE_THEN_CLEAR),
      handler: handler({ signals: ['SIGINT'] }),
    })

    expect(found).toEqual([])
  })

  test('two signals make the window real', () => {
    const found = reentrancyWindows({
      events: extractEvents(RELEASE_THEN_CLEAR),
      lines: RELEASE_THEN_CLEAR,
      bindings: buildBindings(RELEASE_THEN_CLEAR),
      handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }),
    })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      shape: 'reentrancy-window',
      releaseLine: 2,
      invalidateLine: 3,
      resource: 'info',
    })
  })

  test('SA_NODEFER makes the window real on one signal', () => {
    const found = reentrancyWindows({
      events: extractEvents(RELEASE_THEN_CLEAR),
      lines: RELEASE_THEN_CLEAR,
      bindings: buildBindings(RELEASE_THEN_CLEAR),
      handler: handler({ signals: ['SIGINT'], nodefer: true }),
    })

    expect(found).toHaveLength(1)
  })

  test('a release with no clear is left to the lifetime FSM', () => {
    const lines = ['void on_int(int sig) {', '  free(info);', '  use(info);', '}']
    const found = reentrancyWindows({
      events: extractEvents(lines),
      lines,
      bindings: buildBindings(lines),
      handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }),
    })

    expect(found).toEqual([])
  })

  test('the clear must come after the release', () => {
    const lines = ['void on_int(int sig) {', '  info = NULL;', '  free(info);', '}']
    const found = reentrancyWindows({
      events: extractEvents(lines),
      lines,
      bindings: buildBindings(lines),
      handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }),
    })

    expect(found).toEqual([])
  })
})

describe('sharedStateRaces', () => {
  const LINES = ['void on_int(int sig) {', '  g_stop = 1;', '}']

  test('a non-atomic object touched elsewhere is a race', () => {
    const found = sharedStateRaces({
      touches: globalTouches({ lines: LINES, scope: scope(['g_stop']) }),
      scope: scope(['g_stop']),
      otherTouches: new Map([['g_stop', [other()]]]),
      signals: ['SIGINT'],
    })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ shape: 'shared-state', resource: 'g_stop', wrote: true })
    expect((found[0] as { other: SignalOtherLocation }).other.functionName).toBe('main')
  })

  test('sig_atomic_t is the documented fix and is not reported', () => {
    const found = sharedStateRaces({
      touches: globalTouches({ lines: LINES, scope: scope(['g_stop'], ['g_stop']) }),
      scope: scope(['g_stop'], ['g_stop']),
      otherTouches: new Map([['g_stop', [other()]]]),
      signals: ['SIGINT'],
    })

    expect(found).toEqual([])
  })

  test('the anchor is the write, not the first mention', () => {
    // A finding whose text reads "written at line 2" while line 2 is a read sends a
    // reviewer to the wrong line. This is the shape the first CLI run over a real target
    // printed, which is how the bug was found.
    const readThenWrite = [
      'void on_int(int sig) {',
      '  if (g_stop == 0) {',
      '    g_stop = 1;',
      '  }',
      '}',
    ]
    const found = sharedStateRaces({
      touches: globalTouches({ lines: readThenWrite, scope: scope(['g_stop']) }),
      scope: scope(['g_stop']),
      otherTouches: new Map([['g_stop', [other()]]]),
      signals: ['SIGINT'],
    })

    expect(found[0]).toMatchObject({ line: 3, wrote: true })
  })

  test('a handler that only reads is anchored on the read and says so', () => {
    const readOnly = ['void on_int(int sig) {', '  if (g_flag != 0) return;', '}']
    const found = sharedStateRaces({
      touches: globalTouches({ lines: readOnly, scope: scope(['g_flag']) }),
      scope: scope(['g_flag']),
      // The handler never writes it; the other function does, which is what makes it a
      // race rather than a shared read.
      otherTouches: new Map([['g_flag', [other({ written: true })]]]),
      signals: ['SIGINT'],
    })

    expect(found[0]).toMatchObject({ line: 2, wrote: false })
  })

  test('an object nobody writes is not a race', () => {
    // The mutation gate, which is what keeps enum-like constants and configuration
    // out of the output.
    const readOnly = ['void on_int(int sig) {', '  if (g_mode != 0) return;', '}']
    const found = sharedStateRaces({
      touches: globalTouches({ lines: readOnly, scope: scope(['g_mode']) }),
      scope: scope(['g_mode']),
      otherTouches: new Map([['g_mode', [other({ written: false })]]]),
      signals: ['SIGINT'],
    })

    expect(found).toEqual([])
  })

  test('an object no other function touches is not shared', () => {
    const found = sharedStateRaces({
      touches: globalTouches({ lines: LINES, scope: scope(['g_stop']) }),
      scope: scope(['g_stop']),
      otherTouches: new Map(),
      signals: ['SIGINT'],
    })

    expect(found).toEqual([])
  })

  test('a writer elsewhere is preferred as the race partner', () => {
    const found = sharedStateRaces({
      touches: globalTouches({ lines: LINES, scope: scope(['g_stop']) }),
      scope: scope(['g_stop']),
      otherTouches: new Map([
        [
          'g_stop',
          [other({ functionName: 'reader', written: false }), other({ functionName: 'writer' })],
        ],
      ]),
      signals: ['SIGINT'],
    })

    expect((found[0] as { other: SignalOtherLocation }).other.functionName).toBe('writer')
  })

  test('one object reported once however many places touch it', () => {
    const found = sharedStateRaces({
      touches: globalTouches({ lines: LINES, scope: scope(['g_stop']) }),
      scope: scope(['g_stop']),
      otherTouches: new Map([['g_stop', [other(), other({ functionName: 'other' })]]]),
      signals: ['SIGINT'],
    })

    expect(found).toHaveLength(1)
  })
})

describe('runSignalShapes', () => {
  test('the window claim supersedes the unsafe call on the same line', () => {
    // `free` in a re-enterable handler is both not-async-signal-safe *and* a window.
    // They are one defect: the window's mechanism is the re-entrant free.
    const lines = [
      'void on_int(int sig) {',
      '  syslog(LOG_NOTICE, "gone");',
      '  free(info);',
      '  info = NULL;',
      '}',
    ]
    const result = analyze(lines, { handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }) })

    const shapes = result.findings.map((finding) => finding.shape).sort()
    expect(shapes).toEqual(['reentrancy-window', 'unsafe-call'])
    // The surviving unsafe call is `syslog`; the `free` on the window's line is gone.
    const call = result.findings.find((finding) => finding.shape === 'unsafe-call')
    expect((call as { callee: string }).callee).toBe('syslog')
    expect(result.suppressed).toBe(1)
  })

  test('a plain handler reports its unsafe calls once each', () => {
    const lines = ['void on_int(int sig) {', '  printf("x");', '  return;', '}']
    const result = analyze(lines)

    expect(result.findings).toHaveLength(1)
    expect(result.suppressed).toBe(0)
    expect(result.findings[0]!.signals).toEqual(['SIGINT'])
  })

  test('every finding carries the signals that installed the handler', () => {
    const lines = ['void on_int(int sig) {', '  longjmp(env, 1);', '}']
    const result = analyze(lines, { handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }) })

    expect(result.findings[0]!.signals).toEqual(['SIGHUP', 'SIGTERM'])
  })

  test('the anchor is the far end of the claim', () => {
    const lines = ['void on_int(int sig) {', '  free(info);', '  info = NULL;', '}']
    const result = analyze(lines, { handler: handler({ signals: ['SIGHUP', 'SIGTERM'] }) })
    const finding = result.findings[0]!

    // The invalidation is what a reviewer opens; the release is the other end.
    expect(signalFindingLine(finding)).toBe(3)
    expect(signalFindingCheckLine(finding)).toBe(2)
  })

  test('the call shapes have no second end', () => {
    const result = analyze(['void on_int(int sig) {', '  printf("x");', '}'])

    expect(signalFindingCheckLine(result.findings[0]!)).toBeNull()
  })
})
