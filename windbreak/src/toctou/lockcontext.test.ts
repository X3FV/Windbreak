import { describe, expect, test } from 'bun:test'

import { buildBindings } from './alias'
import { extractEvents } from './events'
import { callerLockVerdict, covered, lockIntervals } from './lockcontext'

import type { CallEdge } from './callgraph'
import type { LockInterval } from './lockcontext'

const source = (...lines: string[]): string[] => lines

const intervalsFor = (lines: readonly string[], lock: string): LockInterval[] =>
  lockIntervals(extractEvents(lines), lock, buildBindings(lines), lines.length)

describe('lockIntervals', () => {
  test('records the span from the acquire to the release', () => {
    const intervals = intervalsFor(
      source('mutex_lock(&s->mu);', 'value = s->count;', 'mutex_unlock(&s->mu);'),
      's->mu',
    )

    expect(intervals).toEqual([{ from: 1, to: 3 }])
  })

  test('an unmatched acquire holds to the end of the function', () => {
    // The conservative reading: a use after it is treated as protected, which
    // under-reports rather than reporting a leak as a race.
    const intervals = intervalsFor(source('mutex_lock(&s->mu);', 'value = s->count;'), 's->mu')

    expect(intervals).toEqual([{ from: 1, to: 2 }])
  })

  test('a lock taken through a local is the same lock', () => {
    const intervals = intervalsFor(
      source('struct mutex *m = &s->mu;', 'mutex_lock(m);', 'mutex_unlock(m);'),
      's->mu',
    )

    expect(intervals).toEqual([{ from: 2, to: 3 }])
  })

  test('an unrelated lock produces no interval', () => {
    expect(intervalsFor(source('mutex_lock(&other->mu);', 'x = 1;'), 's->mu')).toEqual([])
  })
})

describe('covered', () => {
  test('includes both ends of an interval', () => {
    expect(covered(2, [{ from: 2, to: 5 }])).toBe(true)
    expect(covered(5, [{ from: 2, to: 5 }])).toBe(true)
  })

  test('a line outside every interval is not covered', () => {
    expect(covered(1, [{ from: 2, to: 5 }])).toBe(false)
    expect(covered(6, [{ from: 2, to: 5 }])).toBe(false)
  })
})

describe('callerLockVerdict', () => {
  const edge = (fromFunction: string, line: number): CallEdge => ({
    fromFile: 'src/main.c',
    fromFunction,
    toFile: 'src/helper.c',
    toFunction: 'read_count',
    line,
  })

  const table = (
    entries: Record<string, readonly LockInterval[] | null>,
  ): ((filePath: string, name: string) => readonly LockInterval[] | null) => {
    return (filePath, name) => entries[`${filePath}:${name}`] ?? null
  }

  test('every caller holding the lock is the helper-reached-only-locked reading', () => {
    const verdict = callerLockVerdict({
      callers: [edge('caller', 3), edge('other', 7)],
      complete: true,
      intervalsOf: table({
        'src/main.c:caller': [{ from: 2, to: 4 }],
        'src/main.c:other': [{ from: 6, to: 8 }],
      }),
    })

    expect(verdict).toEqual({
      callers: 2,
      lockedCallers: 2,
      complete: true,
      allCallersLocked: true,
    })
  })

  test('one caller without the lock is enough to keep the verdict off', () => {
    const verdict = callerLockVerdict({
      callers: [edge('caller', 3), edge('other', 7)],
      complete: true,
      intervalsOf: table({ 'src/main.c:caller': [{ from: 2, to: 4 }] }),
    })

    expect(verdict.lockedCallers).toBe(1)
    expect(verdict.allCallersLocked).toBe(false)
  })

  test('a caller whose body could not be read counts as not holding it', () => {
    // An unknown treated as protection would be a suppression nobody can see.
    const verdict = callerLockVerdict({
      callers: [edge('caller', 3)],
      complete: true,
      intervalsOf: table({ 'src/main.c:caller': null }),
    })

    expect(verdict.lockedCallers).toBe(0)
    expect(verdict.allCallersLocked).toBe(false)
  })

  test('an incomplete caller set can never produce allCallersLocked', () => {
    const verdict = callerLockVerdict({
      callers: [edge('caller', 3)],
      complete: false,
      intervalsOf: table({ 'src/main.c:caller': [{ from: 2, to: 4 }] }),
    })

    expect(verdict.lockedCallers).toBe(1)
    expect(verdict.complete).toBe(false)
    expect(verdict.allCallersLocked).toBe(false)
  })

  test('no callers is not all callers', () => {
    // A function nothing recorded calls may be an entry point, which is the opposite
    // conclusion from "every caller holds the lock".
    const verdict = callerLockVerdict({ callers: [], complete: true, intervalsOf: table({}) })

    expect(verdict).toEqual({
      callers: 0,
      lockedCallers: 0,
      complete: true,
      allCallersLocked: false,
    })
  })

  test('a second call site from a locked caller is judged on its own line', () => {
    const verdict = callerLockVerdict({
      callers: [edge('caller', 3), edge('caller', 9)],
      complete: true,
      intervalsOf: table({ 'src/main.c:caller': [{ from: 2, to: 4 }] }),
    })

    expect(verdict.lockedCallers).toBe(1)
    expect(verdict.allCallersLocked).toBe(false)
  })
})
