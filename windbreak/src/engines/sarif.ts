/**
 * Minimal SARIF 2.1.0 reader (spec §13).
 *
 * SARIF is the interchange format WindBreak already commits to for output, and
 * Semgrep emits it natively, so engines are read through SARIF rather than each
 * engine's bespoke JSON. Only the fields the pipeline needs are read; nothing
 * here trusts the document's shape.
 */

import type { RawFinding } from './types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const LEVELS = new Set(['error', 'warning', 'info', 'note'])

const normalizeLevel = (value: unknown): RawFinding['level'] => {
  const level = asString(value)?.toLowerCase()
  return level && LEVELS.has(level) ? (level as RawFinding['level']) : 'unknown'
}

/** `%SRCROOT%/src/a.c` and `file:///…` both reduce to a path. */
export const normalizeArtifactUri = (uri: string): string =>
  uri
    .replace(/^file:\/\//, '')
    .replace(/^%SRCROOT%\//, '')
    .replace(/^\.\//, '')

interface RuleInfo {
  cwe: string | null
  level: RawFinding['level'] | null
  precision: string | null
}

/** Pull the CWE tag and precision off a rule's metadata, whatever the spelling. */
const readRuleInfo = (rule: unknown): RuleInfo => {
  if (!isRecord(rule)) return { cwe: null, level: null, precision: null }

  const properties = isRecord(rule.properties) ? rule.properties : {}
  const defaultConfiguration = isRecord(rule.defaultConfiguration)
    ? rule.defaultConfiguration
    : {}

  let cwe: string | null = null
  const tags = properties.tags
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      const text = asString(tag)
      if (text && /^cwe[-_]/i.test(text)) {
        cwe = text.replace(/^cwe[-_]/i, 'CWE-').toUpperCase()
        break
      }
    }
  }
  if (!cwe) {
    const direct = asString(properties.cwe) ?? asString(rule.cwe)
    if (direct) cwe = direct.toUpperCase()
  }

  return {
    cwe,
    level: normalizeLevel(defaultConfiguration.level),
    precision: asString(properties.precision),
  }
}

export interface SarifParseResult {
  findings: RawFinding[]
  warnings: string[]
  /** True when a run reported `executionSuccessful: false`. */
  executionFailed: boolean
}

const collapse = (text: string, max = 300): string => {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

/**
 * Read `invocations[].toolExecutionNotifications[]`.
 *
 * This is not optional detail. When Semgrep's engine process is killed — for
 * instance by the sandbox's memory limit with too many parallel jobs — the run
 * exits non-zero but still emits syntactically valid SARIF with an empty
 * `results` array. The *reason* appears only here. Without reading it, a killed
 * engine is indistinguishable from a clean scan.
 */
const readInvocationNotifications = (
  run: Record<string, unknown>,
  engine: RawFinding['engine'],
): { warnings: string[]; executionFailed: boolean } => {
  const warnings: string[] = []
  let executionFailed = false

  const invocations = Array.isArray(run.invocations) ? run.invocations : []

  for (const invocation of invocations) {
    if (!isRecord(invocation)) continue
    if (invocation.executionSuccessful === false) executionFailed = true

    const notifications = Array.isArray(invocation.toolExecutionNotifications)
      ? invocation.toolExecutionNotifications
      : []

    for (const notification of notifications) {
      if (!isRecord(notification)) continue
      const level = asString(notification.level)?.toLowerCase()
      if (level !== 'error') continue
      const message = isRecord(notification.message)
        ? asString(notification.message.text)
        : null
      if (message) warnings.push(`${engine} rule engine error: ${collapse(message)}`)
    }
  }

  return { warnings, executionFailed }
}

/**
 * Read `runs[].results[]` into normalized findings.
 *
 * A malformed result is skipped and counted rather than throwing: one bad
 * record should not discard an engine's whole output, but it must be visible.
 */
export const parseSarif = (
  document: unknown,
  engine: RawFinding['engine'],
): SarifParseResult => {
  const warnings: string[] = []

  if (!isRecord(document)) {
    return {
      findings: [],
      warnings: ['SARIF document was not an object'],
      executionFailed: false,
    }
  }

  const runs = document.runs
  if (!Array.isArray(runs)) {
    return {
      findings: [],
      warnings: ['SARIF document had no runs array'],
      executionFailed: false,
    }
  }

  const findings: RawFinding[] = []
  let skipped = 0
  let executionFailed = false

  for (const run of runs) {
    if (!isRecord(run)) continue

    const invocation = readInvocationNotifications(run, engine)
    warnings.push(...invocation.warnings)
    if (invocation.executionFailed) executionFailed = true

    const driver = isRecord(run.tool) && isRecord(run.tool.driver) ? run.tool.driver : {}
    const rulesById = new Map<string, RuleInfo>()
    if (Array.isArray(driver.rules)) {
      for (const rule of driver.rules) {
        if (!isRecord(rule)) continue
        const id = asString(rule.id)
        if (id) rulesById.set(id, readRuleInfo(rule))
      }
    }

    const results = Array.isArray(run.results) ? run.results : []
    for (const result of results) {
      if (!isRecord(result)) {
        skipped += 1
        continue
      }

      const ruleId = asString(result.ruleId)
      const locations = Array.isArray(result.locations) ? result.locations : []
      const firstLocation = locations.find(isRecord)
      const physicalLocation =
        firstLocation && isRecord(firstLocation.physicalLocation)
          ? firstLocation.physicalLocation
          : null
      const artifactLocation =
        physicalLocation && isRecord(physicalLocation.artifactLocation)
          ? physicalLocation.artifactLocation
          : null
      const region =
        physicalLocation && isRecord(physicalLocation.region)
          ? physicalLocation.region
          : null

      const uri = artifactLocation ? asString(artifactLocation.uri) : null
      const startLine = region ? asNumber(region.startLine) : null
      const messageRecord = isRecord(result.message) ? result.message : null
      const message = messageRecord ? asString(messageRecord.text) : null

      if (!ruleId || !uri || startLine === null) {
        skipped += 1
        continue
      }

      const ruleInfo = rulesById.get(ruleId) ?? {
        cwe: null,
        level: null,
        precision: null,
      }

      // A result-level level overrides the rule's default.
      const level =
        normalizeLevel(result.level) !== 'unknown'
          ? normalizeLevel(result.level)
          : (isRecord(result.properties) ? normalizeLevel(result.properties.level) : 'unknown') 

      const snippetRecord =
        region && isRecord(region.snippet) ? region.snippet : null

      findings.push({
        engine,
        ruleId,
        level: level !== 'unknown' ? level : (ruleInfo.level ?? 'unknown'),
        message: message ?? ruleId,
        filePath: normalizeArtifactUri(uri),
        startLine,
        endLine: region ? asNumber(region.endLine) : null,
        snippet: snippetRecord ? asString(snippetRecord.text) : null,
        cwe: ruleInfo.cwe,
        precision: ruleInfo.precision,
      })
    }
  }

  if (skipped > 0) {
    warnings.push(
      `${engine} SARIF: skipped ${skipped} result(s) with no ruleId, location, or line`,
    )
  }

  return { findings, warnings, executionFailed }
}
