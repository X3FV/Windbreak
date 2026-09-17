/**
 * Reporting orchestration (spec §13, build order step 8).
 *
 * Reads recorded state, writes artifacts locally, records them. No model calls,
 * no network, and — critically — no execution of anything it generates. D21 made
 * that absolute by banning execution anywhere; §20.35 narrows it instead, moving
 * execution into the `confirm` stage, which is sandboxed and records to its own
 * table. This stage still runs nothing: it only *reads* what `confirm` proved, and
 * a harness it emits is still never executed by the code that emitted it.
 *
 * Artifacts carry live exploit detail, and §17 item 8 leaves their storage and
 * any encryption-at-rest unresolved. Until that is decided the safe default is
 * the restrictive one: the output directory is created `0700` and every file
 * `0600`, so a report is readable only by the user who generated it.
 */

import fs from 'fs'
import path from 'path'

import { createBuildPlan } from '../build/plan'
import { detectBuildSystem } from '../build/detect'
import { readConfirmedCandidateIds } from '../confirm/persist'

import { deriveFindings } from './findings'
import { generateHarness } from './harness'
import {
  collectReportableInputs,
  ensureLedgerEntry,
  persistFinding,
} from './persist'
import { buildSarifDocument, serializeSarif } from './sarif'
import { renderWriteup } from './writeup'

import type { Database } from 'bun:sqlite'
import type { PipelineProgramContext } from '../pipeline'
import type { ExcludedCandidate } from './findings'
import type { Finding } from './types'

/** Report artifacts are the researcher's own data; nobody else may read them. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * What reporting is asked to write — all of it JSON (§20.17.3).
 *
 * `runStatus` is the field that justifies classifying by type rather than by
 * whether something "looks like config". It reads like state the stage should
 * look up, and the comment below records the bug from when it did — but it is a
 * string, so it is part of the request and the caller may supply it.
 */
export interface ReportRequest {
  runId: string
  targetId: string
  /** Absolute path of the target checkout. */
  targetLocation: string
  commitSha: string
  version: string
  /** Where artifacts are written. Defaults to `<cwd>/.windbreak/reports/<runId>`. */
  outDir?: string | undefined
  /** Candidate ids the researcher has reproduced (sets the stronger tier). */
  reproduced?: readonly string[] | undefined
  /**
   * The run's status, when the caller already knows it.
   *
   * Inside a `scan` the run row is still `running` while this stage produces its
   * artifacts — the chain is not finished, so it cannot have been finalized —
   * and reading it there made every in-scan report declare itself partial. The
   * orchestrator knows what has completed so far, so it passes that instead. The
   * standalone `report` command leaves this unset and reads the row.
   */
  runStatus?: string | undefined
}

/** What reporting needs from the host — none of it serializable. */
export interface ReportServices {
  db: Database
  programContext?: PipelineProgramContext | undefined
  log?: (line: string) => void
  now?: (() => number) | undefined
}

/** The in-process call convention: the request plus the services (§20.17.3). */
export type ReportOptions = ReportRequest & ReportServices

export interface ReportedFinding {
  id: string
  title: string
  evidenceTier: Finding['evidenceTier']
  /** CWE the finding is classified under, or null when unclassified. */
  cwe: string | null
  filePath: string | null
  startLine: number | null
  writeupPath: string
  harnessFiles: string[]
}

export interface ReportResult {
  outDir: string
  sarifPath: string
  indexPath: string
  findings: ReportedFinding[]
  rediscoveries: Array<{ candidateId: string; vulnId: string | null; basis: string; filePath: string | null }>
  excluded: ExcludedCandidate[]
  warnings: string[]
  /** True when the run itself was not complete, so the report is not either. */
  partial: boolean
}

const writeArtifact = (filePath: string, contents: string): void => {
  fs.writeFileSync(filePath, contents, { mode: FILE_MODE })
}

const readTargetRow = (
  db: Database,
  targetId: string,
): { buildModel: string | null; scopeClass: string | null; location: string } | null => {
  const row = db
    .query<
      { build_model: string | null; scope_class: string | null; location: string },
      [string]
    >('SELECT build_model, scope_class, location FROM targets WHERE id = ?')
    .get(targetId)
  return row
    ? { buildModel: row.build_model, scopeClass: row.scope_class, location: row.location }
    : null
}

const runStatus = (db: Database, runId: string): string =>
  db
    .query<{ status: string }, [string]>('SELECT status FROM runs WHERE id = ?')
    .get(runId)?.status ?? 'unknown'

/**
 * The target's build steps, resolved for the harness instructions.
 *
 * Reporting is host-side and read-only, so this is detection plus planning —
 * nothing is executed. A failure here degrades the instructions, not the report.
 */
const resolveBuildSteps = (
  targetLocation: string,
): {
  steps: Array<{ description: string; command: string[] }>
  compileCommandsPath: string | null
  warnings: string[]
} => {
  const warnings: string[] = []
  try {
    const entries = fs.readdirSync(targetLocation)
    const detection = detectBuildSystem(entries)
    const plan = createBuildPlan({
      detection,
      checkoutDir: targetLocation,
      buildDir: path.join(path.dirname(targetLocation), `${path.basename(targetLocation)}-build`),
      sourceDir: targetLocation,
      sourceMode: detection.writesInSource ? 'copy' : 'read-only',
      compile: false,
    })
    return {
      steps: plan.steps.map((step) => ({ description: step.description, command: step.command })),
      compileCommandsPath: plan.compileCommandsPath,
      warnings,
    }
  } catch (error) {
    warnings.push(
      `Could not plan the target build for harness instructions (${
        error instanceof Error ? error.message : String(error)
      }); the harness will not include build steps.`,
    )
    return { steps: [], compileCommandsPath: null, warnings }
  }
}

export const runReport = async (options: ReportOptions): Promise<ReportResult> => {
  const log = options.log ?? (() => {})
  const outDir =
    options.outDir ?? path.resolve('.windbreak', 'reports', options.runId)

  const inputs = collectReportableInputs({
    db: options.db,
    runId: options.runId,
    programContext: options.programContext,
  })

  // §20.35: the `confirm` stage records its reproductions in the database, and
  // reporting reads them the same way it reads the researcher's `--reproduced`
  // assertion. Both only ever move a tier up, so a run's artifacts say
  // `dynamically-confirmed` without anyone re-running anything by hand.
  const dynamicallyConfirmed = readConfirmedCandidateIds(options.db, options.runId)

  const { findings, rediscoveries, excluded } = deriveFindings({
    candidates: inputs,
    ...(options.reproduced ? { reproduced: options.reproduced } : {}),
    ...(dynamicallyConfirmed.length > 0 ? { dynamicallyConfirmed } : {}),
  })

  const warnings: string[] = []

  // An explicit reproduction assertion that matches nothing is almost always a
  // typo in a candidate id; silence would make the tier look applied when it is not.
  if (options.reproduced) {
    const known = new Set(inputs.map((entry) => entry.candidate.id))
    for (const candidateId of options.reproduced) {
      if (!known.has(candidateId)) {
        warnings.push(
          `--reproduced ${candidateId} matched no reportable candidate; the tier was not applied.`,
        )
      }
    }
  }

  fs.mkdirSync(outDir, { recursive: true, mode: DIR_MODE })

  const target = readTargetRow(options.db, options.targetId)
  const build = resolveBuildSteps(options.targetLocation)
  warnings.push(...build.warnings)

  // --- SARIF (one run, one result per finding) ---
  const sarifPath = path.join(outDir, 'findings.sarif')
  writeArtifact(
    sarifPath,
    serializeSarif(
      buildSarifDocument({
        targetLocation: options.targetLocation,
        commitSha: options.commitSha,
        runId: options.runId,
        findings,
        version: options.version,
      }),
    ),
  )

  // --- one writeup + one harness per finding ---
  const reported: ReportedFinding[] = []
  for (const finding of findings) {
    const enclosing =
      options.programContext && finding.filePath && finding.startLine !== null
        ? options.programContext.enclosingFunction(finding.filePath, finding.startLine)
        : null

    const harness = generateHarness({
      finding,
      targetLocation: options.targetLocation,
      functionName: enclosing?.name ?? null,
      buildSteps: build.steps,
      compileCommandsPath: build.compileCommandsPath,
    })

    const harnessDir = path.join(outDir, 'harness', finding.id)
    fs.mkdirSync(harnessDir, { recursive: true, mode: DIR_MODE })

    const harnessFiles: string[] = []
    for (const file of harness.files) {
      const filePath = path.join(harnessDir, file.name)
      writeArtifact(filePath, file.contents)
      if (file.executable) fs.chmodSync(filePath, 0o700)
      harnessFiles.push(filePath)
    }

    // The writeup's reproduction steps come from the harness, so a reader does
    // not have to open a second file to know what to try.
    const writeupPath = path.join(outDir, 'findings', `${finding.id}.md`)
    fs.mkdirSync(path.dirname(writeupPath), { recursive: true, mode: DIR_MODE })
    writeArtifact(
      writeupPath,
      renderWriteup({
        finding,
        targetLocation: options.targetLocation,
        commitSha: options.commitSha,
        reproductionSteps: harness.researcherInstructions.split('\n'),
      }),
    )

    persistFinding({
      db: options.db,
      findingId: finding.id,
      candidateId: finding.candidateId,
      evidenceTier: finding.evidenceTier,
      sarifPath,
      writeupPath,
      ...(options.now ? { now: options.now } : {}),
    })
    ensureLedgerEntry({
      db: options.db,
      findingId: finding.id,
      ...(options.now ? { now: options.now } : {}),
    })

    reported.push({
      id: finding.id,
      title: finding.title,
      evidenceTier: finding.evidenceTier,
      cwe: finding.cwe,
      filePath: finding.filePath,
      startLine: finding.startLine,
      writeupPath,
      harnessFiles,
    })
  }

  // --- run-level index ---
  const status = options.runStatus ?? runStatus(options.db, options.runId)
  const partial = status !== 'complete'

  const indexLines: string[] = [
    `# WindBreak report — ${path.basename(options.targetLocation)}`,
    '',
    `**Target:** ${options.targetLocation} @ ${options.commitSha}`,
    `**Run:** ${options.runId} (status: ${status})`,
    ...(target?.buildModel ? [`**Build model:** ${target.buildModel}`] : []),
    ...(target?.scopeClass ? [`**Scope class:** ${target.scopeClass}`] : []),
    `**Findings:** ${reported.length} · **Rediscoveries:** ${rediscoveries.length} · **Not reported:** ${excluded.length}`,
    '',
    'No finding is asserted as exploitable without its evidence tier, and a',
    '`contested` finding is one that must be adjudicated before it is relied on',
    '(spec §2.1.5).',
    '',
  ]

  if (partial) {
    indexLines.push(
      `> This run's status is \`${status}\`, so this report is partial: absent findings may`,
      '> simply not have been examined. Re-run the pipeline before drawing conclusions.',
      '',
    )
  }

  indexLines.push('## Findings', '')
  if (reported.length === 0) {
    indexLines.push(
      'No candidate survived to a reportable finding. That is a statement about this run,',
      'not about the target.',
      '',
    )
  } else {
    indexLines.push('| Finding | Class | Tier | Location | Writeup |', '|---|---|---|---|---|')
    for (const finding of reported) {
      indexLines.push(
        `| ${finding.title} | ${finding.cwe ?? 'unclassified'} | \`${finding.evidenceTier}\` | ` +
          `${finding.filePath ?? '(unknown)'}:${finding.startLine ?? '?'} | ` +
          `${path.relative(outDir, finding.writeupPath)} |`,
      )
    }
    indexLines.push('')
    indexLines.push(
      'Harnesses are under `harness/<finding-id>/`. WindBreak generated them and did not',
      'build or run them (spec D21).',
      '',
    )
  }

  if (rediscoveries.length > 0) {
    indexLines.push('## Rediscoveries (known vulnerabilities, not discoveries)', '')
    for (const entry of rediscoveries) {
      indexLines.push(
        `- ${entry.candidate.filePath ?? '(unknown)'}:${entry.candidate.startLine ?? '?'} — ` +
          `${entry.rediscovery?.basis ?? 'matched a known vulnerability'}`,
      )
    }
    indexLines.push('')
  }

  if (excluded.length > 0) {
    indexLines.push('## Candidates not reported', '')
    for (const entry of excluded) {
      indexLines.push(`- ${entry.candidateId}: ${entry.reason}`)
    }
    indexLines.push('')
  }

  if (warnings.length > 0) {
    indexLines.push('## Warnings', '')
    for (const warning of warnings) indexLines.push(`- ${warning}`)
    indexLines.push('')
  }

  const indexPath = path.join(outDir, 'report.md')
  writeArtifact(indexPath, indexLines.join('\n'))

  log(`[report] artifacts written to ${outDir}`)

  return {
    outDir,
    sarifPath,
    indexPath,
    findings: reported,
    rediscoveries: rediscoveries.map((entry) => ({
      candidateId: entry.candidate.id,
      vulnId: entry.rediscovery?.vulnId ?? null,
      basis: entry.rediscovery?.basis ?? 'matched a known vulnerability',
      filePath: entry.candidate.filePath,
    })),
    excluded,
    warnings,
    partial,
  }
}
