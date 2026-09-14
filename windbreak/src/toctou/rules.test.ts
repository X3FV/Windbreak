import { describe, expect, test } from 'bun:test'

import { parseHunks } from '../patchmine/diff'
import {
  addsLock,
  atomicityRuleId,
  guardedResources,
  mergeRules,
  mineRulesFromHunks,
} from './rules'

import type { Hunk } from '../patchmine/types'

const SHA = 'a'.repeat(40)

/** One hunk, parsed from a real patch body rather than hand-built. */
const hunksFrom = (patchBody: string, filePath = 'src/a.c'): Hunk[] =>
  parseHunks(
    `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${patchBody}`,
  )

const only = (patchBody: string, filePath?: string): Hunk => {
  const hunks = hunksFrom(patchBody, filePath)
  expect(hunks).toHaveLength(1)
  return hunks[0]!
}

describe('addsLock', () => {
  test('true only when the patch itself added an acquire or a release', () => {
    const addedAcquire = only(
      '@@ -1,3 +1,4 @@\n int f(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n }',
    )
    expect(addsLock(addedAcquire)).toBe(true)

    // The *release* counts too: a hunk that adds the `unlock` is adding the end of a
    // critical section it is establishing.
    const addedRelease = only(
      '@@ -1,3 +1,4 @@\n int f(struct s *s) {\n   mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n }',
    )
    expect(addsLock(addedRelease)).toBe(true)
  })

  test('locking that is only context is not an anchor', () => {
    // Pairing resources from a hunk whose locking already existed would mine a rule
    // from behaviour the patch did not change.
    const contextOnly = only(
      '@@ -1,4 +1,4 @@\n int f(struct s *s) {\n   mutex_lock(&s->mu);\n-  s->count = 0;\n+  s->count = 1;\n   mutex_unlock(&s->mu);\n }',
    )
    expect(addsLock(contextOnly)).toBe(false)
  })
})

describe('guardedResources', () => {
  test('a member lock pairs with the fields of its own base', () => {
    const guarded = guardedResources(
      only(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
    )

    expect(guarded).toEqual({ resources: ['s->count'], lock: 's->mu' })
  })

  test('a member lock does not pair with a different object', () => {
    // `s->mu` guards `s`'s fields, not `t`'s — and the miner emits nothing rather than
    // a rule about `t->count`, which no sweep could check.
    const guarded = guardedResources(
      only(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s, struct t *t) {\n+  mutex_lock(&s->mu);\n   t->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
    )

    expect(guarded).toBeNull()
  })

  test('a bare lock pairs with what is accessed between it and its release', () => {
    const guarded = guardedResources(
      only(
        '@@ -1,4 +1,6 @@\n void f(void) {\n+  spin_lock(&g_mu);\n   g_table[0].refs++;\n+  spin_unlock(&g_mu);\n   return;\n }',
      ),
    )

    expect(guarded).toEqual({ resources: ['g_table[0].refs'], lock: 'g_mu' })
  })

  test('the lock is not a resource it guards', () => {
    const guarded = guardedResources(
      only(
        '@@ -1,3 +1,5 @@\n int f(struct s *s) {\n+  mutex_lock(&s->mu);\n+  mutex_unlock(&s->mu);\n }',
      ),
    )

    expect(guarded).toBeNull()
  })

  test('a bare identifier is never a resource', () => {
    // `count` as a resource would match every local of that name in the target, which
    // is a rule about nothing.
    const guarded = guardedResources(
      only(
        '@@ -1,4 +1,6 @@\n void f(void) {\n+  spin_lock(&g_mu);\n   count++;\n+  spin_unlock(&g_mu);\n   return;\n }',
      ),
    )

    expect(guarded).toBeNull()
  })

  test('an added release finds the acquire above it', () => {
    // The region is the critical section, not the tail of it.
    const guarded = guardedResources(
      only(
        '@@ -1,4 +1,4 @@\n int f(struct s *s) {\n   mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n }',
      ),
    )

    expect(guarded).toEqual({ resources: ['s->count'], lock: 's->mu' })
  })
})

describe('mineRulesFromHunks', () => {
  test('mines a rule with its provenance and coverage', () => {
    const result = mineRulesFromHunks({
      hunks: hunksFrom(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
      originPatchSha: SHA,
    })

    expect(result.hunksAddingLock).toBe(1)
    expect(result.hunksWithoutResource).toBe(0)
    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]).toEqual({
      id: atomicityRuleId('s->count', 's->mu'),
      resource: 's->count',
      lock: 's->mu',
      originPatchSha: SHA,
      originFile: 'src/a.c',
      occurrences: 1,
    })
  })

  test('counts a lock-adding hunk that yielded no resource as a mining gap', () => {
    // A history where no hunk added locking and one where locking was added but no
    // resource could be identified are different statements; only the second is a gap.
    const result = mineRulesFromHunks({
      hunks: hunksFrom(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s, struct t *t) {\n+  mutex_lock(&s->mu);\n   t->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
      originPatchSha: SHA,
    })

    expect(result.rules).toEqual([])
    expect(result.hunksAddingLock).toBe(1)
    expect(result.hunksWithoutResource).toBe(1)
  })

  test('a hunk that added no locking contributes nothing at all', () => {
    const result = mineRulesFromHunks({
      hunks: hunksFrom([
        '@@ -1,8 +1,8 @@',
        ' int a(void) {',
        '   return 0;',
        ' }',
        '-int b(void) { return 1; }',
        '+int b(void) { return 2; }',
        '-',
        '+ ',
        ' int c(void) {',
        '   return 3;',
        ' }',
      ].join('\n')),
      originPatchSha: SHA,
    })

    expect(result.rules).toEqual([])
    expect(result.hunksAddingLock).toBe(0)
    expect(result.hunksWithoutResource).toBe(0)
  })

  test('two hunks establishing one pairing is one rule seen twice', () => {
    const result = mineRulesFromHunks({
      hunks: hunksFrom(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }\n@@ -20,4 +22,6 @@\n int dec(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count--;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
      originPatchSha: SHA,
    })

    expect(result.rules).toHaveLength(1)
    expect(result.rules[0]!.occurrences).toBe(2)
  })
})

describe('mergeRules', () => {
  test('sums occurrences across commits and orders by them', () => {
    const one = mineRulesFromHunks({
      hunks: hunksFrom(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
      ),
      originPatchSha: SHA,
    }).rules

    const two = mineRulesFromHunks({
      hunks: hunksFrom(
        '@@ -1,4 +1,6 @@\n int inc(struct s *s) {\n+  mutex_lock(&s->mu);\n   s->count++;\n+  mutex_unlock(&s->mu);\n   return 0;\n }',
        'src/b.c',
      ),
      originPatchSha: 'b'.repeat(40),
    }).rules

    const merged = mergeRules([one, two])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.occurrences).toBe(2)
    // The first group's provenance is kept; occurrences carry the multiplicity.
    expect(merged[0]!.originFile).toBe('src/a.c')
  })

  test('merging nothing yields nothing', () => {
    expect(mergeRules([])).toEqual([])
    expect(mergeRules([[], []])).toEqual([])
  })
})

describe('atomicityRuleId', () => {
  test('keys on the pairing and nothing else', () => {
    expect(atomicityRuleId('s->count', 's->mu')).toBe(atomicityRuleId('s->count', 's->mu'))
    expect(atomicityRuleId('s->count', 's->mu')).not.toBe(atomicityRuleId('s->refs', 's->mu'))
    expect(atomicityRuleId('s->count', 's->mu')).not.toBe(atomicityRuleId('s->count', 'g_mu'))
  })
})
