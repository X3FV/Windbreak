/**
 * Running the committed rule set over corpus halves (spec §11.1, §4.3).
 *
 * This is the only part of the rule tier that touches a process, and it is kept
 * separate from the tier so the scoring can be driven against recorded output.
 * It reuses §4.3's own argv builder and SARIF reader rather than shelling out in
 * its own shape, because a second invocation shape would be a second engine
 * configuration — different flags, different rule paths, and a figure nobody
 * could compare with a scan's.
 *
 * **One invocation, not one per half.** §4.3 drives Semgrep once over a whole
 * target, so a tier that invoked it 2×N times would measure a differently
 * configured machine: same rules, but rule compilation repeated per call and
 * per-file state reset. It would also take long enough that the figure would go
 * unmeasured.
 *
 * **A half the engine did not decide gets no verdict.** Every failure mode here
 * — no engine on PATH, unparseable stdout, `executionSuccessful: false`, a
 * non-zero exit with nothing read — marks *every* half unscoreable rather than
 * clearing them. An engine that failed must never look like an engine that found
 * nothing, and this is the one place in the tier where the two could be
 * conflated, because the absence of a finding and the absence of a run are both
 * an empty array.
 */

import fs from 'fs'
import path from 'path'

import { defaultHostRunner } from '../engines/resolve'
import { defaultRulePaths } from '../engines/rules'
import {
  buildSemgrepArgv,
  DEFAULT_SEMGREP_JOBS,
  DEFAULT_SEMGREP_TIMEOUT_SECONDS,
  parseSemgrepOutput,
  SEMGREP_BINARY,
} from '../engines/semgrep'

import type { HostRunner } from '../engines/resolve'
import type { RuleBatchResult, RuleBatchRunner, RuleHalfOutcome } from './rule-tier'

/** The subdirectory of the scratch root the halves are written into. */
export const HALVES_DIRECTORY = 'halves'

/**
 * A file extension the engine will actually parse the half as.
 *
 * Semgrep picks its language from the extension, so a half written as `.h` for a
 * header — or with no extension at all — would be skipped rather than scored,
 * and a skipped half is a miss attributed to a rule that never saw the file.
 */
export const extensionFor = (filePath: string): string => {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') ||
      lower.endsWith('.hpp') || lower.endsWith('.hh') || lower.endsWith('.hxx')) {
    return '.cpp'
  }
  return '.c'
}

/** A basename unique within one batch, so a finding can be tied back to its half. */
export const halfFileName = (index: number, filePath: string): string =>
  `wb-${String(index).padStart(5, '0')}${extensionFor(filePath)}`

export interface SemgrepBatchRunnerOptions {
  /** Rule files to apply. Defaults to the committed set (§4.3). */
  rulePaths?: readonly string[]
  /** Directory the halves are written into. Recreated per run. */
  scratchDir: string
  run?: HostRunner
  which?: (binary: string) => string | null
  /** Injected for tests. */
  writeFile?: (filePath: string, contents: string) => void
  removeDirectory?: (directory: string) => void
  jobs?: number
  timeoutSeconds?: number
  log?: (line: string) => void
}

/**
 * Build a batch runner backed by the real engine.
 *
 * `which` is checked before anything is written: an engine that is absent must
 * fail as *absent*, with that name, rather than as a parse error on output that
 * never existed.
 */
export const createSemgrepBatchRunner = (
  options: SemgrepBatchRunnerOptions,
): RuleBatchRunner => {
  const run = options.run ?? defaultHostRunner
  const which = options.which ?? ((binary: string) => Bun.which(binary) ?? null)
  const writeFile =
    options.writeFile ?? ((filePath: string, contents: string) => fs.writeFileSync(filePath, contents))
  const removeDirectory =
    options.removeDirectory ?? ((directory: string) => fs.rmSync(directory, { recursive: true, force: true }))
  const log = options.log ?? (() => {})

  return async (halves) => {
    const notes: string[] = []
    const directory = path.join(options.scratchDir, HALVES_DIRECTORY)

    removeDirectory(directory)
    fs.mkdirSync(directory, { recursive: true })

    const keyByFile = new Map<string, string>()
    halves.forEach((half, index) => {
      const name = halfFileName(index, half.filePath)
      writeFile(path.join(directory, name), half.source)
      keyByFile.set(name, half.key)
    })

    const unscoreableAll = (reason: string): RuleBatchResult => {
      removeDirectory(directory)
      return {
        outcomes: new Map(halves.map((half) => [half.key, { firedRuleIds: null, failureReason: reason }])),
        notes,
      }
    }

    if (which(SEMGREP_BINARY) === null) {
      notes.push(`${SEMGREP_BINARY} is not on PATH`)
      return unscoreableAll(
        `${SEMGREP_BINARY} is not on PATH, so the committed rule set could not be run`,
      )
    }

    const argv = buildSemgrepArgv({
      rulePaths: options.rulePaths ?? defaultRulePaths(),
      targetPaths: [directory],
      jobs: options.jobs ?? DEFAULT_SEMGREP_JOBS,
      timeoutSeconds: options.timeoutSeconds ?? DEFAULT_SEMGREP_TIMEOUT_SECONDS,
    })

    log(`[rules] ${SEMGREP_BINARY} over ${halves.length} half/halves`)

    const result = await run(argv)
    const stdout = result.stdout.trim()

    if (stdout.length === 0) {
      notes.push(`${SEMGREP_BINARY} produced no output on stdout`)
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ').trim()
      if (detail.length > 0) notes.push(`stderr: ${detail.slice(0, 300)}`)
      return unscoreableAll(
        `${SEMGREP_BINARY} produced no output, so it is unknown whether any rule ran`,
      )
    }

    try {
      JSON.parse(stdout)
    } catch {
      notes.push(`${SEMGREP_BINARY} output on stdout was not valid JSON`)
      return unscoreableAll(`${SEMGREP_BINARY} output could not be read as SARIF`)
    }

    const parsed = parseSemgrepOutput(stdout)
    notes.push(...parsed.warnings)

    if (parsed.executionFailed) {
      return unscoreableAll(`${SEMGREP_BINARY} reported executionSuccessful: false`)
    }

    // A non-zero exit with nothing read is a failure; §4.3 records that an engine
    // can also exit non-zero *with* valid SARIF, which is still usable.
    if (result.exitCode !== 0 && parsed.findings.length === 0) {
      notes.push(`${SEMGREP_BINARY} exited ${result.exitCode} with no findings`)
      return unscoreableAll(`${SEMGREP_BINARY} exited ${result.exitCode} without producing results`)
    }

    const fired = new Map<string, Set<string>>()
    let unattributed = 0
    for (const finding of parsed.findings) {
      const name = path.basename(finding.filePath)
      const key = keyByFile.get(name)
      if (key === undefined) {
        unattributed += 1
        continue
      }
      const set = fired.get(key) ?? new Set<string>()
      set.add(finding.ruleId)
      fired.set(key, set)
    }

    if (unattributed > 0) {
      // Should be impossible: the directory holds nothing else. Reported rather
      // than ignored, because a result this runner cannot place is a result the
      // measurement silently dropped.
      notes.push(
        `${unattributed} finding(s) named a file outside the batch and could not be attributed`,
      )
    }

    const outcomes = new Map<string, RuleHalfOutcome>()
    for (const half of halves) {
      const rules = fired.get(half.key)
      outcomes.set(half.key, { firedRuleIds: rules === undefined ? [] : [...rules].sort() })
    }

    removeDirectory(directory)
    return { outcomes, notes }
  }
}
