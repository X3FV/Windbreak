export {
  collectInventory,
  BINARY_EXTENSIONS,
  DEFAULT_MAX_FILES,
  IGNORED_DIRECTORIES,
  looksBinary,
} from './inventory'
export type {
  CollectInventoryOptions,
  FileEntry,
  Inventory,
} from './inventory'

export {
  detectLanguage,
  detectLanguages,
  extensionOf,
  isProgramModelLanguage,
  LANGUAGE_DEFINITIONS,
  PROGRAM_MODEL_LANGUAGES,
} from './languages'
export type {
  LanguageDefinition,
  LanguageInventory,
} from './languages'

export { classifyManifest, findManifests } from './deps'
export type { ManifestRef } from './deps'

export { checkDirty, readGitRefs } from './git'
export type { GitState, ReadGitRefsResult } from './git'

export { loadGrammar, parseSource, splitQualifiedName } from './parser'
export type {
  ParsedFile,
  ParsedReference,
  ParsedSymbol,
  SymbolKind,
} from './parser'

export {
  buildProgramModel,
  DEFAULT_MAX_FILES_TO_PARSE,
  DEFAULT_MAX_PARSE_FILE_BYTES,
} from './program-model'
export type {
  ProgramModelOptions,
  ProgramModelResult,
} from './program-model'

export {
  createSandboxGitRunner,
  createTargetId,
  inferScopeClass,
  runRecon,
} from './run'
export type {
  BuildModel,
  BuildSummary,
  ReconRequest,
  ReconResult,
  ReconServices,
  RunReconOptions,
  ScopeClass,
  TargetRecord,
} from './run'

export { CPP_QUERY, C_QUERY } from './queries'
