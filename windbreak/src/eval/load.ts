/**
 * Reading an `eval` input, and deciding which tier it is (spec §11, §7.3).
 *
 * §7.3 gives `eval` one positional argument and one command for two
 * measurements. The two corpora have almost nothing in common — a fixture list
 * is repo snapshots scored by path and commit, a pair set is functions scored by
 * label — so an input has to say which it is.
 *
 * It says so with a required `kind`, rather than by being sniffed for the shape
 * of its keys. Sniffing would make a typo (`"fixture"` for `"fixtures"`) resolve
 * to the wrong tier and fail with a message about the tier the author was not
 * writing. A `kind` that is present and unrecognized is refused by name, which
 * is the whole reason it is required on the new format.
 *
 * The fixture list predates the discriminator, so an absent `kind` still means
 * repo snapshots. That is a compatibility rule with a floor: any value that *is*
 * present must be one this build reads.
 */

import fs from 'fs'

import { parseFixtureSet } from './manifest'
import { PAIR_SET_KIND, parsePairSet } from './pairs'

import type { FixtureSet, PairSet } from './types'

export class EvalInputReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalInputReadError'
  }
}

export type EvalInput =
  | { kind: 'repo-snapshots'; path: string; fixtureSet: FixtureSet }
  | { kind: 'function-pairs'; path: string; pairSet: PairSet }

/** Read and parse an input file. A missing or malformed file is refused by name. */
export const readJsonFile = (filePath: string): unknown => {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new EvalInputReadError(
      `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new EvalInputReadError(
      `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const loadEvalInput = (filePath: string): EvalInput => {
  const parsed = readJsonFile(filePath)

  const kind =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).kind
      : undefined

  if (kind === undefined) {
    return { kind: 'repo-snapshots', path: filePath, fixtureSet: parseFixtureSet(parsed) }
  }

  if (kind === PAIR_SET_KIND) {
    return { kind: 'function-pairs', path: filePath, pairSet: parsePairSet(parsed) }
  }

  throw new EvalInputReadError(
    `${filePath} declares kind "${String(kind)}", which this build does not read. ` +
      `Accepted: "${PAIR_SET_KIND}", or no kind at all for the repo-snapshot fixture list ` +
      '(spec §11).',
  )
}
