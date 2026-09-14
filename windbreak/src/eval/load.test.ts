import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, test } from 'bun:test'

import { EvalInputReadError, loadEvalInput } from './load'

const written: string[] = []

const write = (contents: string): string => {
  const file = path.join(os.tmpdir(), `wb-eval-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, contents)
  written.push(file)
  return file
}

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { force: true })
})

const fixtureList = JSON.stringify({
  version: 1,
  fixtures: [
    { id: 'fx-1', project: 'p', commitSha: 'abc1234', bugs: [], note: null },
  ],
})

const pairSet = JSON.stringify({
  kind: 'function-pairs',
  version: 1,
  corpus: 'c',
  pairs: [{ id: 'p-1', project: 'p', vulnerable: 'a', patched: 'b' }],
})

describe('loadEvalInput', () => {
  test('treats an absent kind as the repo-snapshot fixture list', () => {
    // The fixture list predates the discriminator, so absence has to keep
    // meaning what it meant before.
    const input = loadEvalInput(write(fixtureList))
    expect(input.kind).toBe('repo-snapshots')
  })

  test('routes a function-pair corpus to tier 1', () => {
    const input = loadEvalInput(write(pairSet))
    expect(input.kind).toBe('function-pairs')
  })

  test('refuses an unrecognized kind by name, rather than guessing a tier', () => {
    // Sniffing the keys instead would resolve this to the fixture list and fail
    // with an error about the tier the author was not writing.
    expect(() => loadEvalInput(write(JSON.stringify({ kind: 'primevul', version: 1 })))).toThrow(
      /declares kind "primevul", which this build does not read/,
    )
  })

  test('refuses a missing file and invalid JSON by name', () => {
    expect(() => loadEvalInput('/nonexistent/corpus.json')).toThrow(EvalInputReadError)
    expect(() => loadEvalInput(write('{ not json'))).toThrow(/not valid JSON/)
  })

  test('a malformed corpus still fails through its own validator', () => {
    const missingHalf = JSON.stringify({
      kind: 'function-pairs',
      version: 1,
      corpus: 'c',
      pairs: [{ id: 'p-1', project: 'p', vulnerable: 'a', patched: 'a' }],
    })
    expect(() => loadEvalInput(write(missingHalf))).toThrow(/byte-identical halves/)
  })
})
