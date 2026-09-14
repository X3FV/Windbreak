import { describe, expect, test } from 'bun:test'

import { buildBindings } from './alias'
import { extractEvents } from './events'
import { runAllFsms, runFsm } from './fsm'

import type { ToctouFsm } from './types'

/**
 * Run one FSM over real C source.
 *
 * Deliberately through `extractEvents` rather than a hand-built event list: the FSMs
 * are statements about the event model, so a fixture that skipped the model could
 * pass while the pipeline detected nothing.
 */
const find = (fsm: ToctouFsm, source: readonly string[]) =>
  runFsm(fsm, extractEvents(source), buildBindings(source))

/** Same, but every FSM, so a test can assert which one spoke. */
const findAll = (source: readonly string[]) =>
  runAllFsms(extractEvents(source), buildBindings(source))

describe('path-check-then-use', () => {
  const CVE_SHAPE = [
    'int load(const char *path) {',
    '  if (access(path, R_OK) != 0) return -1;',
    '  int fd = open(path, O_RDONLY);',
    '  return fd;',
    '}',
  ]

  test('fires when a checked path is re-resolved by a later call', () => {
    const findings = find('path-check-then-use', CVE_SHAPE)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      fsm: 'path-check-then-use',
      checkLine: 2,
      // Nothing between the check and the call: this FSM is about the pair alone.
      middleLine: null,
      useLine: 3,
      resource: 'path',
      lock: null,
    })
  })

  test('does not fire when the use resolves a different path', () => {
    // A check on `a` says nothing about `b`, and firing here would report a race
    // between two unrelated objects.
    const findings = find('path-check-then-use', [
      'int load(const char *a, const char *b) {',
      '  if (access(a, R_OK) != 0) return -1;',
      '  int fd = open(b, O_RDONLY);',
      '  return fd;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('pairs the use with the latest check', () => {
    const findings = find('path-check-then-use', [
      'int load(const char *path) {',
      '  if (access(path, R_OK) != 0) return -1;',
      '  if (access(path, W_OK) != 0) return -1;',
      '  return open(path, O_RDONLY);',
      '}',
    ])

    expect(findings).toHaveLength(1)
    // The second check is the one the use is entitled to rely on.
    expect(findings[0]!.checkLine).toBe(3)
  })

  test('an ordinary comparison is not a path check', () => {
    // `check` is also emitted for a condition's operands, and only the call form says
    // anything about a name.
    const findings = find('path-check-then-use', [
      'int load(int fd, const char *path) {',
      '  if (fd < 0) return -1;',
      '  return open(path, O_RDONLY);',
      '}',
    ])

    expect(findings).toEqual([])
  })
})

describe('double-fetch', () => {
  const DOUBLE_FETCH = [
    'int read_len(void __user *src) {',
    '  int len;',
    '  if (copy_from_user(&len, src, sizeof(len))) return -1;',
    '  if (len > MAX_LEN) return -1;',
    '  if (copy_from_user(&len, src, sizeof(len))) return -1;',
    '  return len;',
    '}',
  ]

  test('fires when a checked value is read again from the same source', () => {
    const findings = find('double-fetch', DOUBLE_FETCH)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      fsm: 'double-fetch',
      // The first read, so the sentence can say which read the check was about.
      middleLine: 3,
      checkLine: 4,
      useLine: 5,
      resource: 'src',
    })
  })

  test('does not fire when nothing was checked between the reads', () => {
    // The bug is that the check ran against the *first* copy; without a check between
    // the two reads there is no such claim to make.
    const findings = find('double-fetch', [
      'int read_len(void __user *src) {',
      '  int len;',
      '  copy_from_user(&len, src, sizeof(len));',
      '  copy_from_user(&len, src, sizeof(len));',
      '  return len;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('two reads from different sources are two values, not a double fetch', () => {
    const findings = find('double-fetch', [
      'int read_len(void __user *a, void __user *b) {',
      '  int len;',
      '  copy_from_user(&len, a, sizeof(len));',
      '  if (len > MAX_LEN) return -1;',
      '  copy_from_user(&len, b, sizeof(len));',
      '  return len;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('the check must be about the first copy', () => {
    const findings = find('double-fetch', [
      'int read_len(void __user *src, int other) {',
      '  int len;',
      '  copy_from_user(&len, src, sizeof(len));',
      '  if (other > MAX_LEN) return -1;',
      '  copy_from_user(&len, src, sizeof(len));',
      '  return len;',
      '}',
    ])

    expect(findings).toEqual([])
  })
})

describe('lock-scope', () => {
  test('fires when the lock is released before the use', () => {
    const findings = find('lock-scope', [
      'int read_count(struct s *s) {',
      '  int value;',
      '  mutex_lock(&s->mu);',
      '  if (s->count < 0) value = 0;',
      '  mutex_unlock(&s->mu);',
      '  return s->count;',
      '}',
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      fsm: 'lock-scope',
      checkLine: 4,
      // The unlock, which is the event that makes this a defect at all.
      middleLine: 5,
      useLine: 6,
      lock: '&s->mu',
    })
  })

  test('the held lock is a veto, not a signal', () => {
    // A check and a use inside one held lock are not a race — they are the fix, and
    // reporting them would make the FSM useless on correctly-locked code.
    const findings = find('lock-scope', [
      'int read_count(struct s *s) {',
      '  int value;',
      '  mutex_lock(&s->mu);',
      '  if (s->count < 0) value = 0;',
      '  return s->count;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('a check outside any lock is not a lock-scope finding', () => {
    // There was no invariant to lose, so the defect (if any) is a missing lock, which
    // is what a mined atomicity rule reports — not a mis-scoped one.
    const findings = find('lock-scope', [
      'int read_count(struct s *s) {',
      '  if (s->count < 0) return 0;',
      '  return s->count;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('a lock taken through a local is recognised', () => {
    const findings = find('lock-scope', [
      'int read_count(struct s *s) {',
      '  struct mutex *m = &s->mu;',
      '  int value;',
      '  mutex_lock(m);',
      '  if (s->count < 0) value = 0;',
      '  mutex_unlock(m);',
      '  return s->count;',
      '}',
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]!.useLine).toBe(7)
  })
})

describe('lifetime-race', () => {
  test('fires when a checked pointer is released and then dereferenced', () => {
    const findings = find('lifetime-race', [
      'void use(struct obj *p) {',
      '  if (p == NULL) return;',
      '  free(p);',
      '  p->field = 1;',
      '}',
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      fsm: 'lifetime-race',
      checkLine: 2,
      useLine: 4,
      resource: 'p',
    })
  })

  test('containment is what pairs the release with a field use', () => {
    // Freeing `p` invalidates `p->field`. An equality-only matcher never pairs them,
    // which is the shape this FSM exists for.
    const findings = find('lifetime-race', [
      'void use(struct obj *p) {',
      '  if (p) check(p);',
      '  free(p);',
      '  p->inner->field = 1;',
      '}',
    ])

    expect(findings).toHaveLength(1)
    expect(findings[0]!.useLine).toBe(4)
  })

  test('a use without a preceding check is not a lifetime race', () => {
    // The stale-answer claim needs a check. A release-then-use with no check is a
    // plain use-after-free, which §4.3's memory-safety engines cover.
    const findings = find('lifetime-race', [
      'void use(struct obj *p) {',
      '  free(p);',
      '  p->field = 1;',
      '}',
    ])

    expect(findings).toEqual([])
  })

  test('a use still inside the lock that protected the check is vetoed', () => {
    const findings = find('lifetime-race', [
      'void use(struct obj *p, struct obj *q) {',
      '  mutex_lock(&q->mu);',
      '  if (p == NULL) goto out;',
      '  free(p);',
      '  q->count++;',
      '}',
    ])

    // `q->count` is not the released resource, so nothing fires — and `p` is never
    // used again.
    expect(findings).toEqual([])
  })
})

describe('runAllFsms', () => {
  test('tags each finding with the FSM that produced it', () => {
    const findings = findAll([
      'int load(const char *path) {',
      '  if (access(path, R_OK) != 0) return -1;',
      '  return open(path, O_RDONLY);',
      '}',
    ])

    expect(findings.map((finding) => finding.fsm)).toEqual(['path-check-then-use'])
  })

  test('one function can trigger several FSMs', () => {
    const findings = findAll([
      'int load(const char *path, void __user *src) {',
      '  int len;',
      '  if (access(path, R_OK) != 0) return -1;',
      '  copy_from_user(&len, src, sizeof(len));',
      '  if (len > MAX_LEN) return -1;',
      '  copy_from_user(&len, src, sizeof(len));',
      '  return open(path, O_RDONLY);',
      '}',
    ])

    expect([...new Set(findings.map((finding) => finding.fsm))].sort()).toEqual([
      'double-fetch',
      'path-check-then-use',
    ])
  })
})
