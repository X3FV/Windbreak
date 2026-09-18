/**
 * The shape-tier report as text (§20.43).
 *
 * It shares §20.40's three prohibitions — no number for a measurement that did not
 * happen, no single figure standing for a two-sided result, no aggregate without
 * the per-shape table — and adds a fourth that is specific to this instrument:
 *
 * **it must say which number to read.** §20.40 established `discrimination` as the
 * headline for a *detector*, and this tier's subject was rejected as a detector on
 * an argument. But a candidate generator is not judged like a detector: §2.4's
 * funnel assumes the raw layer is mostly noise and exists to be filtered, so the
 * question is how many real defects it puts in front of the filter at all. Printing
 * one row with no indication of which column answers which question is how a
 * 0.75-containment instrument gets dismissed for a 0.02 discrimination figure.
 */

import { count, NIL, rate, table } from './table'

import type { ShapeTierReport } from './shape-tier'

/** Enough to read the shape of the noise without printing hundreds of rows. */
export const FALSE_ALARM_SAMPLE = 10

const HEADERS = [
  'instrument',
  'pairs',
  'tp',
  'fn',
  'fp',
  'tn',
  'unscored',
  'containment',
  'false alarm',
  'precision',
  'discriminated',
] as const

const row = (report: ShapeTierReport): string[] => {
  const metrics = report.metrics

  if (metrics.status === 'not-run') {
    return [metrics.label, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL]
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
  ]
}

export const renderShapeTierReport = (report: ShapeTierReport): string => {
  const out: string[] = []
  const metrics = report.metrics

  out.push(
    `${report.corpus} — ${report.pairs} pair(s), ${report.pairs * 2} half/halves swept ` +
      'subject-free by §4.4.1\'s shape detectors, with no mined pattern',
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
  out.push('which column answers which question:')
  out.push(
    '  `containment` (sensitivity) is TP/(TP+FN): of the functions that really do contain a',
  )
  out.push(
    '    defect, how many did the sweep put in front of a filter. This is the number that',
  )
  out.push(
    '    matters for a candidate generator, which is what §2.4\'s funnel consumes.',
  )
  out.push(
    '  `discriminated` is the share of pairs where the sweep fired on the vulnerable half AND',
  )
  out.push(
    '    cleared the fixed one. It is the number that matters for a *detector*, it is what §20.40',
  )
  out.push(
    '    reports for the rule set, and a generator is not required to be good at it.',
  )

  out.push('')
  out.push(`sites emitted: ${report.emitted.vulnerable} on vulnerable halves, ${report.emitted.patched} on fixed ones`)
  out.push(
    '  (a fixed half is a function with no known defect, so its share of that volume is the',
  )
  out.push('   candidate load a triage stage would have to absorb)')

  out.push('')
  out.push(
    table(
      ['shape', 'vulnerable', 'patched'],
      report.shapes.map((entry) => [
        entry.shape,
        String(entry.vulnerable),
        String(entry.patched),
      ]),
    ),
  )

  if (report.inertShapes.length > 0) {
    out.push('')
    out.push(`shapes that fired nowhere: ${report.inertShapes.join(', ')}`)
    out.push(
      '  `guard` and `lock` are not weak here, they are *structurally inert*: both require a',
    )
    out.push(
      '  mined operation to know what to look for, and this tier runs with no pattern at all.',
    )
    out.push(
      '  Their zero is a design boundary, not a measurement — which is the recall question for',
    )
    out.push('  a checkout with no fix history of its own.')
  }

  const caught = report.outcomes.filter((outcome) => outcome.verdict === 'discriminated')
  out.push('')
  out.push(`caught (fired on the vulnerable half, not on the fixed one): ${caught.length}`)
  for (const outcome of caught) {
    out.push(`  ${outcome.pairId}`)
    out.push(`    ${outcome.filePath ?? '(no path)'}  [${outcome.vulnerableShapes.join(', ')}]`)
  }

  const falseAlarms = report.outcomes.filter((outcome) => outcome.verdict === 'false-alarm')
  out.push('')
  out.push(`false alarms (fired on the fixed half as well): ${falseAlarms.length}`)
  for (const outcome of falseAlarms.slice(0, FALSE_ALARM_SAMPLE)) {
    out.push(
      `  ${outcome.pairId}  [vulnerable: ${outcome.vulnerableShapes.join(', ') || '—'}; ` +
        `fixed: ${outcome.patchedShapes.join(', ') || '—'}]`,
    )
  }
  if (falseAlarms.length > FALSE_ALARM_SAMPLE) {
    out.push(`  (and ${falseAlarms.length - FALSE_ALARM_SAMPLE} more; --json lists all)`)
  }

  const noFire = report.outcomes.filter((outcome) => outcome.verdict === 'no-fire').length
  const undecided = report.outcomes.filter((outcome) => outcome.verdict === 'undecided').length
  out.push('')
  out.push(`no shape fired at all: ${noFire}`)
  if (undecided > 0) out.push(`no verdict for either half: ${undecided}`)

  out.push('')
  out.push('caveats:')
  out.push(
    '  - subject-free is the reading `patchmine/shapes.ts` rejects for a sweep. This tier exists',
  )
  out.push(
    '    to price that rejection, not to overturn it: a high containment with a low',
  )
  out.push(
    '    discrimination says the sweep is a recall generator that needs the model stages behind',
  )
  out.push('    it, and says nothing about whether it is safe to report from directly',
  )
  out.push(
    '  - the corpus is every CVE an upstream project named in a commit message, so its unit is',
  )
  out.push(
    '    the function the fix touched. A sweep firing anywhere in that function counts as',
  )
  out.push(
    '    containing the defect, which is the right question for a generator and a lenient one',
  )
  out.push('    for a detector',
  )
  out.push(
    '  - no engine, provider, network or database is involved, so unlike §20.40\'s rule tier this',
  )
  out.push('    measurement can and does run in the test suite',
  )

  return out.join('\n')
}
