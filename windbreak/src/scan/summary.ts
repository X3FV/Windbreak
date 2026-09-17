/**
 * The scan summary, as lines (§20.13's reporting, §20.33's rule that a finished scan keeps
 * the summary — a run's only record of its warnings and of whether `0 candidates` means
 * clean or unswept).
 *
 * **Lines rather than `console.log` calls because there are two surfaces.** The batch
 * command prints them; the in-TUI view renders them. A second summariser would be a second
 * answer to "what did this run say", and the two would drift — the failure `launch.ts`
 * already refuses to allow for the run's own log, where the screen streams the same channel
 * the command pipes. Same rule, applied to the result.
 *
 * Empty strings are blank lines, and the leading blank is part of the first element, so
 * `console.log(lines.join('\n'))` reproduces the batch output byte for byte.
 */

import { describeProviderFailure } from '../provider-failure'
import { formatReachabilityCoverage } from '../reach'
import { formatInterproceduralCoverage, formatLanguageCoverage } from './coverage'

import type { ScanResult } from './types'

export const scanSummaryLines = (result: ScanResult): string[] => {
  const lines: string[] = [
    '',
    `run id:       ${result.runId}`,
    `target id:    ${result.targetId}`,
    `commit:       ${result.commitSha}`,
    `status:       ${result.status}`,
  ]

  // §18, and stated before the stage table rather than after it: when the account was
  // refused, that is the reason the model stages look the way they do, and a reader who
  // stopped at `partial` would go looking for a bug in the target instead.
  //
  // The per-candidate `warning:` lines below are left alone on purpose. Each one is a real
  // candidate left unexamined, and a summary that dropped them would be claiming a net the
  // run did not have — the wall of them is exactly why the cause needs saying once, up here.
  if (result.providerFailure) {
    lines.push('', `BLOCKED: ${describeProviderFailure(result.providerFailure)}`)
  }

  lines.push('', 'stages:')
  for (const stage of result.stages) {
    const seconds = `${(stage.durationMs / 1000).toFixed(1)}s`.padStart(8)
    lines.push(
      `  ${stage.stage.padEnd(15)} ${stage.status.padEnd(9)} ${seconds}  ` +
        `${stage.detail ?? stage.reason ?? ''}`,
    )
    if (stage.detail && stage.reason) lines.push(`  ${' '.repeat(15)} ${stage.reason}`)
  }

  lines.push(
    '',
    'candidates:',
    // Three producers feed one worklist, and naming only some of them would make the
    // total look wrong. The breakdown is printed rather than just the sum because
    // "engines found nothing" and "patch mining found nothing" are different
    // statements about a target.
    `  from discovery             ${result.counts.candidates}`,
    `    of which patch-mined     ${result.counts.patchMined}`,
    `    of which variant-hunt    ${result.counts.replays}`,
    `  triaged                    ${result.counts.triaged}`,
    `  confirmed                  ${result.counts.confirmed}`,
    `  dropped                    ${result.counts.dropped}`,
    `  escalated (needs review)   ${result.counts.escalated}`,
  )

  if (result.counts.rediscovery > 0) {
    lines.push(`  rediscovery                ${result.counts.rediscovery}`)
  }

  // §20.24.5: the summary's own copy of the pin's cost, beside the candidate counts rather
  // than only in a warning. `0 candidates` immediately above must not be the last word on a
  // repository whose callables the C-shaped tables never reached — that is the failure §18
  // names for the OSV stage.
  lines.push('', formatLanguageCoverage(result.languageCoverage))
  // The call graph's denominator, for the same reason and with the same pair of numbers: an
  // interprocedural sweep that reported nothing must not read as a target with no
  // cross-function check-to-use pairs when the truth is a graph with no edges.
  lines.push(
    formatInterproceduralCoverage({
      callEdges: result.counts.callEdges,
      callSitesSeen: result.counts.callSitesSeen,
      callSitesUnattributed: result.counts.callSitesUnattributed,
      callSitesAmbiguous: result.counts.callSitesAmbiguous,
      callerGuardedSites: result.counts.callerGuardedSites,
    }),
  )

  // §4.4.4's denominator, for the same reason again: `0 unreachable` and "the closure never
  // completed" must not print the same way. Read from the run's own counts rather than
  // queried, because the counts are what the stage recorded and §11.3 already derives
  // them per run — a second query here could disagree with the run it describes.
  lines.push(
    formatReachabilityCoverage({
      counts: {
        definitions: result.counts.reachCallables,
        entries: result.counts.entryPoints,
        attackerInput: result.counts.reachAttackerInput,
        exposedApi: result.counts.reachExposedApi,
        unreachable: result.counts.reachUnreachable,
        unknown: result.counts.reachUnknown,
      },
      coverage: {
        entries: result.counts.entryPoints,
        // Derived rather than stored: an inventory is empty exactly when the model has no
        // callables to enter, and the line says that instead when that is the case.
        noEntries: result.counts.reachCallables > 0 && result.counts.entryPoints === 0,
        taintRoots: result.counts.reachTaintRoots,
        externalCallees: result.counts.reachExternalCallees,
        qualifiedCallees: result.counts.reachQualifiedCallees,
      },
    }),
  )

  if (result.report) {
    lines.push(
      '',
      'report:',
      `  findings                   ${result.counts.findings}`,
      `  sarif                      ${result.report.sarifPath}`,
      `  index                      ${result.report.indexPath}`,
      `  not reported               ${result.counts.excluded}`,
    )
  }

  for (const warning of result.warnings) lines.push(`warning: ${warning}`)

  if (result.status === 'complete') {
    lines.push('', 'OK: scan complete.')
    return lines
  }

  lines.push('', `WARN: scan ${result.status}.`)
  if (result.resumeFrom) {
    lines.push(
      `Resume with: windbreak resume --run ${result.runId} ` +
        '--target <path>   (the first incomplete stage is ' +
        `${result.resumeFrom})`,
    )
  }

  return lines
}
