import fs from 'fs'

import { isProgramModelLanguage, unsupportedProgramLanguages } from './languages'
import { parseSource } from './parser'

import type { Database } from 'bun:sqlite'
import type { FileEntry } from './inventory'

/** Skip generated monsters; a 40 MB amalgamation would dominate the run. */
export const DEFAULT_MAX_PARSE_FILE_BYTES = 1_000_000
export const DEFAULT_MAX_FILES_TO_PARSE = 20_000

export interface ProgramModelOptions {
  db: Database
  targetId: string
  files: readonly FileEntry[]
  maxFilesToParse?: number
  maxFileBytes?: number
  /** Injected for tests. */
  readSource?: (absolutePath: string) => string
}

export interface ProgramModelResult {
  filesIndexed: number
  filesParsed: number
  symbols: number
  references: number
  /**
   * Programming-language files skipped because no query covers them yet
   * (PHP, shell, assembly). Reported per *language*, not just counted.
   */
  unsupportedFiles: number
  /** The language ids behind `unsupportedFiles`, sorted. */
  unsupportedLanguages: string[]
  tooLarge: number
  parseFailures: number
  /** Files that parsed but contained syntax errors. */
  filesWithErrors: number
  truncated: boolean
  warnings: string[]
}

/**
 * Parse the target's sources into a queryable symbol index.
 *
 * Idempotent: symbol and reference ids are derived from their content location
 * rather than generated, so re-running recon on the same commit replaces rows
 * instead of duplicating them.
 *
 * One file that fails to parse is counted and skipped — it never aborts the
 * target, because an unparseable generated file is common and would otherwise
 * make a whole repository unscannable.
 */
export const buildProgramModel = async (
  options: ProgramModelOptions,
): Promise<ProgramModelResult> => {
  const db = options.db
  const maxFilesToParse = options.maxFilesToParse ?? DEFAULT_MAX_FILES_TO_PARSE
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_PARSE_FILE_BYTES
  const readSource =
    options.readSource ?? ((absolutePath: string) => fs.readFileSync(absolutePath, 'utf8'))

  const warnings: string[] = []

  const insertFile = db.prepare(
    `INSERT OR REPLACE INTO recon_files (target_id, path, language, bytes, binary)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const insertSymbol = db.prepare(
    `INSERT OR REPLACE INTO symbols
       (id, target_id, file_path, name, qualifier, kind, start_line, end_line, language)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertRef = db.prepare(
    `INSERT OR REPLACE INTO symbol_refs
       (id, target_id, file_path, name, kind, line, language)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )

  let filesIndexed = 0
  let filesParsed = 0
  let symbolCount = 0
  let referenceCount = 0
  let unsupportedFiles = 0
  let tooLarge = 0
  let parseFailures = 0
  let filesWithErrors = 0
  let truncated = false

  const writeInventory = db.transaction((files: readonly FileEntry[]) => {
    for (const file of files) {
      insertFile.run(
        options.targetId,
        file.path,
        file.language,
        file.bytes,
        file.binary ? 1 : 0,
      )
      filesIndexed += 1
    }
  })
  writeInventory(options.files)

  const parseable = options.files.filter(
    (file) => !file.binary && isProgramModelLanguage(file.language),
  )

  // Languages present in the tree that no grammar covers yet. Reported, not
  // hidden: a C++-only query set silently skipping Rust sources would look like
  // "no symbols found" rather than "not supported".
  //
  // The list used to be hard-coded to the five languages a *future* query set
  // was expected to cover. It is now derived from which languages are
  // programming-kind but unregistered, so adding a grammar removes a language
  // from this report automatically instead of leaving a stale allow-list behind.
  const unsupportedLanguages = unsupportedProgramLanguages(
    options.files.filter((file) => !file.binary).map((file) => file.language),
  )
  unsupportedFiles = options.files.filter(
    (file) =>
      !file.binary &&
      file.language !== null &&
      unsupportedLanguages.includes(file.language),
  ).length
  if (unsupportedLanguages.length > 0) {
    warnings.push(
      `No program-model query for ${unsupportedLanguages.join(', ')}; ` +
        `${unsupportedFiles} file(s) were inventoried but not indexed.`,
    )
  }

  for (const file of parseable) {
    if (filesParsed >= maxFilesToParse) {
      truncated = true
      warnings.push(
        `Program model stopped at the ${maxFilesToParse}-file cap; the symbol index is partial.`,
      )
      break
    }

    if (file.bytes > maxFileBytes) {
      tooLarge += 1
      continue
    }

    let source: string
    try {
      source = readSource(file.absolutePath)
    } catch {
      parseFailures += 1
      continue
    }

    try {
      const parsed = await parseSource(file.language!, source)
      filesParsed += 1
      if (parsed.hasError) filesWithErrors += 1

      const writeFile = db.transaction(() => {
        for (const symbol of parsed.symbols) {
          insertSymbol.run(
            `${options.targetId}:${file.path}:${symbol.kind}:${symbol.name}:${symbol.startLine}`,
            options.targetId,
            file.path,
            symbol.name,
            symbol.qualifier,
            symbol.kind,
            symbol.startLine,
            symbol.endLine,
            file.language,
          )
          symbolCount += 1
        }
        for (const reference of parsed.references) {
          insertRef.run(
            `${options.targetId}:${file.path}:${reference.line}:${reference.name}`,
            options.targetId,
            file.path,
            reference.name,
            reference.kind,
            reference.line,
            file.language,
          )
          referenceCount += 1
        }
      })
      writeFile()
    } catch {
      parseFailures += 1
    }
  }

  if (parseFailures > 0) {
    warnings.push(`${parseFailures} file(s) could not be parsed and were skipped.`)
  }
  if (filesWithErrors > 0) {
    warnings.push(
      `${filesWithErrors} file(s) parsed with syntax errors; their symbols may be incomplete.`,
    )
  }

  return {
    filesIndexed,
    filesParsed,
    symbols: symbolCount,
    references: referenceCount,
    unsupportedFiles,
    unsupportedLanguages,
    tooLarge,
    parseFailures,
    filesWithErrors,
    truncated,
    warnings,
  }
}
