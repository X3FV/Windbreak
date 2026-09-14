import { OSV_QUERYABLE_ECOSYSTEMS } from './types'

import type { Dependency } from './types'

/**
 * Manifest → dependency parsing (spec §4.2, lookup 1).
 *
 * Only lockfiles and pinned manifests are parsed. A range (`^1.2.3`, `>=1.0`)
 * cannot be resolved to the version actually installed, and OSV matches on an
 * exact version — querying a range would produce either a false negative or a
 * false positive, so those manifests are reported as unsupported with the
 * reason rather than guessed at.
 */

export interface DependencyParseResult {
  dependencies: Dependency[]
  /** Set when the manifest could not be parsed at all. */
  reason?: string
}

export type ManifestParser = (
  content: string,
  manifestPath: string,
) => DependencyParseResult

const dep = (
  fields: Omit<Dependency, 'queryable' | 'reason' | 'manifestPath'>,
  manifestPath: string,
): Dependency => {
  const queryable = OSV_QUERYABLE_ECOSYSTEMS.has(fields.ecosystem)

  return {
    ...fields,
    manifestPath,
    queryable,
    ...(queryable
      ? {}
      : { reason: `"${fields.ecosystem}" is not an OSV ecosystem` }),
  }
}

const parseJson = (
  content: string,
): { value: unknown } | { reason: string } => {
  try {
    return { value: JSON.parse(content) }
  } catch {
    return { reason: 'not valid JSON' }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** `node_modules/a/node_modules/@scope/b` -> `@scope/b` */
export const packageNameFromNodeModulesKey = (key: string): string => {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  return index === -1 ? key : key.slice(index + marker.length)
}

const parseNpmLock: ManifestParser = (content, manifestPath) => {
  const parsed = parseJson(content)
  if ('reason' in parsed) return { dependencies: [], reason: parsed.reason }
  if (!isRecord(parsed.value)) {
    return { dependencies: [], reason: 'unexpected lockfile shape' }
  }

  const dependencies: Dependency[] = []
  const seen = new Set<string>()

  const push = (name: string, version: unknown): void => {
    if (typeof version !== 'string' || version.length === 0) return
    // Lockfile versions can carry a wrapper; strip anything non-version.
    const clean = version.replace(/^[^\d]*/, '')
    if (clean.length === 0) return
    const key = `${name}@${clean}`
    if (seen.has(key)) return
    seen.add(key)
    dependencies.push(
      dep(
        { ecosystem: 'npm', name, version: clean, exact: true },
        manifestPath,
      ),
    )
  }

  const packages = parsed.value.packages
  if (isRecord(packages)) {
    for (const [key, value] of Object.entries(packages)) {
      // Workspace roots have no node_modules segment and are the project itself.
      if (!key.includes('node_modules/') || !isRecord(value)) continue
      push(packageNameFromNodeModulesKey(key), value.version)
    }
    return { dependencies }
  }

  // Lockfile v1: a nested dependency tree.
  const walk = (tree: unknown): void => {
    if (!isRecord(tree)) return
    for (const [name, value] of Object.entries(tree)) {
      if (!isRecord(value)) continue
      push(name, value.version)
      walk(value.dependencies)
    }
  }
  walk(parsed.value.dependencies)

  return { dependencies }
}

/** Normalise a PyPI name the way the index does: lowercased, runs collapsed. */
export const normalizePyPiName = (name: string): string =>
  name.trim().toLowerCase().replace(/[._]+/g, '-')

const REQUIREMENT_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(===|==|~=|>=|<=|!=|>|<)?\s*([^\s;\\]*)/

const parseRequirements: ManifestParser = (content, manifestPath) => {
  const dependencies: Dependency[] = []

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? ''
    if (line.length === 0 || line.startsWith('-')) continue

    const match = REQUIREMENT_PATTERN.exec(line)
    if (!match) continue

    const name = match[1]!
    const operator = match[2]
    const version = match[3] ?? ''
    const exact = operator === '==' || operator === '==='

    dependencies.push(
      dep(
        {
          ecosystem: 'PyPI',
          name: normalizePyPiName(name),
          version: exact ? version : version || 'unpinned',
          exact,
        },
        manifestPath,
      ),
    )
  }

  return { dependencies }
}

const parseCargoLock: ManifestParser = (content, manifestPath) => {
  const dependencies: Dependency[] = []
  let name: string | null = null
  let version: string | null = null

  const flush = (): void => {
    if (name && version) {
      dependencies.push(
        dep(
          { ecosystem: 'crates.io', name, version, exact: true },
          manifestPath,
        ),
      )
    }
    name = null
    version = null
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '[[package]]') {
      flush()
      continue
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(line)
    if (nameMatch) {
      name = nameMatch[1]!
      continue
    }
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(line)
    if (versionMatch) version = versionMatch[1]!
  }
  flush()

  return { dependencies }
}

const parseGoMod: ManifestParser = (content, manifestPath) => {
  const dependencies: Dependency[] = []
  let inRequireBlock = false

  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('//')[0]?.trim() ?? ''
    if (line.length === 0) continue

    if (line.startsWith('require (')) {
      inRequireBlock = true
      continue
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false
      continue
    }

    const single = /^require\s+(\S+)\s+(v\S+)/.exec(line)
    if (single) {
      dependencies.push(
        dep(
          { ecosystem: 'Go', name: single[1]!, version: single[2]!, exact: true },
          manifestPath,
        ),
      )
      continue
    }

    if (inRequireBlock) {
      const entry = /^(\S+)\s+(v\S+)/.exec(line)
      if (entry) {
        dependencies.push(
          dep(
            { ecosystem: 'Go', name: entry[1]!, version: entry[2]!, exact: true },
            manifestPath,
          ),
        )
      }
    }
  }

  return { dependencies }
}

/**
 * pkg-config `.pc` files.
 *
 * Parsed, but deliberately **not queryable**: OSV has no `pkg-config`
 * ecosystem, and a `.pc` `Name:` is an upstream project, not a distribution
 * package. C/C++ library correlation therefore needs distro package mapping
 * that WindBreak does not do yet — recording the dependency with a reason is
 * more useful than dropping it silently.
 */
const parsePkgConfig: ManifestParser = (content, manifestPath) => {
  let name: string | null = null
  let version: string | null = null

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const nameMatch = /^Name:\s*(.+)$/.exec(line)
    if (nameMatch) name = nameMatch[1]!.trim()
    const versionMatch = /^Version:\s*(.+)$/.exec(line)
    if (versionMatch) version = versionMatch[1]!.trim()
  }

  if (!name) return { dependencies: [], reason: 'no Name: field' }

  return {
    dependencies: [
      {
        ecosystem: 'pkg-config',
        name,
        version: version ?? 'unknown',
        exact: version !== null,
        manifestPath,
        queryable: false,
        reason: 'pkg-config is not an OSV ecosystem; upstream libraries need distro package mapping',
      },
    ],
  }
}

const parseGemfileLock: ManifestParser = (content, manifestPath) => {
  const dependencies: Dependency[] = []
  let inSpecs = false

  for (const rawLine of content.split('\n')) {
    if (/^\s{2}specs:/.test(rawLine)) {
      inSpecs = true
      continue
    }
    // Leaving the specs section: any non-indented line ends it.
    if (inSpecs && rawLine.length > 0 && !/^\s/.test(rawLine)) {
      inSpecs = false
      continue
    }
    if (!inSpecs) continue

    // `    rails (6.1.0)` — a dependency line is indented 4, sub-deps 6.
    const match = /^ {4}(\S+) \(([^)]+)\)\s*$/.exec(rawLine)
    if (match) {
      dependencies.push(
        dep(
          { ecosystem: 'RubyGems', name: match[1]!, version: match[2]!, exact: true },
          manifestPath,
        ),
      )
    }
  }

  return { dependencies }
}

const parseComposerLock: ManifestParser = (content, manifestPath) => {
  const parsed = parseJson(content)
  if ('reason' in parsed) return { dependencies: [], reason: parsed.reason }
  if (!isRecord(parsed.value)) {
    return { dependencies: [], reason: 'unexpected lockfile shape' }
  }

  const dependencies: Dependency[] = []
  for (const section of ['packages', 'packages-dev']) {
    const entries = parsed.value[section]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const name = entry.name
      const version = entry.version
      if (typeof name !== 'string' || typeof version !== 'string') continue
      dependencies.push(
        dep(
          {
            ecosystem: 'Packagist',
            name,
            version: version.replace(/^v(?=\d)/, ''),
            exact: true,
          },
          manifestPath,
        ),
      )
    }
  }

  return { dependencies }
}

const parsePipfileLock: ManifestParser = (content, manifestPath) => {
  const parsed = parseJson(content)
  if ('reason' in parsed) return { dependencies: [], reason: parsed.reason }
  if (!isRecord(parsed.value)) {
    return { dependencies: [], reason: 'unexpected lockfile shape' }
  }

  const dependencies: Dependency[] = []
  for (const section of ['default', 'develop']) {
    const entries = parsed.value[section]
    if (!isRecord(entries)) continue
    for (const [name, value] of Object.entries(entries)) {
      if (!isRecord(value)) continue
      const raw = value.version
      if (typeof raw !== 'string') continue
      const exact = raw.startsWith('==')
      dependencies.push(
        dep(
          {
            ecosystem: 'PyPI',
            name: normalizePyPiName(name),
            version: raw.replace(/^=+/, '') || 'unpinned',
            exact,
          },
          manifestPath,
        ),
      )
    }
  }

  return { dependencies }
}

const parsePomXml: ManifestParser = (content, manifestPath) => {
  const dependencies: Dependency[] = []

  const blocks = content.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []
  for (const block of blocks) {
    const group = /<groupId>([^<]+)<\/groupId>/.exec(block)?.[1]?.trim()
    const artifact = /<artifactId>([^<]+)<\/artifactId>/.exec(block)?.[1]?.trim()
    const version = /<version>([^<]+)<\/version>/.exec(block)?.[1]?.trim()

    if (!group || !artifact) continue
    // `${...}` is a property reference; the real version is not in this file.
    const resolved =
      version && !version.includes('${') ? version : 'unpinned'

    dependencies.push(
      dep(
        {
          ecosystem: 'Maven',
          name: `${group}:${artifact}`,
          version: resolved,
          exact: version !== undefined && !version.includes('${'),
        },
        manifestPath,
      ),
    )
  }

  return {
    dependencies,
    ...(dependencies.length === 0 ? { reason: 'no <dependency> blocks found' } : {}),
  }
}

const unsupported = (reason: string): ManifestParser => () => ({
  dependencies: [],
  reason,
})

const RANGE_REASON =
  'pins version ranges, not exact versions; OSV matches exact versions only'

export const MANIFEST_PARSERS: Record<string, ManifestParser> = {
  'npm-lock': parseNpmLock,
  'pip-requirements': parseRequirements,
  'cargo-lock': parseCargoLock,
  'go-mod': parseGoMod,
  'pkg-config': parsePkgConfig,
  bundler: parseGemfileLock,
  composer: parseComposerLock,
  pipfile: parsePipfileLock,
  maven: parsePomXml,

  npm: unsupported(RANGE_REASON),
  cargo: unsupported(RANGE_REASON),
  pyproject: unsupported(RANGE_REASON),
  setuptools: unsupported('dependency versions are computed at build time'),
  'yarn-lock': unsupported('yarn.lock parsing is not implemented yet'),
  'pnpm-lock': unsupported('pnpm-lock.yaml parsing is not implemented yet'),
  'go-sum': unsupported('redundant with go.mod'),
  gemspec: unsupported(RANGE_REASON),
  gradle: unsupported('dependency versions are resolved by Gradle'),
  vcpkg: unsupported('vcpkg has no OSV ecosystem'),
  conan: unsupported('Conan has no OSV ecosystem'),
}

export interface ParseManifestInput {
  /** Manifest path relative to the target root. */
  path: string
  type: string
  content: string
}

/**
 * `Pipfile` and `Gemfile` are the unlocked counterparts of `Pipfile.lock` and
 * `Gemfile.lock`; the locator reports both under one type, so the extension
 * decides whether a parser applies.
 */
export const parseManifest = (
  input: ParseManifestInput,
): DependencyParseResult => {
  const fileName = input.path.slice(input.path.lastIndexOf('/') + 1)

  if (
    (input.type === 'pipfile' || input.type === 'bundler' || input.type === 'composer') &&
    !fileName.endsWith('.lock')
  ) {
    return { dependencies: [], reason: RANGE_REASON }
  }

  const parser = MANIFEST_PARSERS[input.type]
  if (!parser) {
    return { dependencies: [], reason: `no parser for manifest type "${input.type}"` }
  }

  return parser(input.content, input.path)
}

/** Collapse duplicates across manifests, keeping the first occurrence. */
export const dedupeDependencies = (
  dependencies: readonly Dependency[],
): Dependency[] => {
  const seen = new Set<string>()
  const unique: Dependency[] = []

  for (const dependency of dependencies) {
    const key = `${dependency.ecosystem}:${dependency.name}:${dependency.version}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(dependency)
  }

  return unique
}
