/**
 * The function-level corpus format (spec §11.1, D10).
 *
 * §11.1 uses a corpus of **vulnerable/patched function pairs** to measure the
 * model stages in isolation, and it is emphatic about what that measurement is
 * *not*: PrimeVul-style data can speak to how triage and verification judge a
 * function, and cannot speak to repo-scale detection. The format below therefore
 * carries no line numbers, no call graph, and no engine rule — because the
 * corpus has none, and inventing them would make a model-only measurement look
 * like a pipeline measurement.
 *
 * A pair is two halves of the same function: the vulnerable version (a real bug)
 * and the patched version (not a bug). Scoring them separately is what makes the
 * measurement two-sided — a stage that calls everything a bug scores perfectly
 * on the vulnerable half and is caught by the patched one.
 *
 * Three checks exist because the failure each prevents is invisible in the
 * output:
 *
 * - **Unique pair ids.** The denominator is a count of pairs, so a duplicate
 *   ends up weighted twice.
 * - **The halves must differ.** A pair whose two versions are byte-identical —
 *   a bad join in whatever produced the corpus — cannot measure discrimination
 *   at all: every such pair contributes either a true positive *and* a false
 *   positive or neither, depending on nothing in particular.
 * - **Neither half may be empty.** An empty function is not a bug and not a
 *   fix; it is a missing field, and the stage would be asked to judge nothing.
 */

import { z } from 'zod'

import type { FunctionPair, PairSet } from './types'

/** The discriminator that tells `eval` this file is a corpus, not a fixture list. */
export const PAIR_SET_KIND = 'function-pairs'

/** The corpus format this build reads. An unknown version is refused. */
export const PAIR_SET_VERSION = 1

const SHA = /^[0-9a-f]{7,40}$/i
const CWE = /^CWE-\d{1,5}$/
const CVE = /^CVE-\d{4}-\d{4,7}$/

const pairSchema = z
  .object({
    id: z.string().min(1).max(160),
    project: z.string().min(1).max(120),
    cwe: z.string().regex(CWE, 'must look like CWE-120').nullish(),
    cve: z.string().regex(CVE, 'must look like CVE-2024-1086').nullish(),
    commitSha: z.string().regex(SHA, 'must be a hex commit sha').nullish(),
    fixCommit: z.string().regex(SHA, 'must be a hex commit sha').nullish(),
    vulnerable: z.string().min(1, 'the vulnerable half cannot be empty'),
    patched: z.string().min(1, 'the patched half cannot be empty'),
    filePath: z.string().min(1).nullish(),
    note: z.string().max(500).nullish(),
  })
  .strict()

const setSchema = z
  .object({
    kind: z.literal(PAIR_SET_KIND),
    version: z.number().int().positive(),
    description: z.string().max(500).nullish(),
    corpus: z.string().min(1).max(200),
    pairs: z.array(pairSchema).min(1, 'a corpus with no pairs scores nothing'),
  })
  .strict()

export class InvalidPairSetError extends Error {
  constructor(message: string) {
    super(
      `Refusing this corpus: ${message}. A corpus that does not validate is refused ` +
        'rather than repaired, because every rate computed from it would be wrong in a ' +
        'way the report could not show (spec §11.1, §18).',
    )
    this.name = 'InvalidPairSetError'
  }
}

/**
 * Where the half came from.
 *
 * The corpus rarely records a path, so one is synthesized from the project and
 * pair id. It is deliberately not a plausible source path: the prompt's file
 * line should not imply the function was read out of a checkout, because it was
 * not.
 */
const syntheticPath = (pair: { project: string; id: string }): string =>
  `${pair.project}/${pair.id}.c`

export const parsePairSet = (input: unknown): PairSet => {
  const parsed = setSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidPairSetError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    )
  }

  const set = parsed.data

  if (set.version !== PAIR_SET_VERSION) {
    throw new InvalidPairSetError(
      `version ${set.version} is not the version this build reads (${PAIR_SET_VERSION})`,
    )
  }

  const seen = new Set<string>()
  for (const pair of set.pairs) {
    if (seen.has(pair.id)) {
      throw new InvalidPairSetError(`pair id "${pair.id}" appears twice`)
    }
    seen.add(pair.id)

    if (pair.vulnerable === pair.patched) {
      throw new InvalidPairSetError(
        `pair "${pair.id}" has byte-identical halves, so it cannot measure whether a ` +
          'stage distinguishes the bug from its fix',
      )
    }

    if (pair.fixCommit != null && pair.commitSha != null && pair.fixCommit === pair.commitSha) {
      throw new InvalidPairSetError(
        `pair "${pair.id}" fixes at ${pair.fixCommit}, which is the vulnerable commit ` +
          'it is pinned to. One of the two is wrong',
      )
    }
  }

  return {
    kind: PAIR_SET_KIND,
    version: set.version,
    description: set.description ?? null,
    corpus: set.corpus,
    pairs: set.pairs.map(
      (pair): FunctionPair => ({
        id: pair.id,
        project: pair.project,
        cwe: pair.cwe ?? null,
        cve: pair.cve ?? null,
        commitSha: pair.commitSha ?? null,
        fixCommit: pair.fixCommit ?? null,
        vulnerable: pair.vulnerable,
        patched: pair.patched,
        filePath: pair.filePath ?? null,
        note: pair.note ?? null,
      }),
    ),
  }
}

/** A synthetic path for a half that records none. Used by the orchestrator. */
export const halfPath = (pair: FunctionPair): string => pair.filePath ?? syntheticPath(pair)

/** Which half of a pair a candidate represents. */
export type PairHalf = 'vulnerable' | 'patched'

export const PAIR_HALVES: readonly PairHalf[] = ['vulnerable', 'patched']
