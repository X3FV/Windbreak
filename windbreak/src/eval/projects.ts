/**
 * The project → clone-URL registry (spec §11.2, D22).
 *
 * A fixture is `{ project, commitSha, bugs }` and nothing else. §11.2's entry is a
 * *list of pre-fix commits*, not a list of remotes, and keeping the URL out of it is
 * what lets one private list be read on a machine whose checkouts live somewhere
 * else. The URL still has to come from somewhere, and this is that somewhere: one
 * map, in-repo, so that a fixture's `project` string does not quietly carry a network
 * destination around with it.
 *
 * ## Refusing an unknown project is the point
 *
 * The alternative — deriving `https://github.com/<project>/<project>.git` — has no
 * failure mode that is merely inconvenient. A guessed remote either 404s with a
 * message about a URL nobody wrote down, or it resolves to a *fork*, and a fork's
 * history is not the upstream history: §4.4.1 patch-mines fix commits and §4.4.3
 * mines atomicity rules out of lock-adding patches, so the wrong clone silently
 * changes which patterns exist before a single candidate is produced. A missing
 * entry is therefore an error naming the project, not a default.
 *
 * ## Why the shipped map is short, and why `--projects` exists
 *
 * The shipped entries are the public remotes for the projects the example list in
 * `docs/eval-fixtures.example.json` names. Any real fixture set will name projects
 * that are not here, and the alternative to a second file is editing this one — so
 * `loadProjectRegistry` reads a user file whose entries *override* the shipped map
 * rather than replacing it. Overriding, because a private list is usually an
 * addition to the public projects, not a replacement for them.
 */

import fs from 'fs'

/** The registry file format this build reads. An unknown version is refused. */
export const PROJECT_REGISTRY_VERSION = 1

export interface FixtureProject {
  /**
   * The clone URL. `git clone` accepts a URL or a local path here, which is what
   * lets the tests fetch from a `file://` remote without a network.
   */
  repo: string
  /** Why this remote, when it is not self-evident. Carried into the report. */
  note?: string
}

/**
 * The remotes the shipped example fixture list names, plus the obvious neighbours.
 *
 * Deliberately short. A long map would be a claim about which projects matter, and
 * this file cannot make that claim; it can only say where the repositories named by
 * the example list live.
 */
export const SHIPPED_PROJECTS: Readonly<Record<string, FixtureProject>> = {
  libarchive: { repo: 'https://github.com/libarchive/libarchive.git' },
  curl: { repo: 'https://github.com/curl/curl.git' },
  openssl: { repo: 'https://github.com/openssl/openssl.git' },
  libxml2: { repo: 'https://github.com/GNOME/libxml2.git' },
}

export class ProjectRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectRegistryError'
  }
}

const entrySchema = (project: string, value: unknown): FixtureProject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectRegistryError(
      `project "${project}" must map to an object with a "repo" string`,
    )
  }

  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => key !== 'repo' && key !== 'note')
  if (unknown.length > 0) {
    // A misspelled key is the error that would otherwise pass unnoticed: `url`
    // instead of `repo` would leave the project with no remote at all, and the
    // refusal would point at the project rather than at the typo.
    throw new ProjectRegistryError(
      `project "${project}" has unknown key(s): ${unknown.join(', ')} (expected "repo" and optional "note")`,
    )
  }

  if (typeof record.repo !== 'string' || record.repo.trim().length === 0) {
    throw new ProjectRegistryError(`project "${project}" has no "repo" string`)
  }
  if (record.note !== undefined && typeof record.note !== 'string') {
    throw new ProjectRegistryError(`project "${project}" has a non-string "note"`)
  }

  return {
    repo: record.repo.trim(),
    ...(typeof record.note === 'string' ? { note: record.note } : {}),
  }
}

/**
 * Parse a user registry file.
 *
 * The shape is checked strictly for the same reason the fixture schema is (§11.2):
 * a registry that half-parses produces a fetch against a project's *name* as if it
 * were a URL, and the failure surfaces as a git error several steps later.
 */
export const parseProjectRegistry = (input: unknown): Map<string, FixtureProject> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectRegistryError('a project registry must be a JSON object')
  }

  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => key !== 'version' && key !== 'projects')
  if (unknown.length > 0) {
    throw new ProjectRegistryError(
      `unknown top-level key(s): ${unknown.join(', ')} (expected "version" and "projects")`,
    )
  }

  if (record.version !== PROJECT_REGISTRY_VERSION) {
    throw new ProjectRegistryError(
      `version ${String(record.version)} is not the version this build reads ` +
        `(${PROJECT_REGISTRY_VERSION})`,
    )
  }

  const projects = record.projects
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) {
    throw new ProjectRegistryError('"projects" must be an object mapping names to remotes')
  }

  const parsed = new Map<string, FixtureProject>()
  for (const [project, value] of Object.entries(projects as Record<string, unknown>)) {
    if (project.length === 0) {
      throw new ProjectRegistryError('a project name cannot be empty')
    }
    parsed.set(project, entrySchema(project, value))
  }

  return parsed
}

/**
 * The shipped map, plus a user file's entries when one was supplied.
 *
 * Read synchronously because every other data file in this project is read that way
 * at command start (`engines/rules.ts` resolves rule paths the same way), and a
 * registry read halfway through a fetch would be a worse shape than a slow start.
 */
export const loadProjectRegistry = (
  filePath?: string,
): Map<string, FixtureProject> => {
  const registry = new Map<string, FixtureProject>(Object.entries(SHIPPED_PROJECTS))

  if (filePath === undefined) return registry

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new ProjectRegistryError(
      `Could not read the project registry ${filePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ProjectRegistryError(
      `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  for (const [project, entry] of parseProjectRegistry(parsed)) {
    registry.set(project, entry)
  }

  return registry
}

export interface ProjectResolution {
  project: string
  repo: string
  source: 'shipped' | 'user'
  note: string | null
}

export class UnknownProjectError extends Error {
  constructor(project: string, known: readonly string[]) {
    super(
      `No remote is recorded for project "${project}". A fixture names a project, ` +
        'not a URL, so the fetch needs a registry entry rather than deriving a URL ' +
        `from the name. Known projects: ${known.length > 0 ? known.join(', ') : '(none)'}.`,
    )
    this.name = 'UnknownProjectError'
  }
}

/** Resolve a fixture's project to a clone URL, or refuse it by name. */
export const resolveProject = (input: {
  project: string
  registry?: ReadonlyMap<string, FixtureProject>
}): ProjectResolution => {
  const registry = input.registry ?? loadProjectRegistry()
  const entry = registry.get(input.project)

  if (entry === undefined) {
    throw new UnknownProjectError(input.project, [...registry.keys()].sort())
  }

  const shipped = SHIPPED_PROJECTS[input.project]
  return {
    project: input.project,
    repo: entry.repo,
    source: shipped !== undefined && shipped.repo === entry.repo ? 'shipped' : 'user',
    note: entry.note ?? null,
  }
}
