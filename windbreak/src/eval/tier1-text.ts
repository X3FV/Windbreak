/**
 * The Tier 1 report as text.
 *
 * Two things it must not do. It must not print a number for a stage that did not
 * answer — `—` again, never `0` — and it must not let a single accuracy figure
 * stand in for the two-sided result. A stage that calls every function a bug has
 * perfect sensitivity and is worthless, so sensitivity, the false-alarm rate, and
 * the paired discrimination rate are printed on the same line and read together.
 */

import type { StageMetrics } from './confusion'
import type { Tier1Report } from './tier1'

const NIL = '—'

const rate = (value: number | null): string => (value === null ? NIL : value.toFixed(3))
const count = (value: number | null): string => (value === null ? NIL : String(value))

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const line = (values: readonly string[]): string =>
    values
      .map((value, index) =>
        index === 0 ? value.padEnd(widths[index]!) : value.padStart(widths[index]!),
      )
      .join('  ')
      .trimEnd()

  return [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)].join(
    '\n',
  )
}

const HEADERS = [
  'stage',
  'pairs',
  'tp',
  'fn',
  'fp',
  'tn',
  'unscored',
  'sensitivity',
  'false alarm',
  'precision',
  'discriminated',
  'fn/fa',
] as const

const row = (stage: StageMetrics): string[] => {
  if (stage.status === 'not-run') {
    return [stage.label, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL]
  }

  return [
    stage.label,
    count(stage.pairs),
    count(stage.truePositives),
    count(stage.falseNegatives),
    count(stage.falsePositives),
    count(stage.trueNegatives),
    count(stage.unscoreable),
    rate(stage.sensitivity),
    rate(stage.falseAlarmRate),
    rate(stage.precision),
    rate(stage.discrimination),
    // Undefined rather than infinite when there were no false alarms; the note
    // below the table says which.
    stage.biasRatio === null ? NIL : `${stage.biasRatio.toFixed(2)}x`,
  ]
}

export const renderTier1Report = (report: Tier1Report): string => {
  const out: string[] = []

  const heading = `${report.corpus} (corpus revision ${report.commitSha.slice(0, 12)})`
  out.push(report.description === null ? heading : `${heading} — ${report.description}`)
  out.push(
    `run ${report.runId}   ${report.pairs} pair(s)   ` +
      `${report.pairs * 2} function(s) judged`,
  )
  out.push('')
  out.push(table(HEADERS, report.stages.map(row)))

  for (const stage of report.stages) {
    if (stage.status === 'not-run') out.push(`${stage.label}: ${stage.reason}`)
  }

  const answered = report.stages.filter((stage) => stage.status === 'scored')
  if (answered.length > 0) {
    out.push('')
    out.push('answers:')
    for (const stage of answered) {
      const breakdown =
        stage.byDetail.length > 0
          ? stage.byDetail.map((entry) => `${entry.detail} ${entry.count}`).join('  ')
          : '(none)'
      out.push(`  ${stage.label}: ${breakdown}`)
      for (const note of stage.notes) out.push(`    note: ${note}`)
    }
  }

  if (report.cached.triageCandidates > 0 || report.cached.verificationCalls > 0) {
    out.push('')
    // The units are labelled because they differ: triage replays one answer per
    // candidate, verification one per role, so a bare pair of numbers invites
    // reading the second as twice the work it is.
    out.push(
      `cache:      ${report.cached.triageCandidates} triage candidate(s), ` +
        `${report.cached.verificationCalls} verification call(s)` +
        `${report.mixedCache ? ' — mixed with fresh calls, so this run is not ' +
          'comparable to a fully cached or fully fresh one' : ''}`,
    )
  }

  if (report.warnings.length > 0) {
    out.push('')
    out.push('warnings:')
    for (const warning of report.warnings) out.push(`  - ${warning}`)
  }

  out.push('')
  out.push('caveats:')
  for (const caveat of report.caveats) out.push(`  - ${caveat}`)

  return out.join('\n')
}
