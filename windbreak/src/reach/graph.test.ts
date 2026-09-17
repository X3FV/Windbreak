import { describe, expect, test } from 'bun:test'

import { buildCallGraph } from '../interproc'

import { findEntryPoints } from './entries'
import { analyzeReachability } from './graph'

import type { CallGraphDefinition, CallReference } from '../interproc'
import type { ReachabilityAnalysis } from './graph'

const definition = (
  name: string,
  startLine: number,
  endLine: number,
  filePath = 'src/main.c',
): CallGraphDefinition => ({ name, filePath, startLine, endLine })

const reference = (name: string, line: number, filePath = 'src/main.c'): CallReference => ({
  name,
  filePath,
  line,
})

const analyze = (
  definitions: readonly CallGraphDefinition[],
  references: readonly CallReference[],
): ReachabilityAnalysis => {
  const graph = buildCallGraph({ definitions, references })
  const entries = findEntryPoints(graph, definitions)
  return analyzeReachability({ graph, definitions, entries })
}

const klassOf = (analysis: ReachabilityAnalysis, name: string, filePath = 'src/main.c') =>
  analysis.recordFor(filePath, name)!.klass

describe('analyzeReachability', () => {
  test('a chain from main is attacker-input, with the distance and the path', () => {
    const analysis = analyze(
      [definition('main', 1, 10), definition('parse', 20, 30), definition('copy', 40, 50)],
      [reference('parse', 5), reference('copy', 25)],
    )

    expect(klassOf(analysis, 'main')).toBe('attacker-input')
    expect(klassOf(analysis, 'parse')).toBe('attacker-input')
    expect(klassOf(analysis, 'copy')).toBe('attacker-input')

    expect(analysis.recordFor('src/main.c', 'copy')!.distance).toBe(2)
    expect(analysis.pathFor('src/main.c', 'copy')).toEqual([
      { filePath: 'src/main.c', name: 'main', line: null },
      { filePath: 'src/main.c', name: 'parse', line: 5 },
      { filePath: 'src/main.c', name: 'copy', line: 25 },
    ])
  })

  test('the path is the shortest one, not the first one found', () => {
    // main -> a -> sink and main -> sink: the direct edge has to win, or the evidence
    // would name a call chain that is not the one an attacker takes.
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('a', 20, 30),
        definition('sink', 40, 50),
      ],
      [reference('a', 5), reference('sink', 6), reference('sink', 25)],
    )

    expect(analysis.recordFor('src/main.c', 'sink')!.distance).toBe(1)
    expect(analysis.pathFor('src/main.c', 'sink').map((step) => step.name)).toEqual([
      'main',
      'sink',
    ])
  })

  test('a fuzz entry point reaches its callees like any other entry', () => {
    const analysis = analyze(
      [definition('LLVMFuzzerTestOneInput', 1, 10), definition('parse', 20, 30)],
      [reference('parse', 5)],
    )

    expect(klassOf(analysis, 'parse')).toBe('attacker-input')
    expect(analysis.recordFor('src/main.c', 'parse')!.entry!.kind).toBe('fuzz-entry')
  })

  test('a site reached only from an unrooted function is exposed-api, not attacker-input', () => {
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('exposed', 20, 30),
        definition('deep', 40, 50),
      ],
      [reference('deep', 25)],
    )

    expect(klassOf(analysis, 'main')).toBe('attacker-input')
    expect(klassOf(analysis, 'exposed')).toBe('exposed-api')
    expect(klassOf(analysis, 'deep')).toBe('exposed-api')
    expect(analysis.recordFor('src/main.c', 'exposed')).toBeDefined()
    expect(analysis.recordFor('src/main.c', 'deep')!.entry!.name).toBe('exposed')
  })

  test('a caller loop no entry reaches is unreachable, and says so without excuses', () => {
    // Neither function has a caller-less start, so neither is an unrooted entry, and no
    // entry point reaches either. Every caller set is complete: this is the one case a
    // "no path" answer is a fact rather than a gap.
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('helper', 20, 30),
        definition('dead-a', 40, 50),
        definition('dead-b', 60, 70),
      ],
      [
        reference('helper', 5),
        reference('dead-b', 45),
        reference('dead-a', 65),
      ],
    )

    expect(klassOf(analysis, 'helper')).toBe('attacker-input')
    expect(klassOf(analysis, 'dead-a')).toBe('unreachable')
    expect(klassOf(analysis, 'dead-b')).toBe('unreachable')

    const record = analysis.recordFor('src/main.c', 'dead-a')!
    expect(record.entry).toBeNull()
    expect(record.distance).toBeNull()
    expect(record.incomplete).toEqual([])
    expect(analysis.pathFor('src/main.c', 'dead-a')).toEqual([])
  })

  test('a dropped call site makes the callee and everything below it unknown', () => {
    // The call to `orphan` at line 35 sits outside every indexed callable, so somebody
    // calls it and the graph cannot say who. `orphan` may be reachable, and so may
    // everything it calls — that is absence of evidence, not evidence of absence.
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('helper', 20, 30),
        definition('orphan', 40, 50),
        definition('tail', 60, 70),
      ],
      [reference('helper', 5), reference('orphan', 35), reference('tail', 45)],
    )

    expect(klassOf(analysis, 'helper')).toBe('attacker-input')
    expect(klassOf(analysis, 'orphan')).toBe('unknown')
    expect(klassOf(analysis, 'tail')).toBe('unknown')

    expect(analysis.recordFor('src/main.c', 'orphan')!.incomplete[0]).toMatch(
      /outside every indexed callable/,
    )
    expect(analysis.recordFor('src/main.c', 'tail')!.incomplete[0]).toMatch(
      /whose own caller set is incomplete/,
    )
    expect(analysis.coverage.taintRoots).toBe(1)
  })

  test('an ambiguous name taints every definition that shares it', () => {
    const analysis = analyze(
      [
        definition('caller', 1, 10, 'src/x.c'),
        definition('clear', 20, 30, 'src/a.c'),
        definition('clear', 20, 30, 'src/b.c'),
      ],
      [reference('clear', 5, 'src/x.c')],
    )

    expect(klassOf(analysis, 'clear', 'src/a.c')).toBe('unknown')
    expect(klassOf(analysis, 'clear', 'src/b.c')).toBe('unknown')
    expect(analysis.recordFor('src/a.c', 'clear')!.incomplete[0]).toMatch(/several files define/)
  })

  test('a qualified call reference taints the definition whose name is its tail', () => {
    // A C++ target writes `Q::f`, which this name-only index cannot resolve, so no edge is
    // made and `droppedCallersOf` never sees it. Here `main` calls `Q::g`; `g` also happens to
    // have a resolved caller in a dead cycle. Without the tail check `g` looks called, no entry
    // reaches it, and every caller set looks complete — a false `unreachable` on a real zlib
    // scan (§20.39.8).
    const analysis = analyze(
      [
        definition('main', 1, 10, 'src/main.c'),
        definition('k', 20, 30, 'src/main.c'),
        definition('k2', 40, 50, 'src/main.c'),
        definition('g', 1, 10, 'src/q.c'),
        definition('f', 20, 30, 'src/q.c'),
      ],
      [
        reference('Q::g', 5, 'src/main.c'),
        reference('k2', 25, 'src/main.c'),
        reference('g', 27, 'src/main.c'),
        reference('k', 45, 'src/main.c'),
        reference('f', 5, 'src/q.c'),
      ],
    )

    // `k` and `k2` are a dead cycle: called, no entry reaches them, caller sets complete.
    expect(klassOf(analysis, 'k', 'src/main.c')).toBe('unreachable')
    expect(klassOf(analysis, 'g', 'src/q.c')).toBe('unknown')
    // Downstream is tainted too: an unresolved caller of `g` makes everything `g` calls
    // possibly reachable, for the same reason a dropped call site does.
    expect(klassOf(analysis, 'f', 'src/q.c')).toBe('unknown')
    expect(analysis.recordFor('src/q.c', 'g')!.incomplete[0]).toMatch(
      /class or namespace qualifier/,
    )
    expect(analysis.recordFor('src/q.c', 'f')!.incomplete[0]).toMatch(
      /whose own caller set is incomplete/,
    )
    expect(analysis.coverage.qualifiedCallees).toBe(1)
  })

  test('a qualified call whose tail matches nothing leaves the answer alone', () => {
    // The negative control for the test above: the tail has to name a definition. An
    // unresolvable `Q::other` is an ordinary unresolved callee, not a reason to stop calling
    // anything unreachable — otherwise one unresolvable name in a target would taint the lot.
    const analysis = analyze(
      [
        definition('main', 1, 10, 'src/main.c'),
        definition('k', 20, 30, 'src/main.c'),
        definition('k2', 40, 60, 'src/main.c'),
        definition('g', 1, 10, 'src/q.c'),
      ],
      [
        reference('Q::other', 5, 'src/main.c'),
        reference('k2', 25, 'src/main.c'),
        reference('k', 45, 'src/main.c'),
        reference('g', 55, 'src/main.c'),
      ],
    )

    expect(klassOf(analysis, 'g', 'src/q.c')).toBe('unreachable')
    expect(analysis.coverage.qualifiedCallees).toBe(1)
  })

  test('a real path settles the question a qualified call site would leave open', () => {
    // Same shape as above, except `main` also calls `g` by its bare name. A path exists, so
    // the answer is attacker-input and the tail taint never applies.
    const analysis = analyze(
      [
        definition('main', 1, 10, 'src/main.c'),
        definition('g', 1, 10, 'src/q.c'),
      ],
      [reference('Q::g', 5, 'src/main.c'), reference('g', 6, 'src/main.c')],
    )

    expect(klassOf(analysis, 'g', 'src/q.c')).toBe('attacker-input')
  })

  test('a real path settles the question a dropped call site would leave open', () => {
    // `sink` is called by `helper`, which `main` calls. The unattributed call site naming
    // it is a fact about the graph, not about `sink`: a path exists, so the answer is
    // attacker-input and the taint never applies.
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('helper', 20, 30),
        definition('sink', 40, 50),
      ],
      [reference('helper', 5), reference('sink', 25), reference('sink', 35)],
    )

    expect(klassOf(analysis, 'sink')).toBe('attacker-input')
  })

  test('a target with no entry point at all is unknown, never unreachable', () => {
    // Two functions calling each other, with nothing else in the model: no `main`, no
    // fuzz entry, no reader, and no caller-less function. An empty inventory is a
    // statement about the parse, so nothing may be called unreachable on the strength of it.
    const analysis = analyze(
      [definition('a', 1, 10), definition('b', 20, 30)],
      [reference('b', 5), reference('a', 25)],
    )

    expect(analysis.coverage.noEntries).toBe(true)
    expect(klassOf(analysis, 'a')).toBe('unknown')
    expect(klassOf(analysis, 'b')).toBe('unknown')
    expect(analysis.recordFor('src/main.c', 'a')!.incomplete[0]).toMatch(/no entry point/)
  })

  test('the four classes account for every definition', () => {
    const analysis = analyze(
      [
        definition('main', 1, 10),
        definition('parse', 20, 30),
        definition('exposed', 40, 50),
        definition('orphan', 60, 70),
        definition('dead-a', 80, 90),
        definition('dead-b', 100, 110),
      ],
      [
        reference('parse', 5),
        reference('orphan', 55),
        reference('dead-b', 85),
        reference('dead-a', 105),
      ],
    )

    const { counts } = analysis
    expect(counts.definitions).toBe(6)
    expect(counts.attackerInput + counts.exposedApi + counts.unreachable + counts.unknown).toBe(6)
    expect(counts.attackerInput).toBe(2)
    expect(counts.exposedApi).toBe(1)
    expect(counts.unreachable).toBe(2)
    expect(counts.unknown).toBe(1)
  })
})

describe('site', () => {
  test('a line classifies as the function that contains it', () => {
    const analysis = analyze(
      [definition('main', 1, 10), definition('parse', 20, 30)],
      [reference('parse', 5)],
    )

    const site = analysis.site('src/main.c', 25)
    expect(site.klass).toBe('attacker-input')
    expect(site.definition!.name).toBe('parse')
    expect(site.distance).toBe(1)
  })

  test('a line no callable covers is unknown, not unreachable', () => {
    const analysis = analyze([definition('main', 1, 10)], [])

    const site = analysis.site('src/main.c', 500)
    expect(site.definition).toBeNull()
    expect(site.klass).toBe('unknown')
    expect(site.incomplete[0]).toMatch(/not inside any indexed callable/)
  })

  test('selects the innermost enclosing function, like the call graph does', () => {
    const analysis = analyze(
      [definition('main', 1, 40), definition('inner', 10, 20)],
      [],
    )

    expect(analysis.site('src/main.c', 15).definition!.name).toBe('inner')
    expect(analysis.site('src/main.c', 30).definition!.name).toBe('main')
  })
})

describe('determinism', () => {
  test('two analyses of the same model agree record for record', () => {
    const definitions = [
      definition('main', 1, 10),
      definition('parse', 20, 30),
      definition('copy', 40, 50),
      definition('orphan', 60, 70),
    ]
    const references = [reference('parse', 5), reference('copy', 25), reference('orphan', 55)]

    const first = analyze(definitions, references)
    const second = analyze(definitions, references)

    expect(second.records).toEqual(first.records)
    expect(second.counts).toEqual(first.counts)
    expect(second.coverage).toEqual(first.coverage)
  })

  test('a node two entries reach is credited to the one that appears first', () => {
    // Both `aaa` and `zzz` are unrooted entries calling `sink`. The inventory order is the
    // model's, so the credited entry is stable — a finding whose evidence names a
    // different caller each run is not reviewable.
    const analysis = analyze(
      [definition('aaa', 1, 10), definition('zzz', 20, 30), definition('sink', 40, 50)],
      [reference('sink', 5), reference('sink', 25)],
    )

    expect(analysis.recordFor('src/main.c', 'sink')!.entry!.name).toBe('aaa')
    expect(analysis.pathFor('src/main.c', 'sink').map((step) => step.name)).toEqual([
      'aaa',
      'sink',
    ])
  })
})
