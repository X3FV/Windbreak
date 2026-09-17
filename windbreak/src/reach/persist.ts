/**
 * Reachability persistence (spec §4.4.4, §14.1).
 *
 * Two things are stored, and they are stored for two different readers:
 *
 * - `entry_points` is the inventory itself, one row per callable the index can be
 *   entered at, **with the reason it counts**. Stored rather than recomputed at report
 *   time because the list is a claim, and a claim a reader cannot inspect is one they
 *   have to take on trust: a finding that says "reachable from `main`" should be
 *   checkable against the row that made it.
 * - `candidates.reachability_json` is the per-candidate conclusion, including the path
 *   and the caveats. Denormalized on purpose: the report stage makes no model calls and
 *   should not need the call graph to render one line, and a verdict that could only be
 *   explained by re-running the analysis is not recorded, only asserted.
 *
 * The column is nullable and **NULL means the analysis never ran**, which is not the same
 * as `unreachable` (§18). Only a recorded `unreachable` may exclude a candidate.
 */

import { REACHABILITY_CLASSES } from './graph'

import type { Database } from 'bun:sqlite'
import type { EntryPoint } from './entries'
import type { ReachEntryRef, ReachabilityClass, ReachStep, SiteReachability } from './graph'

/**
 * What one candidate's location was found to be, as it is stored and rendered.
 *
 * The coverage counters ride along so a finding can state its own caveat — "12 callee
 * names have no indexed definition, so a call through a pointer is not visible here" —
 * without the reporting stage having to load the graph back.
 */
export interface CandidateReachability {
  klass: ReachabilityClass
  distance: number | null
  entry: ReachEntryRef | null
  incomplete: readonly string[]
  /** Shortest path from the entry, entry first. Empty when nothing reaches it. */
  path: readonly ReachStep[]
  /** The callable the site sits in, or null when it sits outside every indexed callable. */
  definition: SiteReachability['definition']
  coverage: {
    entries: number
    /** Callee names with no indexed definition: a libc call, or a call through a pointer. */
    externalCallees: number
    noEntries: boolean
  }
}

const parseJson = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const parseSteps = (value: unknown): ReachStep[] => {
  if (!Array.isArray(value)) return []
  const steps: ReachStep[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const filePath = asString(record.filePath)
    const name = asString(record.name)
    if (filePath === null || name === null) continue
    steps.push({ filePath, name, line: asNumber(record.line) })
  }
  return steps
}

const parseEntryRef = (value: unknown): ReachEntryRef | null => {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const filePath = asString(record.filePath)
  const name = asString(record.name)
  const kind = asString(record.kind)
  const reason = asString(record.reason)
  if (filePath === null || name === null || kind === null || reason === null) return null
  return { filePath, name, kind: kind as ReachEntryRef['kind'], reason }
}

/**
 * Decode a persisted conclusion, or null.
 *
 * Null for a malformed row, never a thrown error and never a defaulted class: a row this
 * cannot read must read as "not analyzed" rather than as a class the analysis did not
 * reach, because the one class that excludes a finding is `unreachable` and guessing at
 * it in either direction is the failure this whole feature is meant to prevent.
 */
export const parseCandidateReachability = (
  json: string | null,
): CandidateReachability | null => {
  if (json === null) return null
  const parsed = parseJson(json)
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>

  const klass = asString(record.klass)
  if (klass === null || !(REACHABILITY_CLASSES as readonly string[]).includes(klass)) {
    return null
  }

  // `coverage` is the marker for "this module wrote the row". It is required rather than
  // defaulted: a row carrying only a class cannot be told from a hand-edited or truncated
  // one, and the class it names may be the one that excludes a finding.
  const coverage = record.coverage
  if (!coverage || typeof coverage !== 'object') return null
  const coverageRecord = coverage as Record<string, unknown>

  const definitionValue = record.definition
  let definition: CandidateReachability['definition'] = null
  if (definitionValue && typeof definitionValue === 'object') {
    const raw = definitionValue as Record<string, unknown>
    const filePath = asString(raw.filePath)
    const name = asString(raw.name)
    const startLine = asNumber(raw.startLine)
    const endLine = asNumber(raw.endLine)
    if (filePath !== null && name !== null && startLine !== null && endLine !== null) {
      definition = { filePath, name, startLine, endLine }
    }
  }

  return {
    klass: klass as ReachabilityClass,
    distance: asNumber(record.distance),
    entry: parseEntryRef(record.entry),
    incomplete: Array.isArray(record.incomplete)
      ? record.incomplete.filter((line): line is string => typeof line === 'string')
      : [],
    path: parseSteps(record.path),
    definition,
    coverage: {
      entries: asNumber(coverageRecord.entries) ?? 0,
      externalCallees: asNumber(coverageRecord.externalCallees) ?? 0,
      noEntries: coverageRecord.noEntries === true,
    },
  }
}

export const reachabilityToJson = (reachability: CandidateReachability): string =>
  JSON.stringify(reachability)

/**
 * Replace the target's inventory with the one just computed.
 *
 * Delete-then-insert rather than an upsert because the inventory can *shrink*: an entry
 * that stops qualifying — the function it read input from was removed — must disappear,
 * and an upsert would leave the previous run's row behind claiming a callable is still an
 * entry point. One transaction, so a crash cannot leave the table half-replaced.
 */
export const persistEntryPoints = (input: {
  db: Database
  targetId: string
  entries: readonly EntryPoint[]
  now?: () => number
}): number => {
  const createdAt = new Date((input.now ?? Date.now)()).toISOString()
  const insert = input.db.prepare(
    `INSERT OR REPLACE INTO entry_points
       (target_id, file_path, name, kind, reason, sources_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  const write = input.db.transaction((entries: readonly EntryPoint[]) => {
    input.db
      .prepare('DELETE FROM entry_points WHERE target_id = ?')
      .run(input.targetId)
    for (const entry of entries) {
      insert.run(
        input.targetId,
        entry.filePath,
        entry.name,
        entry.kind,
        entry.reason,
        JSON.stringify(entry.sources),
        createdAt,
      )
    }
  })

  write(input.entries)
  return input.entries.length
}

export const readEntryPoints = (db: Database, targetId: string): EntryPoint[] =>
  db
    .query<
      { file_path: string; name: string; kind: string; reason: string; sources_json: string },
      [string]
    >(
      `SELECT file_path, name, kind, reason, sources_json
         FROM entry_points
        WHERE target_id = ?
        ORDER BY file_path, name`,
    )
    .all(targetId)
    .map((row) => {
      const sources = parseJson(row.sources_json)
      return {
        filePath: row.file_path,
        name: row.name,
        kind: row.kind as EntryPoint['kind'],
        reason: row.reason,
        sources: Array.isArray(sources)
          ? sources.filter((name): name is string => typeof name === 'string')
          : [],
      }
    })

/** Record one candidate's conclusion. */
export const persistCandidateReachability = (input: {
  db: Database
  candidateId: string
  reachability: CandidateReachability
}): void => {
  input.db
    .prepare('UPDATE candidates SET reachability_json = ? WHERE id = ?')
    .run(reachabilityToJson(input.reachability), input.candidateId)
}

/** The recorded conclusion for one candidate, or null when none was recorded. */
export const readCandidateReachability = (
  db: Database,
  candidateId: string,
): CandidateReachability | null => {
  const row = db
    .query<{ reachability_json: string | null }, [string]>(
      'SELECT reachability_json FROM candidates WHERE id = ?',
    )
    .get(candidateId)
  return parseCandidateReachability(row?.reachability_json ?? null)
}
