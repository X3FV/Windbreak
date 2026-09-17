/**
 * The rule-tier report as text.
 *
 * Three things it must not do, all of them §18 failures:
 *
 * - it must not print a number for a measurement that did not happen, so a stage
 *   that never ran shows `—` and its own reason rather than zeroes;
 * - it must not let one figure stand for the two-sided result, so sensitivity,
 *   the false-alarm rate and `discriminated` are printed together — a rule set
 *   that fires on everything has perfect sensitivity and is worthless;
 * - it must not present the aggregate without the per-rule table, because the
 *   only actionable output here is *which rules fired at all*. A rule with no
 *   fires anywhere is a rule that does not earn its place, and that fact is
 *   invisible in a percentage.
 */

import { count, NIL, rate, table } from './table'

import type { RuleTierReport } from './rule-tier'

/** Enough to see the shape of the noise without printing hundreds of rows. */
export const FALSE_ALARM_SAMPLE = 10

const HEADERS = [
  'instrument',
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

const row = (report: RuleTierReport): string[] => {
  const metrics = report.metrics

  if (metrics.status === 'not-run') {
    return [metrics.label, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL]
  }

  return [
    metrics.label,
    count(metrics.pairs),
    count(metrics.truePositives),
    count(metrics.falseNegatives),
    count(metrics.falsePositives),
    count(metrics.trueNegatives),
    count(metrics.unscoreable),
    rate(metrics.sensitivity),
    rate(metrics.falseAlarmRate),
    rate(metrics.precision),
    rate(metrics.discrimination),
    metrics.biasRatio === null ? NIL : `${metrics.biasRatio.toFixed(2)}x`,
  ]
}

export const renderRuleTierReport = (report: RuleTierReport): string => {
  const out: string[] = []
  const metrics = report.metrics

  out.push(
    `${report.corpus} — ${report.pairs} pair(s), ${report.pairs * 2} half/halves scored ` +
      'against the committed rule set',
  )
  out.push('')
  out.push(table(HEADERS, [row(report)]))

  if (metrics.status === 'not-run') {
    out.push('')
    out.push(`not run: ${metrics.reason}`)
  } else {
    for (const note of metrics.notes) out.push(`note: ${note}`)
  }

  out.push('')
  if (report.rules.length === 0) {
    out.push('rules that fired: none — no rule in the set matched any half of any pair')
  } else {
    out.push('rules that fired:')
    out.push(
      table(
        ['rule', 'vulnerable', 'patched'],
        report.rules.map((entry) => [
          entry.ruleId,
          String(entry.vulnerable),
          String(entry.patched),
        ]),
      ),
    )
    out.push(
      `  (of ${report.pairs} pair(s): \`vulnerable\` is the half known to contain the defect, ` +
        '`patched` the half known to be fixed)',
    )
  }

  // The evidence behind `discrimination`, printed in full when it is small
  // enough to read. A rate nobody can check is a rate nobody should quote.
  const caught = report.outcomes.filter((outcome) => outcome.verdict === 'discriminated')
  out.push('')
  out.push(`caught (fired on the vulnerable half, not on the fixed one): ${caught.length}`)
  for (const outcome of caught) {
    out.push(`  ${outcome.pairId}`)
    out.push(`    ${outcome.filePath ?? '(no path)'}  [${outcome.vulnerableRules.join(', ')}]`)
  }

  const falseAlarms = report.outcomes.filter((outcome) => outcome.verdict === 'false-alarm')
  out.push('')
  out.push(`false alarms (fired on the fixed half as well): ${falseAlarms.length}`)
  for (const outcome of falseAlarms.slice(0, FALSE_ALARM_SAMPLE)) {
    out.push(`  ${outcome.pairId}`)
    out.push(`    ${outcome.filePath ?? '(no path)'}  [${outcome.vulnerableRules.join(', ')}]`)
  }
  if (falseAlarms.length > FALSE_ALARM_SAMPLE) {
    out.push(`  (and ${falseAlarms.length - FALSE_ALARM_SAMPLE} more; --json lists all)`)
  }

  const noFire = report.outcomes.filter((outcome) => outcome.verdict === 'no-fire').length
  const undecided = report.outcomes.filter((outcome) => outcome.verdict === 'undecided').length
  out.push('')
  out.push(`no rule fired at all: ${noFire}`)
  if (undecided > 0) out.push(`no verdict for either half: ${undecided}`)

  if (report.engineNotes.length > 0) {
    out.push('')
    out.push('engine notes:')
    for (const note of report.engineNotes) out.push(`  - ${note}`)
  }

  out.push('')
  out.push('caveats:')
  out.push(
    '  - the corpus is every CVE an upstream project named in a commit message, so it spans ' +
      'the whole weakness space. The committed rules test seven shapes; a null dereference or ' +
      'an authorization error is real ground truth here and is reachable by none of them, so ' +
      'low recall partly means "these fixes were not that shape"',
  )
  out.push(
    '  - each pair is one function at the fix commit\'s parent and the same function at the ' +
      'fix, so the patched half differs from it in code and not merely in comments',
  )
  out.push(
    '  - this measures the rule set alone. It says nothing about recon, the call graph, ' +
      'triage, verification or reachability, none of which ran',
  )

  return out.join('\n')
}
