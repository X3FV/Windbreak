import { LANGUAGE_QUERIES } from './queries'

export interface LanguageDefinition {
  /** Language id, as reported in the inventory and the Target record. */
  id: string
  extensions: string[]
  kind: 'programming' | 'markup' | 'data' | 'build'
}

/**
 * Languages WindBreak can build a program model for.
 *
 * This used to be C and C++ only, with everything else detected-and-counted but
 * reported unsupported. The ten entries below are exactly the ten wasm grammars
 * `@vscode/tree-sitter-wasm` ships, so the widening cost no new dependency —
 * only queries. A language whose query is missing still has no entry here, which
 * is what `unsupportedLanguages` reports.
 *
 * The map is `LANGUAGE_QUERIES` itself rather than a copy: two lists of the same
 * thing is how a language ends up registered in one and absent from the other,
 * and the failure that produces is an empty symbol index that reads as clean.
 */
export const PROGRAM_MODEL_LANGUAGES = LANGUAGE_QUERIES

export const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  {
    id: 'c',
    // `.h` is ambiguous between C and C++. It is mapped to C, the more common
    // case for the Phase 1 targets; a C++ header misclassified here still parses
    // with the same grammar, so only the label is affected.
    extensions: ['.c', '.h'],
    kind: 'programming',
  },
  {
    id: 'cpp',
    extensions: ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++'],
    kind: 'programming',
  },
  { id: 'rust', extensions: ['.rs'], kind: 'programming' },
  { id: 'go', extensions: ['.go'], kind: 'programming' },
  { id: 'python', extensions: ['.py'], kind: 'programming' },
  {
    id: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    kind: 'programming',
  },
  // `.tsx` used to share this entry. It is a *separate grammar*, not a mode —
  // the JSX productions change how `<` parses — so a `.tsx` file parsed with
  // the TypeScript grammar reports an error on every component. The split is
  // the whole of the fix.
  { id: 'typescript', extensions: ['.ts'], kind: 'programming' },
  { id: 'tsx', extensions: ['.tsx'], kind: 'programming' },
  { id: 'java', extensions: ['.java'], kind: 'programming' },
  { id: 'ruby', extensions: ['.rb'], kind: 'programming' },
  { id: 'csharp', extensions: ['.cs'], kind: 'programming' },
  { id: 'php', extensions: ['.php'], kind: 'programming' },
  { id: 'shell', extensions: ['.sh', '.bash', '.zsh'], kind: 'programming' },
  { id: 'assembly', extensions: ['.s', '.S', '.asm'], kind: 'programming' },

  { id: 'cmake', extensions: ['.cmake'], kind: 'build' },
  { id: 'make', extensions: ['.mk', '.mak'], kind: 'build' },

  { id: 'markdown', extensions: ['.md', '.markdown'], kind: 'markup' },
  { id: 'json', extensions: ['.json'], kind: 'data' },
  { id: 'yaml', extensions: ['.yaml', '.yml'], kind: 'data' },
  { id: 'toml', extensions: ['.toml'], kind: 'data' },
  { id: 'xml', extensions: ['.xml'], kind: 'data' },
  { id: 'patch', extensions: ['.patch', '.diff'], kind: 'data' },
]

const EXTENSION_INDEX = new Map<string, LanguageDefinition>()
for (const definition of LANGUAGE_DEFINITIONS) {
  for (const extension of definition.extensions) {
    EXTENSION_INDEX.set(extension, definition)
  }
}

/** Lowercased extension of a path, including the dot. */
export const extensionOf = (filePath: string): string => {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/**
 * Language id for a path, or null when the extension is unrecognised.
 *
 * `.S` (preprocessed assembly) is matched case-sensitively before the lowercase
 * lookup so it is not confused with `.s`.
 */
export const detectLanguage = (filePath: string): string | null => {
  if (filePath.endsWith('.S')) return 'assembly'
  return EXTENSION_INDEX.get(extensionOf(filePath))?.id ?? null
}

export const isProgramModelLanguage = (language: string | null): boolean =>
  language !== null && language in PROGRAM_MODEL_LANGUAGES

const PROGRAMMING_LANGUAGES = new Set(
  LANGUAGE_DEFINITIONS.filter((definition) => definition.kind === 'programming').map(
    (definition) => definition.id,
  ),
)

/**
 * Detected programming languages the program model has no query for.
 *
 * Covers PHP, shell and assembly today. Returned as a *set of ids* rather than a
 * per-file count so the caller can report which languages are missing rather
 * than only how many files: "4,912 files unsupported" is not actionable, and
 * "php, shell" is.
 */
export const unsupportedProgramLanguages = (
  languages: Iterable<string | null>,
): string[] => {
  const missing = new Set<string>()
  for (const language of languages) {
    if (language === null) continue
    if (PROGRAMMING_LANGUAGES.has(language) && !isProgramModelLanguage(language)) {
      missing.add(language)
    }
  }
  return [...missing].sort()
}

export interface LanguageInventory {
  language: string
  fileCount: number
  bytes: number
}

export interface LanguageCountInput {
  path: string
  bytes: number
}

/**
 * Aggregate an inventory into a language breakdown, largest first.
 *
 * Files with no recognised language are collected under `other` so the counts
 * always add up to the file total — an inventory that silently drops files is
 * how a "no sources found" bug goes unnoticed.
 */
export const detectLanguages = (
  files: readonly LanguageCountInput[],
): LanguageInventory[] => {
  const byLanguage = new Map<string, LanguageInventory>()

  for (const file of files) {
    const language = detectLanguage(file.path) ?? 'other'
    const entry = byLanguage.get(language) ?? {
      language,
      fileCount: 0,
      bytes: 0,
    }
    entry.fileCount += 1
    entry.bytes += file.bytes
    byLanguage.set(language, entry)
  }

  return [...byLanguage.values()].sort(
    (a, b) => b.fileCount - a.fileCount || a.language.localeCompare(b.language),
  )
}
