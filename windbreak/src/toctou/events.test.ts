import { describe, expect, test } from 'bun:test'

import {
  accessedExpressions,
  bodyStartIndex,
  callSites,
  extractEvents,
  isPathCheckEvent,
  isPathUseEvent,
  isUseEvent,
} from './events'

import type { AtomicEvent } from './types'

const kindsOf = (events: readonly AtomicEvent[]): string[] =>
  events.map((event) => `${event.kind}:${event.key}`)

describe('callSites', () => {
  test('finds a callee with balanced, split arguments', () => {
    const [site] = callSites('  copy_from_user(&a, p + off(p), n);')
    expect(site!.callee).toBe('copy_from_user')
    expect(site!.args).toEqual(['&a', 'p + off(p)', 'n'])
  })

  test('skips keywords and member calls', () => {
    // `if (x)` is not a call to `if`, and `obj->fn(` is a call through an object
    // whose resource is the object itself, which the access pass records.
    expect(callSites('  if (x) {')).toEqual([])
    expect(callSites('  while (x) {')).toEqual([])
    expect(callSites('  obj->fn(1);')).toEqual([])
  })

  test('nests without truncating', () => {
    const [site] = callSites('  lock(thing(a, b), 2);')
    expect(site!.callee).toBe('lock')
    expect(site!.args).toEqual(['thing(a, b)', '2'])
  })
})

describe('bodyStartIndex', () => {
  test('is the line opening the body, or -1', () => {
    expect(bodyStartIndex(['int f(void) {', '  return 0;', '}'])).toBe(0)
    expect(bodyStartIndex(['int f(void)', '{', '  return 0;'])).toBe(1)
    expect(bodyStartIndex(['int x = 1;'])).toBe(-1)
  })
})

describe('accessedExpressions', () => {
  test('returns the whole path, not just the base', () => {
    expect(accessedExpressions(['  s->count += 1;'], 0)).toEqual([
      { key: 's->count', line: 1, text: '  s->count += 1;' },
    ])
  })

  test('finds several accesses on one line, deduplicated', () => {
    const found = accessedExpressions(['  s->a = s->b + s->a;'], 0)
    expect(found.map((access) => access.key)).toEqual(['s->a', 's->b'])
  })

  test('honours the start index rather than probing for a brace', () => {
    // A fragment has no signature to skip and its first brace is often an `if` inside
    // the region — probing would then report nothing before it.
    const lines = ['  mutex_lock(&s->mu);', '  if (x) {', '    s->count++;', '  }']
    expect(accessedExpressions(lines, 0).map((a) => a.key)).toEqual(['s->mu', 's->count'])
  })

  test('skips comment lines', () => {
    expect(accessedExpressions(['  // s->count is fine'], 0)).toEqual([])
  })
})

describe('extractEvents', () => {
  test('classifies a locked check-then-use function', () => {
    const events = extractEvents([
      'int read_count(struct s *s) {',
      '  int value;',
      '  mutex_lock(&s->mu);',
      '  if (s->count < 0) value = 0;',
      '  mutex_unlock(&s->mu);',
      '  return s->count;',
      '}',
    ])

    expect(kindsOf(events)).toEqual([
      'lock:&s->mu',
      'check:s->count',
      'unlock:&s->mu',
      'use:s->count',
    ])
  })

  test('the signature is skipped, so the function is not a call to itself', () => {
    // A declaration reads as a call (`int f(char *p)`), and an event stream that
    // began with a spurious call to `f` would put every function into every FSM.
    const events = extractEvents(['int paste(char *dst) {', '  return 0;', '}'])
    expect(events).toEqual([])
  })

  test('a release does not also read as a use of its own argument', () => {
    // `free(s->buf)` releases `s->buf`. Emitting a use of the same key on the same
    // line would make the lifetime FSM read the release as a use-after-free.
    const events = extractEvents(['void f(struct s *s) {', '  free(s->buf);', '}'])
    expect(kindsOf(events)).toEqual(['release:s->buf'])
  })

  test('a later dereference of a released pointer is a use of the whole path', () => {
    const events = extractEvents(['void f(char *p) {', '  free(p);', '  p->x = 1;', '}'])
    expect(kindsOf(events)).toEqual(['release:p', 'use:p->x'])
  })

  test('an unclassified call is a `call`, not a `use`', () => {
    // The distinction lets the FSMs decide: `process(p)` after `free(p)` is a use of
    // a released pointer, while `strlen(p)` before any release is not.
    const events = extractEvents(['void f(char *p) {', '  process(p);', '}'])
    expect(kindsOf(events)).toEqual(['call:p'])
    expect(isUseEvent(events[0]!)).toBe(true)
  })

  test('a conditional operand is a check, and `->` is not a comparison', () => {
    // `if (s->count > 0)` must yield `s->count`. An operator-first pattern reads the
    // `>` of `->` and yields `count`, which pairs with nothing.
    const events = extractEvents(['void f(struct s *s) {', '  if (s->count > 0) go();', '}'])
    expect(kindsOf(events)).toContain('check:s->count')
    expect(kindsOf(events)).not.toContain('check:count')
  })

  test('a callee in a condition is not a tested value', () => {
    const events = extractEvents([
      'void f(struct task *t) {',
      '  if (is_ready(t)) go();',
      '}',
    ])
    expect(kindsOf(events)).toContain('check:t')
    expect(kindsOf(events)).not.toContain('check:is_ready')
  })

  test('a negation tests its operand', () => {
    const events = extractEvents(['void f(struct task *t) {', '  if (!t->ready) return;', '}'])
    expect(kindsOf(events)).toContain('check:t->ready')
  })

  test('a fetch records its destination and its source', () => {
    const events = extractEvents([
      'int f(void __user *src) {',
      '  int len;',
      '  copy_from_user(&len, src, sizeof(len));',
      '}',
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'fetch',
      callee: 'copy_from_user',
      target: '&len',
      source: 'src',
    })
  })
})

describe('event predicates', () => {
  const event = (over: Partial<AtomicEvent>): AtomicEvent => ({
    kind: 'use',
    line: 1,
    key: 'path',
    text: '',
    callee: null,
    target: null,
    source: null,
    ...over,
  })

  test('only the call form of a check is a *path* check', () => {
    // `if (fd < 0)` followed by `open(path)` is not the filesystem race;
    // `access(path)` followed by `open(path)` is.
    expect(isPathCheckEvent(event({ kind: 'check', callee: 'access' }))).toBe(true)
    expect(isPathCheckEvent(event({ kind: 'check', callee: null }))).toBe(false)
  })

  test('only the call form of a use resolves a path', () => {
    expect(isPathUseEvent(event({ kind: 'use', callee: 'open' }))).toBe(true)
    expect(isPathUseEvent(event({ kind: 'use', callee: null }))).toBe(false)
  })

  test('use and call are both uses, for the FSMs', () => {
    expect(isUseEvent(event({ kind: 'use' }))).toBe(true)
    expect(isUseEvent(event({ kind: 'call' }))).toBe(true)
    expect(isUseEvent(event({ kind: 'check' }))).toBe(false)
    expect(isUseEvent(event({ kind: 'release' }))).toBe(false)
  })
})
