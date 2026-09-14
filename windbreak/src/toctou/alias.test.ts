import { describe, expect, test } from 'bun:test'

import {
  aliases,
  anyGuards,
  baseOf,
  buildBindings,
  guardedBy,
  hasFieldPath,
  normalizeExpression,
  stripAddress,
} from './alias'

describe('normalizeExpression', () => {
  test('strips casts, repeatedly', () => {
    expect(normalizeExpression('(void *)p')).toBe('p')
    expect(normalizeExpression('(struct task_struct *)(char *)task')).toBe('task')
    expect(normalizeExpression('(unsigned long)&g_count')).toBe('g_count')
  })

  test('unwraps outer parentheses but not a balanced sub-expression', () => {
    expect(normalizeExpression('((p))')).toBe('p')
    // `(a) + (b)` is not *wrapped* in parentheses; unwrapping it would produce
    // `a) + (b`, which is not an expression at all.
    expect(normalizeExpression('(a) + (b)')).toBe('(a) + (b)')
  })

  test('canonicalizes member-operator whitespace and drops a leading address-of', () => {
    // `s  ->  mu` and `s->mu` are the same field. Treating them as two keys would
    // make the alias relation miss the lock it exists to follow.
    expect(normalizeExpression('s  ->  mu')).toBe('s->mu')
    expect(normalizeExpression('s . a')).toBe('s.a')
    expect(normalizeExpression('&&x')).toBe('x')
  })

  test('is idempotent', () => {
    // `aliases` normalizes both sides and `resolve` normalizes what it returns, so
    // a non-idempotent version would make equality depend on how many times each
    // side had been through it.
    for (const input of ['(void *)&s->mu', '((p))', 'a[i]', 't -> inner -> v']) {
      const once = normalizeExpression(input)
      expect(normalizeExpression(once)).toBe(once)
    }
  })
})

describe('baseOf and hasFieldPath', () => {
  test('the base is the root identifier', () => {
    expect(baseOf('s->count')).toBe('s')
    expect(baseOf('&s->mu')).toBe('s')
    expect(baseOf('s.a.b')).toBe('s')
    expect(baseOf('arr[i]')).toBe('arr')
    expect(baseOf('t->inner->v')).toBe('t')
    expect(baseOf('count')).toBe('count')
  })

  test('only a member or subscript path is a field', () => {
    expect(hasFieldPath('s->count')).toBe(true)
    expect(hasFieldPath('s.a')).toBe(true)
    expect(hasFieldPath('arr[i]')).toBe(true)
    // A bare identifier as a resource would match every local of that name, which
    // is a rule about nothing.
    expect(hasFieldPath('count')).toBe(false)
  })
})

describe('buildBindings', () => {
  test('a local bound to an object aliases that object', () => {
    const bindings = buildBindings([
      'void f(struct s *s) {',
      '  struct mutex *m = &s->mu;',
      '  mutex_lock(m);',
      '}',
    ])

    expect(bindings.resolve('m')).toBe('s->mu')
    expect(aliases('m', '&s->mu', bindings)).toBe(true)
    expect(bindings.sourceOf('m')).toBe('s->mu')
  })

  test('follows a chain to a fixed point', () => {
    const bindings = buildBindings(['  a = &g;', '  b = a;', '}'])
    expect(bindings.resolve('b')).toBe('g')
    expect(bindings.sourceOf('b')).toBe('g')
  })

  test('does not treat a constant as naming an object', () => {
    // `x = 0` read as a binding would make every zeroed local alias every other.
    const bindings = buildBindings(['  x = 0;', '  y = NULL;', '  z = a + b;', '  w = malloc(4);'])
    expect(bindings.assignments.size).toBe(0)
    expect(aliases('x', 'y', bindings)).toBe(false)
  })

  test('a bare expression resolves to itself and has no source', () => {
    const bindings = buildBindings(['}'])
    expect(bindings.resolve('s->count')).toBe('s->count')
    expect(bindings.sourceOf('s->count')).toBeNull()
  })

  test('unresolvable expressions do not alias', () => {
    const bindings = buildBindings(['}'])
    // Deliberately different: must-alias by expression identity only. Pointers that
    // are equal at runtime but written differently are a known recall cost.
    expect(aliases('a->x', 'b->x', bindings)).toBe(false)
    expect(aliases('', 'a->x', bindings)).toBe(false)
    expect(aliases('a->x', 'a->x', bindings)).toBe(true)
  })
})

describe('guardedBy', () => {
  test('is containment, not equality', () => {
    // A lock on `m` protects `m.field`. Equality would mean a lock never protects
    // anything but itself, and the lock-scope FSM could never see a correct region.
    expect(guardedBy('m', 'm')).toBe(true)
    expect(guardedBy('m', 'm->field')).toBe(true)
    expect(guardedBy('m', 'm.field')).toBe(true)
    expect(guardedBy('m', 'm[i]')).toBe(true)
  })

  test('does not cover a different object or a prefix sibling', () => {
    expect(guardedBy('m', 'n->field')).toBe(false)
    // `m2->field` is not covered by `m` — a plain `startsWith` without the path
    // separator would wrongly say it is.
    expect(guardedBy('m', 'm2->field')).toBe(false)
  })

  test('ignores a leading address-of on either side', () => {
    expect(guardedBy('&s->mu', 's->count')).toBe(false)
    expect(guardedBy('&s', 's->count')).toBe(true)
  })

  test('anyGuards is true when one of the held locks covers the access', () => {
    expect(anyGuards(['a', 's'], 's->count')).toBe(true)
    expect(anyGuards(['a', 'b'], 's->count')).toBe(false)
    expect(anyGuards([], 's->count')).toBe(false)
  })
})

describe('stripAddress', () => {
  test('removes any number of leading address-of operators', () => {
    expect(stripAddress('&x')).toBe('x')
    expect(stripAddress('&&x')).toBe('x')
    expect(stripAddress('x')).toBe('x')
  })
})
