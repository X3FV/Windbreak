/**
 * Narrative writeup (spec §13.2).
 *
 * The template is fixed and minimal on purpose (D23): no extra metadata, no
 * "confidence", no invented CVSS. Provenance lives in SQLite.
 *
 * §12.3's failure behaviour is enforced here — a writeup whose evidence tier is
 * missing is refused, because §2.1.5 forbids emitting a claim whose tier is
 * unstated. `renderWriteup` therefore validates the tier at runtime as well as
 * in the type, so a bad value from a database or a caller cannot slip through.
 */

import { EVIDENCE_TIERS } from './types'

import type { EvidenceTier, Finding } from './types'

export class MissingEvidenceTierError extends Error {
  constructor(findingId: string, received: unknown) {
    super(
      `Refusing to write a writeup for ${findingId}: the evidence tier is ` +
        `${JSON.stringify(received)}. Expected one of ${EVIDENCE_TIERS.join(', ')}. ` +
        'WindBreak never emits a claim whose evidence tier is unstated (spec §2.1.5, §12.3).',
    )
    this.name = 'MissingEvidenceTierError'
  }
}

const isEvidenceTier = (value: unknown): value is EvidenceTier =>
  typeof value === 'string' && (EVIDENCE_TIERS as readonly string[]).includes(value)

export interface RenderWriteupInput {
  finding: Finding
  targetLocation: string
  commitSha: string
  /** Harness instructions, when a harness was generated for this finding. */
  reproductionSteps?: readonly string[] | undefined
  /** Optional; omitted entirely when absent (D23 makes it optional). */
  cvss?: { vector: string; score: number; basis: string } | undefined
}

const CONTESTED_NOTE =
  '_Two independent models disagreed and the human adjudication queue has not ' +
  'resolved it. This finding is recorded, not asserted: treat it as leading to be ' +
  'checked, and see `windbreak review`._'

export const renderWriteup = (input: RenderWriteupInput): string => {
  const { finding } = input

  if (!isEvidenceTier(finding.evidenceTier)) {
    throw new MissingEvidenceTierError(finding.id, finding.evidenceTier)
  }

  const lines: string[] = []
  lines.push(`# ${finding.title}`)
  lines.push('')
  lines.push(`**Target:** ${input.targetLocation} @ ${input.commitSha}`)
  lines.push(
    `**Class:** ${finding.cwe ?? 'unclassified'} · **Evidence tier:** ${finding.evidenceTier}`,
  )
  lines.push('')

  if (finding.evidenceTier === 'contested') {
    lines.push(CONTESTED_NOTE, '')
  }

  lines.push('**Hypothesis:**')
  lines.push('')
  lines.push(finding.hypothesis.trim())
  lines.push('')

  lines.push('**Evidence:**')
  lines.push('')
  lines.push(finding.evidence.trimEnd())
  lines.push('')

  lines.push('**Reproduction steps:**')
  lines.push('')
  if (input.reproductionSteps && input.reproductionSteps.length > 0) {
    for (const step of input.reproductionSteps) lines.push(step)
  } else {
    lines.push('Not generated for this finding.')
  }
  lines.push('')

  lines.push('**Suggested fix:**')
  lines.push('')
  lines.push(finding.suggestedFix)
  lines.push('')

  if (input.cvss) {
    lines.push(
      `**CVSS estimate:** ${input.cvss.vector} · ${input.cvss.score} · ${input.cvss.basis}`,
    )
    lines.push('')
  }

  return lines.join('\n')
}
