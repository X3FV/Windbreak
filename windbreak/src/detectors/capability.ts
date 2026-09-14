/**
 * Which languages each detector has tables for (spec §20.24.5).
 *
 * The C-shaped stages used to share one constant — `DETECTOR_LANGUAGES = ['c', 'cpp']`
 * in `patchmine/shapes.ts` — so a language was swept by **everything or nothing**. That
 * is true only while every detector's tables are C's, and it stops being true the first
 * time one of them gains a language the others do not have. A Python
 * `subprocess`-injection shape is a detector the shape family could grow while the
 * check-to-use FSMs and the POSIX signal table stay C's, and a single shared constant
 * has no way to say that. Both of the things it *can* say are wrong:
 *
 * - adding `python` to the constant runs the C tables (`free`, `->`, `mutex_lock`) over
 *   Python callables, producing **false positives** — the worse failure, because a
 *   candidate costs a verification call and a reviewer's attention;
 * - leaving it out keeps those callables uncounted, so a mostly-Python repo reads as
 *   clean rather than as unswept.
 *
 * So the unit is a detector, not a stage. Each one declares the languages whose tables
 * it actually has, and a sweep asks for the **union** of the detectors it is about to
 * run. A new language is then one entry on one list, and the coverage report shows the
 * result as *partial* rather than rounding it to swept or unswept.
 *
 * ## What this module can and cannot do
 *
 * It makes the claim *sayable* and makes partial coverage *visible*. It cannot check
 * that a language added to a detector's list actually has tables — that is the work,
 * and getting it wrong reproduces the false-positive regime `patchmine/shapes.ts`
 * describes. The list is a declaration, and this module is where declarations are made
 * once instead of in every stage.
 *
 * The three detectors are the three *table owners*, not the three stages: the shape
 * classifiers live in `patchmine/shapes.ts`, the check-to-use event tables in
 * `toctou/events.ts`, and the async-signal-safety table in `toctou/handlers.ts`. A stage
 * that runs several detectors asks for all of their languages.
 */

/** Every detector with language-specific tables, in report order. */
export const DETECTOR_IDS = ['patch-shape', 'toctou', 'signal-handler'] as const

export type DetectorId = (typeof DETECTOR_IDS)[number]

export interface DetectorCapability {
  id: DetectorId
  /** One phrase, for stage warnings and the coverage line. */
  label: string
  /**
   * Languages whose tables this detector has.
   *
   * Empty is legal and means the detector never runs — useful for a detector that is
   * being retired without deleting its record, and *not* the same as absent.
   */
  languages: readonly string[]
}

export const DETECTOR_CAPABILITIES: readonly DetectorCapability[] = [
  {
    id: 'patch-shape',
    label: 'patch-mined shape detectors',
    // The five §4.4.1 shapes, whose classifiers are the C idiom tables in
    // `patchmine/shapes.ts` (`NULL_TESTS`, `RELEASE_FN`, `LOCK_ACQUIRE`, `->`).
    languages: ['c', 'cpp'],
  },
  {
    id: 'toctou',
    label: 'check-to-use FSMs and mined atomicity rules',
    // The event classification tables in `toctou/events.ts` and the four FSMs.
    languages: ['c', 'cpp'],
  },
  {
    id: 'signal-handler',
    label: 'signal-handler machine (CWE-364)',
    // POSIX async-signal-safety (`toctou/handlers.ts`). Unlike the other two, this
    // one is C by *definition* rather than by table: the weakness is a property of
    // signal handlers, so it has no equivalent in a language without them.
    languages: ['c', 'cpp'],
  },
]

const BY_ID = new Map<DetectorId, DetectorCapability>(
  DETECTOR_CAPABILITIES.map((capability) => [capability.id, capability]),
)

export const detectorCapability = (id: DetectorId): DetectorCapability => {
  const capability = BY_ID.get(id)
  // Unreachable while `DetectorId` is what it is. Thrown rather than returned as
  // undefined so that widening the type without adding a row fails loudly here
  // instead of silently sweeping nothing.
  if (capability === undefined) throw new Error(`unknown detector: ${id}`)
  return capability
}

export const ALL_DETECTOR_IDS: readonly DetectorId[] = DETECTOR_CAPABILITIES.map(
  (capability) => capability.id,
)

/**
 * Languages a set of detectors can run on — the union, sorted.
 *
 * The union is the right question for a *sweep*: it walks every language any of its
 * detectors covers, and the per-detector tables decide what it actually finds there.
 * The intersection would silently skip a language one detector could have read.
 */
export const languagesForDetectors = (
  ids: readonly DetectorId[],
  capabilities: readonly DetectorCapability[] = DETECTOR_CAPABILITIES,
): string[] => {
  const languages = new Set<string>()
  for (const capability of capabilities) {
    if (!ids.includes(capability.id)) continue
    for (const language of capability.languages) languages.add(language)
  }
  return [...languages].sort()
}

/**
 * `language IN ('c', 'cpp')` for the given detectors.
 *
 * Generated so the language lists have one definition rather than one per query, and
 * `0 = 1` rather than an empty `IN ()` when the set covers nothing: a detector set with
 * no languages must sweep nothing, and `IN ()` is a SQL syntax error that would fail the
 * whole stage instead of returning no rows.
 */
export const languageFilterSql = (
  ids: readonly DetectorId[],
  capabilities: readonly DetectorCapability[] = DETECTOR_CAPABILITIES,
): string => {
  const languages = languagesForDetectors(ids, capabilities)
  if (languages.length === 0) return '0 = 1'
  return `language IN (${languages.map((language) => `'${language}'`).join(', ')})`
}

/** Detectors that have tables for a language, in `DETECTOR_IDS` order. */
export const detectorsForLanguage = (
  language: string,
  capabilities: readonly DetectorCapability[] = DETECTOR_CAPABILITIES,
): DetectorId[] =>
  capabilities
    .filter((capability) => capability.languages.includes(language))
    .map((capability) => capability.id)

/** Detectors a language is *not* covered by — what the coverage report names. */
export const detectorsMissingFor = (
  language: string,
  capabilities: readonly DetectorCapability[] = DETECTOR_CAPABILITIES,
): DetectorId[] =>
  capabilities
    .filter((capability) => !capability.languages.includes(language))
    .map((capability) => capability.id)
