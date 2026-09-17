/**
 * SARIF 2.1.0 output (spec §13.1).
 *
 * One run per target, one result per surviving finding, `ruleId` = the
 * candidate's source or its synthesized `pattern_id`, and `properties` carrying
 * the evidence tier and the models used. Standard output means
 * OSV-Scanner/Buttercup-adjacent tooling interops for free, which is the whole
 * reason to emit SARIF rather than a bespoke JSON.
 *
 * The document is built as plain JSON so it is byte-stable for a given input —
 * §2.1.3 is a determinism gate, and a re-run must not shuffle a report.
 */

import { humanClassFor } from './findings'

import type { Finding } from './types'

export const SARIF_SCHEMA_URI =
  'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json'

/** SARIF levels are constrained; everything WindBreak emits is a defect. */
const LEVEL_BY_TIER: Record<Finding['evidenceTier'], 'error' | 'warning' | 'note'> = {
  'human-reproduced': 'error',
  // A dynamically confirmed finding is one whose defect *demonstrably manifested*,
  // so it is an error like the human tier. SARIF's three levels cannot express the
  // difference between a machine reproduction and a person's, and the tier is
  // carried verbatim in `properties` — which is where a consumer should read it.
  'dynamically-confirmed': 'error',
  'statically-verified': 'warning',
  // SARIF has no "contested", so it maps to `note`: the lowest-emphasis level is
  // the honest one for a claim two models disagree about.
  contested: 'note',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Only the fields §13.1 requires; a missing or unexpected field is dropped. */
const ruleForFinding = (finding: Finding): Record<string, unknown> => {
  const ruleId = finding.patternId ?? finding.source
  return {
    id: ruleId,
    name: finding.patternId ?? finding.source,
    shortDescription: { text: humanClassFor(finding.cwe, finding.patternId) },
    ...(finding.cwe
      ? { properties: { tags: [finding.cwe.toLowerCase()], cwe: finding.cwe } }
      : {}),
  }
}

/** Deduplicate rules, since many findings share one pattern. */
const collectRules = (findings: readonly Finding[]): Record<string, unknown>[] => {
  const byId = new Map<string, Record<string, unknown>>()
  for (const finding of findings) {
    const rule = ruleForFinding(finding)
    const id = String(rule.id)
    if (!byId.has(id)) byId.set(id, rule)
  }
  return [...byId.values()]
}

const physicalLocation = (
  finding: Finding,
): Record<string, unknown> | null => {
  if (!finding.filePath || finding.startLine === null) return null

  return {
    artifactLocation: { uri: finding.filePath, uriBaseId: 'SRCROOT' },
    region: {
      startLine: finding.startLine,
      ...(finding.endLine !== null ? { endLine: finding.endLine } : {}),
    },
  }
}

const resultForFinding = (finding: Finding): Record<string, unknown> => {
  const location = physicalLocation(finding)

  return {
    ruleId: finding.patternId ?? finding.source,
    level: LEVEL_BY_TIER[finding.evidenceTier],
    message: { text: finding.title },
    // §13.1's `properties` contract. `evidenceTier` is mandatory here: a report
    // that cannot state its tier must not be produced at all (§2.1.5).
    properties: {
      evidenceTier: finding.evidenceTier,
      modelsUsed: finding.modelsUsed.map((model) => ({
        role: model.role,
        modelId: model.modelId,
        provider: model.provider,
      })),
      findingId: finding.id,
      candidateId: finding.candidateId,
      source: finding.source,
      ...(finding.patternId ? { patternId: finding.patternId } : {}),
      ...(finding.cwe ? { cwe: finding.cwe } : {}),
      ...(finding.rediscovery ? { rediscovery: finding.rediscovery } : {}),
      // Present only when true, matching `rediscovery`: a SARIF consumer filters for
      // provenance it cares about, and an always-present `false` is noise.
      ...(finding.modelProposed ? { modelProposed: true } : {}),
    },
    ...(location ? { locations: [{ physicalLocation: location }] } : {}),
  }
}

export interface BuildSarifInput {
  /** Absolute path of the target checkout, used as SARIF's `%SRCROOT%`. */
  targetLocation: string
  commitSha: string
  runId: string
  findings: readonly Finding[]
  /** WindBreak's version, for the tool driver record. */
  version: string
  informationUri?: string
}

export const buildSarifDocument = (input: BuildSarifInput): Record<string, unknown> => {
  const baseUri = input.targetLocation.endsWith('/')
    ? input.targetLocation
    : `${input.targetLocation}/`

  return {
    $schema: SARIF_SCHEMA_URI,
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'WindBreak',
            ...(input.informationUri ? { informationUri: input.informationUri } : {}),
            version: input.version,
            rules: collectRules(input.findings),
          },
        },
        originalUriBaseIds: {
          SRCROOT: { uri: `file://${baseUri}` },
        },
        // Recorded so a reader can tell which target revision this describes
        // without consulting the state database.
        properties: {
          target: { location: input.targetLocation, commitSha: input.commitSha },
          runId: input.runId,
        },
        results: input.findings.map(resultForFinding),
        // The stage that produced these results always completed: reporting
        // refuses to emit a partial document, and says so instead.
        invocations: [{ executionSuccessful: true }],
      },
    ],
  }
}

export const serializeSarif = (document: unknown, indent = 2): string =>
  `${JSON.stringify(document, null, indent)}\n`

/** Exposed for callers that need to assert the shape they are handing out. */
export const isSarifDocument = (value: unknown): boolean =>
  isRecord(value) &&
  value.version === '2.1.0' &&
  Array.isArray(value.runs) &&
  value.runs.length > 0
