import { describe, expect, test } from 'bun:test'

import { buildBindings } from './alias'
import { extractEvents } from './events'
import { interprocFindings, summarizeCallee } from './interproc'

import type { CalleePathSummary } from './interproc'

const source = (...lines: string[]): string[] => lines

const summaryOf = (lines: readonly string[], startLine = 1): CalleePathSummary =>
  summarizeCallee({ lines, startLine })

/** The caller's side of a pair, with its checks and bindings already extracted. */
const callerInput = (lines: readonly string[], startLine = 1) => ({
  filePath: 'src/load.c',
  functionName: 'load',
  startLine,
  lines,
  events: extractEvents(lines),
  bindings: buildBindings(lines),
})

const findingsFor = (input: {
  callerLines: readonly string[]
  calleeLines: readonly string[]
  callLine: number
  args?: string
}): ReturnType<typeof interprocFindings> =>
  interprocFindings({
    caller: callerInput(input.callerLines),
    calls: [{ toFile: 'src/config.c', toFunction: 'load_config', line: input.callLine }],
    summaryOf: (_filePath, name) =>
      name === 'load_config' ? summaryOf(input.calleeLines) : null,
  })

describe('summarizeCallee', () => {
  test('records an ordered, sparse parameter list', () => {
    const summary = summaryOf(
      source('int f(int flags, const char *path) {', '  return 0;', '}'),
    )

    // Ordered rather than a set: arguments are matched by position.
    expect(summary.params).toEqual(['flags', 'path'])
  })

  test('an unnamed parameter occupies its slot without shifting the others', () => {
    const summary = summaryOf(source('int f(int, const char *path) {', '  return 0;', '}'))

    expect(summary.params).toEqual([null, 'path'])
  })

  test('`void` alone is an empty list, not a parameter named void', () => {
    expect(summaryOf(source('int f(void) {', '  return 0;', '}')).params).toEqual([])
  })

  test('a path-resolving call on a parameter is a use, at its file line', () => {
    const summary = summaryOf(
      source('int load(const char *path) {', '  FILE *f = fopen(path, "r");', '  return 0;', '}'),
      10,
    )

    expect(summary.uses).toEqual([{ index: 0, fileLine: 11, callee: 'fopen' }])
  })

  test('a path check on a parameter is a check', () => {
    const summary = summaryOf(
      source('int load(const char *path) {', '  if (access(path, R_OK)) return -1;', '  return 0;', '}'),
    )

    expect(summary.checks).toEqual([{ index: 0, fileLine: 2 }])
  })

  test('a call on a non-parameter expression is left out rather than guessed at', () => {
    const summary = summaryOf(
      source('int load(const char *path) {', '  return fopen(path + ".tmp", "r") != NULL;', '}'),
    )

    expect(summary.uses).toEqual([])
  })

  test('a call that merely reads the name is not a re-resolution', () => {
    const summary = summaryOf(
      source('int load(const char *path) {', '  return strlen(path);', '}'),
    )

    expect(summary.uses).toEqual([])
  })
})

describe('interprocFindings', () => {
  const CALLER = source(
    'int load(const char *cfg) {',
    '  if (access(cfg, R_OK) != 0) return -1;',
    '  return load_config(cfg);',
    '}',
  )

  const CALLEE = source(
    'int load_config(const char *path) {',
    '  FILE *f = fopen(path, "r");',
    '  return f != NULL;',
    '}',
  )

  test('a check in the caller and a re-resolution in the callee is one pair', () => {
    const findings = findingsFor({ callerLines: CALLER, calleeLines: CALLEE, callLine: 3 })

    expect(findings).toEqual([
      {
        checkLine: 2,
        callLine: 3,
        resource: 'cfg',
        other: {
          filePath: 'src/config.c',
          functionName: 'load_config',
          fileLine: 2,
          callee: 'fopen',
        },
      },
    ])
  })

  test('the callee re-checking the same parameter first means there is no pair', () => {
    // The callee's own check governs its use, so nothing the caller did is operative.
    const callee = source(
      'int load_config(const char *path) {',
      '  if (access(path, R_OK) != 0) return -1;',
      '  FILE *f = fopen(path, "r");',
      '  return f != NULL;',
      '}',
    )

    expect(findingsFor({ callerLines: CALLER, calleeLines: callee, callLine: 3 })).toEqual([])
  })

  test('a check on a different expression is not the pair', () => {
    const caller = source(
      'int load(const char *cfg, const char *other) {',
      '  if (access(other, R_OK) != 0) return -1;',
      '  return load_config(cfg);',
      '}',
    )

    expect(findingsFor({ callerLines: caller, calleeLines: CALLEE, callLine: 3 })).toEqual([])
  })

  test('a check after the call does not count', () => {
    const caller = source(
      'int load(const char *cfg) {',
      '  int result = load_config(cfg);',
      '  if (access(cfg, R_OK) != 0) return -1;',
      '  return result;',
      '}',
    )

    expect(findingsFor({ callerLines: caller, calleeLines: CALLEE, callLine: 2 })).toEqual([])
  })

  test('a check on the same line is left to the intraprocedural FSM', () => {
    // Documented trade: ordering within one line is not modelled here, so pairing it
    // would be a guess. `fsm.ts` orders events within a line and does not guess.
    const caller = source(
      'int load(const char *cfg) {',
      '  if (access(cfg, R_OK) == 0 && (load_config(cfg)) == 0) return 0;',
      '  return -1;',
      '}',
    )

    expect(findingsFor({ callerLines: caller, calleeLines: CALLEE, callLine: 2 })).toEqual([])
  })

  test('the argument position is matched against the parameter position', () => {
    // The two-parameter case is what ordered params exist for: `path` is index 1.
    const callee = source(
      'int load_config(int flags, const char *path) {',
      '  FILE *f = fopen(path, "r");',
      '  return f != NULL;',
      '}',
    )
    const caller = source(
      'int load(const char *cfg) {',
      '  if (access(cfg, R_OK) != 0) return -1;',
      '  return load_config(0, cfg);',
      '}',
    )

    const findings = findingsFor({ callerLines: caller, calleeLines: callee, callLine: 3 })

    expect(findings).toHaveLength(1)
    expect(findings[0]!.resource).toBe('cfg')
  })

  test('a local copy inside the callee still resolves to the parameter', () => {
    const callee = source(
      'int load_config(const char *path) {',
      '  const char *p = path;',
      '  FILE *f = fopen(p, "r");',
      '  return f != NULL;',
      '}',
    )

    expect(findingsFor({ callerLines: CALLER, calleeLines: callee, callLine: 3 })).toHaveLength(1)
  })

  test('a caller with no path check produces nothing', () => {
    const caller = source(
      'int load(const char *cfg) {',
      '  return load_config(cfg);',
      '}',
    )

    expect(findingsFor({ callerLines: caller, calleeLines: CALLEE, callLine: 2 })).toEqual([])
  })
})
