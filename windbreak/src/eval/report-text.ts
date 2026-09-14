/**
 * The `eval` report as text.
 *
 * Pure and separate from the command so the one thing that *must* be right about
 * it can be tested: a stage that did not run prints `—` and never `0`. A table
 * of zeroes under a stage that was never reached is the §18 failure mode wearing
 * a table, and a reader skimming for a recall drop would read it as one.
 */

import type { EvalReport, FunnelRow } from './types'

/** The em dash stands in for "no number exists", which is not the same as zero. */
const NIL = '—'

const cell = (value: number | null, format: (input: number) => string): string =>
  value === null ? NIL : format(value)

const count = (value: number | null): string => cell(value, (input) => String(input))
const ratio = (value: number | null): string =>
  cell(value, (input) => input.toFixed(3))

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

const FUNNEL_HEADERS = [
  'stage',
  'cands',
  'tp',
  'fp',
  'unscored',
  'precision',
  'recall',
  'discovery',
  'target fp',
] as const

const funnelRow = (row: FunnelRow, totalBugs: number): string[] => {
  if (row.status === 'not-run') {
    return [row.label, NIL, NIL, NIL, NIL, NIL, NIL, NIL, NIL]
  }

  const found = row.bugsFound === null ? NIL : `${row.bugsFound.length}/${totalBugs}`
  const discovery =
    row.bugsFoundByDiscovery === null ? NIL : `${row.bugsFoundByDiscovery.length}/${totalBugs}`

  return [
    row.label,
    count(row.candidates),
    count(row.truePositives),
    count(row.falsePositives),
    count(row.unscored),
    ratio(row.precision),
    found,
    discovery,
    `${(row.targetFpRate * 100).toFixed(0)}%${row.targetMet === false ? ' !' : ''}`,
  ]
}

const label = (report: EvalReport): string => {
  const version = `fixture set version ${report.fixtureSetVersion}`
  return report.fixtureSetDescription === null
    ? version
    : `${version} — ${report.fixtureSetDescription}`
}

export const renderEvalReport = (report: EvalReport): string => {
  const out: string[] = [label(report), '']

  if (report.fixtures.length === 0) {
    out.push('No fixtures in this set. Nothing was scored, and nothing passed.')
    return out.join('\n')
  }

  for (const fixture of report.fixtures) {
    out.push(`${fixture.fixtureId}  ${fixture.project} @ ${fixture.commitSha}`)

    if (fixture.status === 'not-run') {
      out.push(`  NOT SCORED  ${fixture.reason}`)
      out.push(`  seeded: ${fixture.totalBugs} bug(s)`)
      out.push('')
      continue
    }

    out.push(`  run: ${fixture.runId}   seeded: ${fixture.totalBugs} bug(s)`)
    out.push('')
    out.push(
      table(
        FUNNEL_HEADERS,
        fixture.funnel.map((row) => funnelRow(row, fixture.totalBugs)),
      )
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    )

    for (const row of fixture.funnel) {
      if (row.status === 'not-run' && row.reason !== null) {
        out.push(`  ${row.label}: ${row.reason}`)
      }
      if (row.bugsLost !== null && row.bugsLost.length > 0) {
        out.push(`  lost after ${row.label}: ${row.bugsLost.join(', ')}`)
      }
      for (const note of row.notes) out.push(`  note (${row.label}): ${note}`)
    }

    for (const note of fixture.notes) out.push(`  note: ${note}`)

    out.push('')
  }

  const recallText =
    report.recall === null ? NIL : `${report.recall.toFixed(3)} (mean over scored fixtures)`
  const discoveryText =
    report.discoveryRecall === null ? NIL : report.discoveryRecall.toFixed(3)

  out.push(`fixtures      ${report.scoredFixtures} scored, ${report.unscoredFixtures} unscored`)
  out.push(`seeded bugs   ${report.totalBugs}`)
  out.push(`surfaced      ${recallText}`)
  out.push(`  discovery   ${discoveryText}`)

  if (report.gate === 'pass') {
    out.push(`gate          PASS  >= ${report.minRecall.toFixed(2)} (D11)`)
  } else if (report.gate === 'fail') {
    out.push(`gate          FAIL  below ${report.minRecall.toFixed(2)} (D11)`)
  } else {
    out.push(`gate          NOT EVALUABLE  ${report.gateReason ?? 'no recall to gate on'}`)
  }

  if (report.caveats.length > 0) {
    out.push('')
    out.push('caveats:')
    for (const caveat of report.caveats) out.push(`  - ${caveat}`)
  }

  return out.join('\n')
}
