/**
 * Rediscovery pre-check (spec §4.2 lookup 3).
 *
 * §4.2 asks for a re-query "with the file path + symbol names". OSV's public API
 * has no path or symbol query — it takes a package, a version, or a commit — so
 * this module does the part that is actually decidable: it matches a candidate
 * against the advisory text of the target's known vulnerabilities, and the stage
 * around it refreshes the commit lookup so newly-published advisories are in the
 * set being matched against.
 *
 * The matching rule is deliberately conservative, and the reason is a §18
 * failure mode: a candidate marked `rediscovery` is routed away from
 * verification, so a *wrong* rediscovery is a silent recall loss — the worst
 * outcome for a tool whose MVP bar is recall. Therefore a match requires a
 * concrete textual signal (the file path, or a symbol the program model knows
 * about). A shared CWE is recorded as supporting context but is **never
 * sufficient on its own**: many unrelated bugs share a class.
 */

export interface KnownVulnRecord {
  vulnId: string
  aliases: string[]
  summary: string | null
  /** Long advisory prose, when the record carries it. */
  details?: string | null
}

export interface RediscoveryMatch {
  vulnId: string
  /** Which concrete signals matched, for audit. Never empty. */
  signals: string[]
  /** Human-readable one-liner recorded on the candidate. */
  basis: string
}

/**
 * Identifiers that look like calls in a snippet, used only when the program
 * model has nothing for the enclosing function. Project-specific names are what
 * an advisory is likely to mention; common language and libc names are
 * excluded so `strcpy` in a summary cannot by itself mark a rediscovery.
 */
const NOISE_SYMBOLS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'defined',
  'printf', 'fprintf', 'sprintf', 'snprintf', 'malloc', 'calloc', 'realloc',
  'free', 'memcpy', 'memset', 'strlen', 'strcpy', 'strncpy', 'strcmp',
  'strcat', 'fopen', 'fclose', 'fread', 'fwrite', 'assert', 'abort', 'exit',
])

export const symbolsFromSnippet = (snippet: string | null): string[] => {
  if (!snippet) return []
  const found = new Set<string>()
  const pattern = /([A-Za-z_][A-Za-z0-9_]{3,})\s*\(/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(snippet)) !== null) {
    const name = match[1]!
    if (!NOISE_SYMBOLS.has(name)) found.add(name)
  }
  return [...found]
}

/** Below this length a bare basename is too generic to mean anything. */
const MIN_BARE_BASENAME_CHARS = 6

const basenameOf = (filePath: string): string =>
  filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath

export interface FindRediscoveryInput {
  filePath: string | null
  cwe: string | null
  /** Project symbols, ideally from the symbol index rather than the snippet. */
  symbols: readonly string[]
  records: readonly KnownVulnRecord[]
}

const searchableText = (record: KnownVulnRecord): string =>
  [record.vulnId, ...record.aliases, record.summary ?? '', record.details ?? '']
    .join(' ')
    .toLowerCase()

const appearsAsWord = (haystack: string, needle: string): boolean => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(haystack)
}

/**
 * Find the first known vulnerability a candidate appears to rediscover.
 *
 * The path check is deliberately stricter than a bare `includes`: a full
 * relative path (with a directory) is distinctive, and a bare basename is only
 * used when it is long enough to be specific — otherwise `a.c` would match half
 * the advisories in the database.
 */
export const findRediscovery = (
  input: FindRediscoveryInput,
): RediscoveryMatch | null => {
  if (!input.filePath || input.records.length === 0) return null

  const normalizedPath = input.filePath.toLowerCase().replace(/^\.\//, '')
  const basename = basenameOf(normalizedPath)

  for (const record of input.records) {
    const text = searchableText(record)
    const signals: string[] = []

    // A full relative path is distinctive on its own; a bare basename is only
    // used when it is long enough to be specific. The signal names which form
    // actually matched, so the audit record is not misleading.
    const hasDirectory = normalizedPath.includes('/')
    const pathForm = hasDirectory
      ? normalizedPath
      : basename.length >= MIN_BARE_BASENAME_CHARS
        ? basename
        : null

    if (pathForm !== null && appearsAsWord(text, pathForm)) {
      signals.push(`${hasDirectory ? 'file-path' : 'basename'}:${pathForm}`)
    }

    for (const symbol of input.symbols) {
      if (symbol.length < 4) continue
      if (appearsAsWord(text, symbol.toLowerCase())) {
        signals.push(`symbol:${symbol}`)
      }
    }

    if (signals.length > 0) {
      const classNote = input.cwe ? ` (class ${input.cwe})` : ''
      return {
        vulnId: record.vulnId,
        signals,
        basis: `mentioned in ${record.vulnId}${classNote}: ${signals.join(', ')}`,
      }
    }
  }

  return null
}

/** Map `osv_matches` rows (via their stored raw record) into the shape above. */
export const knownVulnFromRow = (row: {
  vuln_id: string
  aliases_json: string | null
  summary: string | null
  raw_json: string | null
}): KnownVulnRecord => {
  let aliases: string[] = []
  try {
    const parsed: unknown = row.aliases_json ? JSON.parse(row.aliases_json) : []
    if (Array.isArray(parsed)) {
      aliases = parsed.filter((alias): alias is string => typeof alias === 'string')
    }
  } catch {
    aliases = []
  }

  let details: string | null = null
  try {
    const raw: unknown = row.raw_json ? JSON.parse(row.raw_json) : null
    if (raw && typeof raw === 'object' && typeof (raw as { details?: unknown }).details === 'string') {
      details = (raw as { details: string }).details
    }
  } catch {
    details = null
  }

  return { vulnId: row.vuln_id, aliases, summary: row.summary, details }
}
