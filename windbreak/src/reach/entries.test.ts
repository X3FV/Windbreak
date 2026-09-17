import { describe, expect, test } from 'bun:test'

import { buildCallGraph } from '../interproc'

import { ATTACKER_INPUT_KINDS, findEntryPoints, INPUT_SOURCE_CALLS } from './entries'

import type { CallGraphDefinition, CallReference } from '../interproc'

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

const entriesOf = (
  definitions: readonly CallGraphDefinition[],
  references: readonly CallReference[],
) => findEntryPoints(buildCallGraph({ definitions, references }), definitions)

describe('findEntryPoints', () => {
  test('the fuzzer’s own entry point is an entry, with the strongest reason', () => {
    const entries = entriesOf(
      [definition('LLVMFuzzerTestOneInput', 1, 10)],
      [reference('parse', 5)],
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('fuzz-entry')
    expect(entries[0]!.reason).toMatch(/arbitrary bytes/)
  })

  test('main is an entry, and the reason names what actually arrives there', () => {
    const entries = entriesOf([definition('main', 1, 10)], [])

    expect(entries[0]!.kind).toBe('main')
    expect(entries[0]!.reason).toMatch(/argv/)
  })

  test('a function that reads input is an entry even though libc has no definition', () => {
    // `recv` is not a definition anywhere in the target, so there is no edge to find.
    // The inventory reads call *references*, which is the only place the name survives.
    const entries = entriesOf(
      [definition('serve', 1, 10), definition('handle', 20, 30)],
      [reference('recv', 5), reference('handle', 6)],
    )

    const serve = entries.find((entry) => entry.name === 'serve')!
    expect(serve.kind).toBe('input-source')
    expect(serve.sources).toEqual(['recv'])
    expect(serve.reason).toMatch(/socket/)
  })

  test('an input-source kind names every reader it found, sorted', () => {
    const entries = entriesOf(
      [definition('serve', 1, 10)],
      [reference('getenv', 3), reference('read', 5)],
    )

    expect(entries[0]!.sources).toEqual(['getenv', 'read'])
  })

  test('a function nothing calls is unrooted, and the reason admits what it cannot tell', () => {
    const entries = entriesOf([definition('exposed', 1, 10)], [])

    expect(entries[0]!.kind).toBe('unrooted')
    expect(entries[0]!.reason).toMatch(/cannot tell which/)
  })

  test('a called function that is neither main, a fuzz entry, nor a reader is not an entry', () => {
    const entries = entriesOf(
      [definition('main', 1, 10), definition('helper', 20, 30)],
      [reference('helper', 5)],
    )

    expect(entries.map((entry) => entry.name)).toEqual(['main'])
  })

  test('a dropped call site keeps a function out of the inventory', () => {
    // The call to `helper` sits outside every indexed callable, so it resolves to nobody
    // — but somebody *does* call `helper`. Calling that unrooted would launder an
    // unresolvable call into an `exposed-api` conclusion, which the report treats as
    // reachable. It is left out instead, and `graph.ts` marks it unknown.
    const entries = entriesOf(
      [definition('main', 1, 10), definition('helper', 20, 30)],
      [reference('helper', 15)],
    )

    expect(entries.map((entry) => entry.name)).toEqual(['main'])
  })

  test('an ambiguous call site keeps every definition of that name out too', () => {
    const definitions = [
      definition('caller', 1, 10, 'src/x.c'),
      definition('clear', 20, 30, 'src/a.c'),
      definition('clear', 20, 30, 'src/b.c'),
    ]
    const entries = entriesOf(definitions, [reference('clear', 5, 'src/x.c')])

    // `x.c` calls `clear` and defines no `clear` of its own, so both are candidates for
    // the edge and neither may be treated as reached from outside. `caller` is unrooted.
    expect(entries.map((entry) => entry.filePath)).toEqual(['src/x.c'])
    expect(entries[0]!.kind).toBe('unrooted')
  })

  test('the strongest kind wins, and the sources are still recorded', () => {
    const entries = entriesOf(
      [definition('main', 1, 10)],
      [reference('recv', 5)],
    )

    expect(entries[0]!.kind).toBe('main')
    expect(entries[0]!.sources).toEqual(['recv'])
  })

  test('the inventory follows the definition order it was given, so two runs agree', () => {
    const entries = entriesOf(
      [
        definition('alpha', 1, 10),
        definition('main', 20, 30),
        definition('zeta', 40, 50, 'src/b.c'),
      ],
      [reference('alpha', 25)],
    )

    // `alpha` is called by `main`, so it is not an entry. The other two are unrooted, in
    // the order the model supplied rather than sorted — the path a finding reports is
    // reconstructed from this order, and a sort would make it depend on the target's
    // file names.
    expect(entries.map((entry) => entry.name)).toEqual(['main', 'zeta'])
  })

  test('the attacker-input kinds exclude unrooted by construction', () => {
    // The distinction the module exists to draw: if `unrooted` counted as attacker input,
    // every exported function in a library would report as an attack surface and the
    // classification would stop meaning anything.
    expect(ATTACKER_INPUT_KINDS).not.toContain('unrooted')
    expect(ATTACKER_INPUT_KINDS).toContain('fuzz-entry')
    expect(ATTACKER_INPUT_KINDS).toContain('main')
    expect(ATTACKER_INPUT_KINDS).toContain('input-source')
  })

  test('every name in the reader table carries a reason a reader can disagree with', () => {
    for (const [name, reason] of Object.entries(INPUT_SOURCE_CALLS)) {
      expect(name.length).toBeGreaterThan(0)
      expect(reason.length).toBeGreaterThan(0)
    }
  })
})
