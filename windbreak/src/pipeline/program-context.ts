/**
 * Program-model lookups for the pipeline (spec §5.1 rule 3).
 *
 * §5.1 rule 3 requires a candidate's context to be resolved by *tool queries*
 * rather than by a model reading comments. The recon stage already persisted the
 * symbol index (§14.1 `symbols`, `symbol_refs`), so everything here is plain SQL
 * against that index — no model is asked what a function does.
 */

import { CALLABLE_KIND_FILTER } from '../recon/symbol-kinds'
import { symbolsFromSnippet } from './rediscovery'

import type { Database } from 'bun:sqlite'
import type { ProgramContextSource } from './context'
import type { CallSite } from './types'

export interface PipelineProgramContext extends ProgramContextSource {
  /**
   * Names worth matching a candidate against an advisory, from the symbol index
   * where possible. Falls back to identifiers in the snippet only when the
   * index has nothing for this location.
   */
  symbolsFor(input: {
    filePath: string | null
    /** Enclosing function range, when one was resolved. */
    range: { startLine: number; endLine: number } | null
    snippet: string | null
  }): string[]
  /** The language recon recorded for a file, for the prompt's front matter. */
  languageFor(filePath: string | null): string | null
}

export const createProgramContext = (
  db: Database,
  targetId: string,
): PipelineProgramContext => {
  const enclosingQuery = db.query<
    { name: string; start_line: number; end_line: number },
    [string, string, number, number]
  >(
    `SELECT name, start_line, end_line FROM symbols
      WHERE target_id = ? AND file_path = ? AND ${CALLABLE_KIND_FILTER}
        AND start_line <= ? AND end_line >= ?
      ORDER BY (end_line - start_line) ASC
      LIMIT 1`,
  )

  const callersQuery = db.query<
    { file_path: string; name: string; line: number },
    [string, string]
  >(
    `SELECT file_path, name, line FROM symbol_refs
      WHERE target_id = ? AND name = ?
      ORDER BY file_path, line
      LIMIT 10`,
  )

  const languageQuery = db.query<{ language: string | null }, [string, string]>(
    `SELECT language FROM recon_files WHERE target_id = ? AND path = ?`,
  )

  const refsInRangeQuery = db.query<{ name: string }, [string, string, number, number]>(
    `SELECT DISTINCT name FROM symbol_refs
      WHERE target_id = ? AND file_path = ? AND line BETWEEN ? AND ?
      ORDER BY name
      LIMIT 40`,
  )

  return {
    enclosingFunction(filePath, line) {
      const row = enclosingQuery.get(targetId, filePath, line, line)
      if (!row) return null
      return {
        name: row.name,
        startLine: row.start_line,
        endLine: row.end_line,
      }
    },

    callers(name): CallSite[] {
      return callersQuery.all(targetId, name).map((row) => ({
        name: row.name,
        filePath: row.file_path,
        line: row.line,
      }))
    },

    symbolsFor({ filePath, range, snippet }) {
      if (filePath && range) {
        const names = refsInRangeQuery
          .all(targetId, filePath, range.startLine, range.endLine)
          .map((row) => row.name)
        if (names.length > 0) return names
      }
      // No indexed references: fall back to the identifiers in the snippet, and
      // accept that a libc name may slip through. A missing match here is a
      // deferred check, not a wrong answer.
      return symbolsFromSnippet(snippet)
    },

    languageFor(filePath) {
      if (!filePath) return null
      return languageQuery.get(targetId, filePath)?.language ?? null
    },
  }
}
