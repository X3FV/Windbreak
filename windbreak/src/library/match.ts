/**
 * Fingerprint matching (spec §10, §4.8).
 *
 * This module is the whole replay engine, and it is pure SQL over the recon
 * program model plus a grouping pass. There is no model call, no subprocess, and
 * no filesystem read: replay therefore costs the same on the thousandth target
 * as on the first, and produces the same answer twice (§2.1.3).
 *
 * The matcher is intentionally *not* a graph analysis. It answers one question
 * — "does this site contain these calls and lack those" — and it is only ever
 * pointed at sites by a pattern that already caught a confirmed finding
 * somewhere else. Widening it would make a mismatch the researcher's problem to
 * discover from a noisy report.
 */

import { PROGRAM_MODEL_LANGUAGES } from '../recon/languages'
import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'

import type { Database } from 'bun:sqlite'
import type { Fingerprint, FingerprintHit } from './types'

interface RefRow {
  file_path: string
  name: string
  line: number
}

interface FunctionRow {
  file_path: string
  name: string
  start_line: number
  end_line: number
}

interface Site {
  filePath: string
  functionName: string | null
  /** Site key: file path for file scope, file + function start for function scope. */
  key: string
  refs: Array<{ name: string; line: number }>
}

const groupRefs = (
  refs: readonly RefRow[],
  scope: Fingerprint['scope'],
  functionsByFile: Map<string, Array<{ name: string; startLine: number; endLine: number }>>,
): Site[] => {
  const sites = new Map<string, Site>()

  for (const ref of refs) {
    let functionName: string | null = null
    let key = ref.file_path

    if (scope === 'function') {
      const functions = functionsByFile.get(ref.file_path) ?? []
      // Ranges can nest, so the innermost enclosing function wins — the same
      // rule `program-context.enclosingFunction` follows for the pipeline.
      const enclosing = functions
        .filter((fn) => fn.startLine <= ref.line && fn.endLine >= ref.line)
        .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]

      if (!enclosing) continue
      functionName = enclosing.name
      key = `${ref.file_path}\u0000${enclosing.startLine}`
    }

    const site = sites.get(key) ?? {
      filePath: ref.file_path,
      functionName,
      key,
      refs: [],
    }
    site.refs.push({ name: ref.name, line: ref.line })
    sites.set(key, site)
  }

  return [...sites.values()]
}

/**
 * Evaluate one fingerprint against one target's program model.
 *
 * @throws when the target has no program model rows at all — an empty symbol
 * index and a clean target look identical otherwise, which is exactly the
 * failure §18 names for the OSV stage and applies equally here.
 */
export const matchFingerprint = (input: {
  db: Database
  targetId: string
  fingerprint: Fingerprint
}): FingerprintHit[] => {
  const { db, targetId, fingerprint } = input

  const functionsByFile = new Map<
    string,
    Array<{ name: string; startLine: number; endLine: number }>
  >()

  if (fingerprint.scope === 'function') {
    const rows = db
      .query<FunctionRow, [string]>(
        `SELECT file_path, name, start_line, end_line FROM symbols
          WHERE target_id = ? AND ${CALLABLE_KIND_FILTER}
          ORDER BY file_path, start_line`,
      )
      .all(targetId)

    for (const row of rows) {
      const list = functionsByFile.get(row.file_path) ?? []
      list.push({ name: row.name, startLine: row.start_line, endLine: row.end_line })
      functionsByFile.set(row.file_path, list)
    }
  }

  const refs = db
    .query<RefRow, [string]>(
      `SELECT file_path, name, line FROM symbol_refs
        WHERE target_id = ?
        ORDER BY file_path, line`,
    )
    .all(targetId)

  const languages = new Map<string, string | null>(
    db
      .query<{ path: string; language: string | null }, [string]>(
        'SELECT path, language FROM recon_files WHERE target_id = ?',
      )
      .all(targetId)
      .map((row) => [row.path, row.language]),
  )

  const allowed = new Set(fingerprint.languages)
  const hits: FingerprintHit[] = []

  for (const site of groupRefs(refs, fingerprint.scope, functionsByFile)) {
    const language = languages.get(site.filePath) ?? null
    if (!language || !allowed.has(language)) continue

    const observed = new Set(site.refs.map((ref) => ref.name))

    if (!fingerprint.requireCalls.every((name) => observed.has(name))) continue
    if (
      fingerprint.requireAnyCalls.length > 0 &&
      !fingerprint.requireAnyCalls.some((name) => observed.has(name))
    ) {
      continue
    }
    if (fingerprint.forbidCalls.some((name) => observed.has(name))) continue

    const lineOf = (name: string): number =>
      Math.min(...site.refs.filter((ref) => ref.name === name).map((ref) => ref.line))

    let ordered = true
    for (const pair of fingerprint.order) {
      if (!observed.has(pair.before) || !observed.has(pair.after)) {
        ordered = false
        break
      }
      if (lineOf(pair.before) >= lineOf(pair.after)) {
        ordered = false
        break
      }
    }
    if (!ordered) continue

    // Anchor on the sink: the first required call in the site. A `requireAny`
    // match is the fallback, so a pattern whose positive predicate is a
    // disjunction still points at the call it actually saw.
    const positive = fingerprint.requireCalls.filter((name) => observed.has(name))
    const anchorName =
      positive.sort((a, b) => lineOf(a) - lineOf(b))[0] ??
      fingerprint.requireAnyCalls
        .filter((name) => observed.has(name))
        .sort((a, b) => lineOf(a) - lineOf(b))[0]!

    hits.push({
      filePath: site.filePath,
      functionName: site.functionName,
      line: lineOf(anchorName),
      observedCalls: [...observed].sort(),
      matchedOn: anchorName,
    })
  }

  return hits.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line)
}

/** Language ids a fingerprint may target, for the CLI and the synthesis prompt. */
export const MATCHABLE_LANGUAGES = Object.keys(PROGRAM_MODEL_LANGUAGES)
