import { describe, expect, test } from 'bun:test'

import { buildBindings } from './alias'
import { describeFsmFinding, describeSignalFinding, describeSite, describeViolation } from './describe'
import { extractEvents } from './events'
import { runFsm } from './fsm'
import { atomicityRuleId } from './rules'
import { runSignalShapes } from './signal'

import type {
  AtomicityRule,
  RuleViolation,
  SignalFinding,
  ToctouFinding,
  ToctouFsm,
} from './types'

const finding = (
  fsm: ToctouFsm,
  over: Partial<ToctouFinding> = {},
): ToctouFinding => ({
  fsm,
  checkLine: 1,
  middleLine: null,
  useLine: 2,
  resource: 'p',
  lock: null,
  ...over,
})

/** A translation that shifts a region line by 20, standing in for a real offset. */
const shift20 = (line: number): number => line + 20

describe('describeFsmFinding', () => {
  test('translates every line it prints into the reviewer\u2019s coordinates', () => {
    // The defect this function exists to prevent: a candidate that points at line 22
    // while its message says "line 2".
    const sentence = describeFsmFinding(
      finding('path-check-then-use', { checkLine: 2, useLine: 3 }),
      shift20,
    )

    expect(sentence).toContain('checked at line 22')
    expect(sentence).toContain('re-resolved at line 23')
    expect(sentence).not.toContain('line 2,')
  })

  test('names all three lines of a double fetch', () => {
    const sentence = describeFsmFinding(
      finding('double-fetch', { checkLine: 4, middleLine: 3, useLine: 5, resource: 'src' }),
      shift20,
    )

    expect(sentence).toContain('read at line 23')
    expect(sentence).toContain('checked at line 24')
    expect(sentence).toContain('read again at line 25')
    expect(sentence).toContain('the check saw only the first copy')
  })

  test('a double fetch with no middle event still reads correctly', () => {
    const sentence = describeFsmFinding(
      finding('double-fetch', { checkLine: 4, middleLine: null, useLine: 5 }),
      shift20,
    )

    expect(sentence).toContain('checked at line 24')
    expect(sentence).toContain('read again at line 25')
  })

  test('lock-scope names the lock and the release', () => {
    const sentence = describeFsmFinding(
      finding('lock-scope', {
        checkLine: 4,
        middleLine: 5,
        useLine: 6,
        resource: 's->count',
        lock: 's->mu',
      }),
      shift20,
    )

    expect(sentence).toContain('`s->count` is checked at line 24')
    expect(sentence).toContain('`s->mu` held')
    expect(sentence).toContain('released at line 25')
    expect(sentence).toContain('used at line 26')
  })

  test('lifetime-race names the release as the middle event', () => {
    const sentence = describeFsmFinding(
      finding('lifetime-race', { checkLine: 2, middleLine: 3, useLine: 4 }),
      shift20,
    )

    expect(sentence).toContain('passes a check at line 22')
    expect(sentence).toContain('released at line 23')
    expect(sentence).toContain('used at line 24')
  })

  test('a null lock is not printed as `null`', () => {
    const sentence = describeFsmFinding(
      finding('lock-scope', { lock: null, middleLine: null }),
      shift20,
    )
    expect(sentence).not.toContain('null')
    expect(sentence).toContain('the lock')
  })

  test('an empty resource is not printed as ``', () => {
    const sentence = describeFsmFinding(finding('path-check-then-use', { resource: '' }), shift20)
    expect(sentence).not.toContain('``')
    expect(sentence).toContain('the resource')
  })
})

describe('describeViolation', () => {
  const rule = (over: Partial<AtomicityRule> = {}): AtomicityRule => ({
    id: atomicityRuleId('g.hits', 'g.mu'),
    resource: 'g.hits',
    lock: 'g.mu',
    originPatchSha: 'd2fa956e0a9f99e6b02835141d781ea655c756fb',
    originFile: 'src/srv.c',
    occurrences: 1,
    ...over,
  })

  const violation = (over: Partial<RuleViolation> = {}): RuleViolation => ({
    line: 2,
    resource: 'g.hits',
    lock: 'g.mu',
    heldElsewhere: false,
    ...over,
  })

  test('carries the rule and the patch that established it', () => {
    // The rule is the premise of the claim, so a reviewer who disagrees needs the SHA
    // to argue with.
    const sentence = describeViolation(violation(), rule(), shift20)

    expect(sentence).toContain('`g.hits` is accessed at line 22')
    expect(sentence).toContain('never held in this function')
    expect(sentence).toContain(rule().id)
    expect(sentence).toContain('d2fa956e0a9f')
    expect(sentence).toContain('src/srv.c')
  })

  test('a mis-scoped lock reads differently from a missing one', () => {
    // Different findings, different fixes: "the lock is held but not here" is a
    // mis-scope, "never held" is a missing lock.
    const misplaced = describeViolation(violation({ heldElsewhere: true }), rule(), shift20)
    expect(misplaced).toContain('`g.mu` is held elsewhere in the function, not at that line')
    // The clause has to supply its own connective, or the sentence reads as
    // "accessed at line 22 with `g.mu` is held elsewhere".
    expect(misplaced).not.toContain('with `g.mu` is held')
  })
})

describe('describeSite', () => {
  test('prefixes an FSM site with the pattern it matched', () => {
    const sentence = describeSite({
      kind: 'fsm',
      fsm: 'path-check-then-use',
      ruleId: null,
      filePath: 'src/a.c',
      functionName: 'load',
      startLine: 1,
      endLine: 4,
      matchLine: 3,
      checkLine: 2,
      resource: 'path',
      lock: null,
      evidence: '`access(path)` is checked at line 2',
    })

    expect(sentence).toContain('Check-to-use ordering (path-check-then-use)')
    expect(sentence).toContain('path is checked and then re-resolved')
    expect(sentence).toContain('`access(path)` is checked at line 2')
  })

  test('prefixes an atomicity site with the framing its producer earns', () => {
    const sentence = describeSite({
      kind: 'atomicity',
      fsm: null,
      ruleId: 'ar_1',
      filePath: 'src/b.c',
      functionName: 'read_count',
      startLine: 1,
      endLine: 3,
      matchLine: 2,
      checkLine: null,
      resource: 'g.hits',
      lock: 'g.mu',
      evidence: '`g.hits` is accessed at line 2',
    })

    expect(sentence).toContain('Atomicity violation')
    // An atomicity violation is not one of the four FSMs, so it must not claim one.
    expect(sentence).not.toContain('Check-to-use ordering')
  })

  test('a signal site is framed as a signal race and not as an FSM', () => {
    const sentence = describeSite({
      kind: 'signal',
      fsm: null,
      ruleId: null,
      shape: 'unsafe-call',
      signals: ['SIGINT'],
      filePath: 'src/a.c',
      functionName: 'on_int',
      startLine: 1,
      endLine: 3,
      matchLine: 2,
      checkLine: null,
      resource: 'syslog',
      lock: null,
      evidence: '`syslog` is called at line 2',
    })

    expect(sentence).toContain('Signal handler race (unsafe-call)')
    expect(sentence).not.toContain('Check-to-use ordering')
    expect(sentence).not.toContain('Atomicity violation')
  })
})

describe('describeSignalFinding', () => {
  const shift20 = (line: number): number => line + 20

  test('translates every line it prints into the reviewer\u2019s coordinates', () => {
    const sentence = describeSignalFinding(
      {
        shape: 'reentrancy-window',
        releaseLine: 2,
        invalidateLine: 3,
        resource: 'info',
        signals: ['SIGHUP', 'SIGTERM'],
      },
      shift20,
    )

    expect(sentence).toContain('released at line 22')
    expect(sentence).toContain('cleared at line 23')
    expect(sentence).not.toContain('line 2,')
  })

  test('the re-entrancy claim states which signals make it possible', () => {
    // The sentence reads as an overclaim until the reader sees that two signals are
    // involved — a single-signal handler is blocked against itself.
    const sentence = describeSignalFinding(
      {
        shape: 'reentrancy-window',
        releaseLine: 2,
        invalidateLine: 3,
        resource: 'info',
        signals: ['SIGHUP', 'SIGTERM'],
      },
      (line) => line,
    )

    expect(sentence).toContain('`SIGHUP` and `SIGTERM`')
  })

  test('shared state names the other function and whether it writes', () => {
    const sentence = describeSignalFinding(
      {
        shape: 'shared-state',
        line: 2,
        wrote: true,
        resource: 'g_stop',
        other: {
          filePath: 'src/main.c',
          functionName: 'main',
          fileLine: 12,
          written: false,
          isHandler: false,
        },
        signals: ['SIGINT'],
      },
      shift20,
    )

    expect(sentence).toContain('`g_stop` is written at line 22')
    expect(sentence).toContain('src/main.c:12')
    expect(sentence).toContain('`main`')
    // The other end of a shared-state claim is already a file line; it must not be
    // translated a second time.
    expect(sentence).toContain(':12')
    expect(sentence).not.toContain(':32')
  })

  test('another handler sharing state is named as one', () => {
    const sentence = describeSignalFinding(
      {
        shape: 'shared-state',
        line: 2,
        wrote: false,
        resource: 'g_stop',
        other: {
          filePath: 'src/a.c',
          functionName: 'on_term',
          fileLine: 5,
          written: true,
          isHandler: true,
        },
        signals: ['SIGINT'],
      },
      (line) => line,
    )

    expect(sentence).toContain('other handler')
  })

  test('a non-local jump says what was never unwound', () => {
    const sentence = describeSignalFinding(
      { shape: 'non-local-jump', line: 2, resource: 'longjmp', callee: 'longjmp', signals: [] },
      (line) => line,
    )

    expect(sentence).toContain('`longjmp` is called at line 2')
    expect(sentence).toContain('never returns')
  })

  test('an unsafe call names the function and the framing', () => {
    const sentence = describeSignalFinding(
      { shape: 'unsafe-call', line: 4, resource: 'syslog', callee: 'syslog', signals: ['SIGINT'] },
      (line) => line,
    )

    expect(sentence).toContain('not async-signal-safe')
    expect(sentence).toContain('in a signal handler registered for `SIGINT`')
  })

  test('the handler phrase is a location, not a fragment', () => {
    // The first CLI run over a real target printed "`syslog` is called at line 16 in
    // registered for `SIGHUP` and `SIGTERM`" — one phrase serving two grammatical
    // positions.
    const sentence = describeSignalFinding(
      {
        shape: 'unsafe-call',
        line: 4,
        resource: 'syslog',
        callee: 'syslog',
        signals: ['SIGHUP', 'SIGTERM'],
      },
      (line) => line,
    )

    expect(sentence).toContain('in a signal handler registered for `SIGHUP` and `SIGTERM`')
    expect(sentence).not.toContain('in registered for')
  })

  test('the window reads as a property of the handler', () => {
    const sentence = describeSignalFinding(
      {
        shape: 'reentrancy-window',
        releaseLine: 1,
        invalidateLine: 2,
        resource: 'p',
        signals: ['SIGHUP', 'SIGTERM'],
      },
      (line) => line,
    )

    expect(sentence).toContain('the handler is registered for `SIGHUP` and `SIGTERM`')
  })

  test('a registration with no known signal reads as a plain noun', () => {
    const sentence = describeSignalFinding(
      { shape: 'unsafe-call', line: 1, resource: 'free', callee: 'free', signals: [] },
      (line) => line,
    )

    expect(sentence).toContain('in a signal handler,')
    expect(sentence).not.toContain('registered for')
  })

  test('real source produces a sentence with file-line numbers', () => {
    // The end-to-end property, as the FSM counterpart has it: the shape finds a
    // region-relative pair, and by the time the sentence exists the numbers are the
    // ones in the file.
    const source = [
      'void on_int(int sig) {',
      '  free(info);',
      '  info = NULL;',
      '}',
    ]
    const result = runSignalShapes({
      lines: source,
      events: extractEvents(source),
      bindings: buildBindings(source),
      handler: {
        name: 'on_int',
        signals: ['SIGHUP', 'SIGTERM'],
        via: 'signal',
        nodefer: false,
        filePath: 'src/a.c',
        line: 1,
      },
      scope: { globals: new Set(), sigAtomic: new Set() },
      otherTouches: new Map(),
    })

    const window = result.findings.find(
      (entry): entry is Extract<SignalFinding, { shape: 'reentrancy-window' }> =>
        entry.shape === 'reentrancy-window',
    )
    expect(window).toBeDefined()

    // Pretend the function starts at line 20 of a file.
    const sentence = describeSignalFinding(window!, (line) => line + 19)

    expect(sentence).toContain('released at line 21')
    expect(sentence).toContain('cleared at line 22')
  })
})

describe('the FSMs and the prose agree', () => {
  test('a real function produces a sentence with file-line numbers', () => {
    // The end-to-end property: the FSM finds a region-relative pair, and by the time
    // the sentence exists the numbers are the ones in the file.
    const source = [
      'int read_count(struct s *s) {',
      '  int value;',
      '  mutex_lock(&s->mu);',
      '  if (s->count < 0) value = 0;',
      '  mutex_unlock(&s->mu);',
      '  return s->count;',
      '}',
    ]

    const findings = runFsm('lock-scope', extractEvents(source), buildBindings(source))
    expect(findings).toHaveLength(1)

    // Pretend the function starts at line 20 of a file.
    const sentence = describeFsmFinding(findings[0]!, (line) => line + 19)

    expect(sentence).toContain('checked at line 23')
    expect(sentence).toContain('released at line 24')
    expect(sentence).toContain('used at line 25')
  })
})
