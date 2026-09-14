import { describe, expect, test } from 'bun:test'

import { postImage, preImage } from './diff'
import {
  acquiresLock,
  callArguments,
  classifyHunk,
  detectShape,
  nullTestedIdentifiers,
  pointerParameters,
  releasesLock,
  signatureText,
  splitTopLevel,
} from './shapes'

import type { DiffLine, Hunk } from './types'

/** Build a hunk from `[kind, text]` pairs, numbering both sides. */
const hunk = (lines: Array<['context' | 'added' | 'removed', string]>): Hunk => {
  let old = 10
  let next = 10

  const built: DiffLine[] = lines.map(([kind, text]) => {
    if (kind === 'context') {
      const line: DiffLine = { kind, text, oldLine: old, newLine: next }
      old += 1
      next += 1
      return line
    }
    if (kind === 'added') {
      const line: DiffLine = { kind, text, oldLine: null, newLine: next }
      next += 1
      return line
    }
    const line: DiffLine = { kind, text, oldLine: old, newLine: null }
    old += 1
    return line
  })

  return {
    filePath: 'src/unsafe.c',
    oldStart: 10,
    oldCount: built.length,
    newStart: 10,
    newCount: built.length,
    lines: built,
  }
}

/** §4.4.1's validation, expressed once so every shape is tested the same way. */
const validates = (
  subject: Hunk,
  shape: Parameters<typeof detectShape>[1],
  hint: { subject?: string | null; operation?: string | null },
): { pre: boolean; post: boolean; accepted: boolean } => {
  const pre = detectShape(preImage(subject), shape, hint) !== null
  const post = detectShape(postImage(subject), shape, hint) !== null
  return { pre, post, accepted: pre && !post }
}

describe('classifyHunk', () => {
  test('a null check names the tested pointer and the call it guards', () => {
    const classified = classifyHunk(
      hunk([
        ['context', '  int n = 0;'],
        ['removed', '  strcpy(dst, src);'],
        ['added', '  if (dst == NULL) return -1;'],
        ['added', '  strcpy(dst, src);'],
      ]),
    )

    expect(classified?.shape).toBe('null-check')
    expect(classified?.hint.subject).toBe('dst')
    expect(classified?.hint.operation).toBe('strcpy')
  })

  test('a bounds check names the index', () => {
    const classified = classifyHunk(
      hunk([
        ['context', '  char buf[16];'],
        ['removed', '  buf[idx] = 0;'],
        ['added', '  if (idx >= len) return -1;'],
        ['added', '  buf[idx] = 0;'],
      ]),
    )

    expect(classified?.shape).toBe('bounds-check')
    expect(classified?.hint.subject).toBe('idx')
  })

  test('a guard requires an assignment from a call in the pre-image', () => {
    const classified = classifyHunk(
      hunk([
        ['removed', '  read(fd, buf, n);'],
        ['added', '  ret = read(fd, buf, n);'],
        ['added', '  if (ret < 0) goto err;'],
      ]),
    )

    expect(classified?.shape).toBe('guard')
    expect(classified?.hint.subject).toBe('ret')
    expect(classified?.hint.operation).toBe('read')
  })

  test('a lock acquire classifies, with the guarded call as its operation', () => {
    const classified = classifyHunk(
      hunk([
        ['context', '  counter++;'],
        ['context', '  update(&state);'],
        ['added', '  mutex_lock(&state.mu);'],
      ]),
    )

    expect(classified?.shape).toBe('lock')
    expect(classified?.hint.subject).toBe('state')
    expect(classified?.hint.operation).toBe('update')
  })

  test('an added release classifies as a lifetime change', () => {
    const classified = classifyHunk(
      hunk([
        ['context', '  use(p);'],
        ['added', '  free(p);'],
        ['added', '  p = NULL;'],
      ]),
    )

    expect(classified?.shape).toBe('lifetime')
    expect(classified?.hint.subject).toBe('p')
  })

  test('an added `p = NULL` where the release already exists also classifies', () => {
    // Without this branch the most common real use-after-free fix — the release
    // left untouched, the nulling added — classifies as nothing at all, because
    // the line it is about is context rather than an added line.
    const classified = classifyHunk(
      hunk([
        ['context', '  free(p);'],
        ['added', '  p = NULL;'],
        ['removed', '  use(p);'],
      ]),
    )

    expect(classified?.shape).toBe('lifetime')
    expect(classified?.hint.subject).toBe('p')
  })

  test('`p = NULL` with no release in the pre-image does not classify', () => {
    // The guard that keeps 3b from firing on every `x = 0;` in every patch.
    const classified = classifyHunk(
      hunk([
        ['context', '  int x = 0;'],
        ['added', '  x = NULL;'],
      ]),
    )
    expect(classified).toBeNull()
  })

  test('`if (count == 0)` is not read as a null check', () => {
    // The deliberate narrowing, asserted because it is a recall cost paid on
    // purpose: accepting `0` would validate a "null check" on an integer, and a
    // false pattern that passes validation is worse than a missed one.
    const classified = classifyHunk(
      hunk([
        ['removed', '  count--;'],
        ['added', '  if (count == 0) return;'],
      ]),
    )
    expect(classified?.shape).not.toBe('null-check')
  })

  test('a hunk that adds no recognisable shape yields no pattern', () => {
    const classified = classifyHunk(
      hunk([
        ['removed', '  // old comment'],
        ['added', '  // new comment'],
      ]),
    )
    expect(classified).toBeNull()
  })

  test('a hunk with no added lines yields no pattern', () => {
    expect(classifyHunk(hunk([['removed', '  int a;']]))).toBeNull()
  })
})

describe('§4.4.1 validation — the detector must distinguish pre-image from post-image', () => {
  test('null-check', () => {
    const result = validates(
      hunk([
        ['context', '  int n = 0;'],
        ['removed', '  strcpy(dst, src);'],
        ['added', '  if (dst == NULL) return -1;'],
        ['added', '  strcpy(dst, src);'],
      ]),
      'null-check',
      { subject: 'dst', operation: 'strcpy' },
    )

    expect(result).toEqual({ pre: true, post: false, accepted: true })
  })

  test('bounds-check', () => {
    const result = validates(
      hunk([
        ['context', '  char buf[16];'],
        ['removed', '  buf[idx] = 0;'],
        ['added', '  if (idx >= len) return -1;'],
        ['added', '  buf[idx] = 0;'],
      ]),
      'bounds-check',
      { subject: 'idx', operation: null },
    )

    expect(result).toEqual({ pre: true, post: false, accepted: true })
  })

  test('guard', () => {
    const result = validates(
      hunk([
        ['removed', '  read(fd, buf, n);'],
        ['added', '  ret = read(fd, buf, n);'],
        ['added', '  if (ret < 0) goto err;'],
      ]),
      'guard',
      { subject: 'ret', operation: 'read' },
    )

    expect(result).toEqual({ pre: true, post: false, accepted: true })
  })

  test('lock', () => {
    const result = validates(
      hunk([
        ['context', '  counter++;'],
        ['context', '  update(&state);'],
        ['added', '  mutex_lock(&state.mu);'],
      ]),
      'lock',
      { subject: 'state', operation: 'update' },
    )

    expect(result).toEqual({ pre: true, post: false, accepted: true })
  })

  test('lifetime, for the added-null form', () => {
    const result = validates(
      hunk([
        ['context', '  free(p);'],
        ['added', '  p = NULL;'],
        ['removed', '  use(p);'],
      ]),
      'lifetime',
      { subject: 'p', operation: null },
    )

    expect(result).toEqual({ pre: true, post: false, accepted: true })
  })

  test('a fix that leaves the use in place fails validation and is dropped', () => {
    // The property §4.4.1 actually asks for, on the case where it should say no:
    // the detector fires on the post-image too, so it does not explain this patch
    // and the pattern is dropped rather than tuned.
    const result = validates(
      hunk([
        ['context', '  free(p);'],
        ['added', '  p = NULL;'],
      ]),
      'lifetime',
      { subject: 'p', operation: null },
    )

    expect(result.post).toBe(false)
  })

  test('a leak fix — a release added where there was none — is dropped', () => {
    // "Release then use" cannot describe a leak, so this correctly produces no
    // pattern. §4.4.1 says drop rather than tune, and the cost is recorded here
    // rather than hidden behind a weaker detector.
    const result = validates(
      hunk([
        ['context', '  int n = read(fd, buf, 8);'],
        ['added', '  free(buf);'],
      ]),
      'lifetime',
      { subject: 'buf', operation: 'free' },
    )

    expect(result.pre).toBe(false)
    expect(result.accepted).toBe(false)
  })
})

describe('detectShape on a whole function', () => {
  const COPY = [
    'int copy(char *dst, const char *src) {',
    '  strcpy(dst, src);',
    '  return 0;',
    '}',
  ]

  test('null-check works subject-free, which is what the sibling sweep needs', () => {
    // The variable a fix protected is a local name that appears nowhere else, so
    // a sweep can only ask "is a pointer parameter used with no null test". The
    // function's signature is where that comes from.
    expect(pointerParameters(COPY)).toEqual(['dst', 'src'])
    expect(detectShape(COPY, 'null-check', { operation: 'strcpy' })).not.toBeNull()
  })

  test('the same function with a guard fires no longer', () => {
    const guarded = [
      'int copy(char *dst, const char *src) {',
      '  if (dst == NULL) return -1;',
      '  if (src == NULL) return -1;',
      '  strcpy(dst, src);',
      '  return 0;',
      '}',
    ]
    expect(detectShape(guarded, 'null-check', {})).toBeNull()
  })

  test('a function with no call to the mined operation is not a sibling candidate', () => {
    // `siblings.ts` prefilters on this; asserted here so the prefilter's premise
    // is checked where the operation semantics live.
    const unrelated = ['int add(int a, int b) {', '  return a + b;', '}']
    expect(detectShape(unrelated, 'null-check', {})).toBeNull()
  })

  test('a non-pointer parameter of the same name polarity does not fire', () => {
    expect(pointerParameters(['int copy(int dst, int src) {', '  return dst + src;', '}'])).toEqual([])
  })
})

describe('small helpers', () => {
  test('null tests are collected across all three forms', () => {
    const tested = nullTestedIdentifiers([
      '  if (!a) return;',
      '  if (b == NULL) return;',
      '  if (NULL != c) return;',
    ])
    expect([...tested].sort()).toEqual(['a', 'b', 'c'])
  })

  test('a `*p = 0;` line is code, not a comment continuation', () => {
    expect(nullTestedIdentifiers(['*p = 0;'])).toEqual(new Set())
    // ...but a real block-comment continuation line is skipped, so a `NULL` in
    // prose cannot register as a null test.
    expect(nullTestedIdentifiers([' * if (x == NULL)'])).toEqual(new Set())
  })

  test('locks are read from acquires and releases separately', () => {
    expect(acquiresLock(['  mutex_lock(&m);'])).toBe(true)
    expect(acquiresLock(['  mutex_unlock(&m);'])).toBe(false)
    expect(releasesLock(['  mutex_unlock(&m);'])).toBe(true)
  })

  test('call arguments are collected for any callee but not for keywords', () => {
    expect([...callArguments(['  strcpy(dst, src);'])]).toEqual(['dst', 'src'])
    expect([...callArguments(['  if (a < b) return;'])]).toEqual([])
  })

  test('a nested parameter list is not split on its inner commas', () => {
    // `split(',')` would invent two parameters here and attribute the pointer to
    // `int`, which then never appears in the body and silently loses the pattern.
    expect(splitTopLevel('int a, void (*cb)(int, int), char *b')).toEqual([
      'int a',
      'void (*cb)(int, int)',
      'char *b',
    ])
    expect(pointerParameters(['int run(int a, void (*cb)(int, int), char *b) {', '  return 0;', '}']))
      .toEqual(['cb', 'b'])
  })

  test('signatureText stops at the body brace', () => {
    expect(signatureText(['int f(void) {', '  return 0;'])).toBe('int f(void)')
    expect(signatureText(['  return 0;'])).toBeNull()
  })
})
