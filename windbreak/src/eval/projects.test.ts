import { describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  loadProjectRegistry,
  parseProjectRegistry,
  PROJECT_REGISTRY_VERSION,
  ProjectRegistryError,
  resolveProject,
  SHIPPED_PROJECTS,
  UnknownProjectError,
} from './projects'

const writeRegistry = (contents: unknown): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-projects-'))
  const file = path.join(dir, 'projects.json')
  fs.writeFileSync(file, JSON.stringify(contents))
  return file
}

describe('parseProjectRegistry', () => {
  test('reads a versioned map of names to remotes', () => {
    const registry = parseProjectRegistry({
      version: PROJECT_REGISTRY_VERSION,
      projects: { mine: { repo: 'https://example.test/mine.git', note: 'private mirror' } },
    })

    expect(registry.get('mine')).toEqual({
      repo: 'https://example.test/mine.git',
      note: 'private mirror',
    })
  })

  test('a misspelled key is refused rather than leaving the project with no remote', () => {
    // `url` for `repo` is the error that would otherwise pass unnoticed: the entry
    // would exist and resolve to `undefined`, and the failure would surface as a git
    // error several steps later, pointing at the wrong file.
    expect(() =>
      parseProjectRegistry({
        version: PROJECT_REGISTRY_VERSION,
        projects: { mine: { url: 'https://example.test/mine.git' } },
      }),
    ).toThrow(/unknown key\(s\): url/)
  })

  test('a wrong version is refused by number', () => {
    expect(() =>
      parseProjectRegistry({ version: 99, projects: {} }),
    ).toThrow(/version 99 is not the version this build reads/)
  })

  test('an unknown top-level key is refused', () => {
    expect(() =>
      parseProjectRegistry({ version: PROJECT_REGISTRY_VERSION, projects: {}, extra: true }),
    ).toThrow(/unknown top-level key\(s\): extra/)
  })

  test('a non-object projects value is refused', () => {
    expect(() =>
      parseProjectRegistry({ version: PROJECT_REGISTRY_VERSION, projects: ['libarchive'] }),
    ).toThrow(/"projects" must be an object/)
  })

  test('an entry with no repo is refused', () => {
    expect(() =>
      parseProjectRegistry({ version: PROJECT_REGISTRY_VERSION, projects: { mine: {} } }),
    ).toThrow(/project "mine" has no "repo" string/)
  })

  test('a blank repo is refused, because an empty URL is not a URL', () => {
    expect(() =>
      parseProjectRegistry({
        version: PROJECT_REGISTRY_VERSION,
        projects: { mine: { repo: '   ' } },
      }),
    ).toThrow(/project "mine" has no "repo" string/)
  })
})

describe('loadProjectRegistry', () => {
  test('without a file it is the shipped map', () => {
    const registry = loadProjectRegistry()
    expect(registry.get('libarchive')).toEqual(SHIPPED_PROJECTS.libarchive!)
  })

  test('a user file adds to the shipped map', () => {
    const file = writeRegistry({
      version: PROJECT_REGISTRY_VERSION,
      projects: { mine: { repo: 'https://example.test/mine.git' } },
    })

    const registry = loadProjectRegistry(file)

    expect(registry.get('mine')?.repo).toBe('https://example.test/mine.git')
    // Adding, not replacing: a private list is usually the public projects plus its
    // own, so dropping the shipped entries would break the common case.
    expect(registry.get('libarchive')?.repo).toBe(SHIPPED_PROJECTS.libarchive!.repo)
  })

  test('a user entry overrides a shipped one, so a fork or a mirror can be used', () => {
    const file = writeRegistry({
      version: PROJECT_REGISTRY_VERSION,
      projects: { libarchive: { repo: 'https://mirror.test/libarchive.git' } },
    })

    const registry = loadProjectRegistry(file)

    expect(registry.get('libarchive')?.repo).toBe('https://mirror.test/libarchive.git')
  })

  test('a missing file is refused by path', () => {
    expect(() => loadProjectRegistry('/nonexistent/projects.json')).toThrow(
      /Could not read the project registry/,
    )
  })

  test('a non-JSON file is refused by path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-projects-'))
    const file = path.join(dir, 'projects.json')
    fs.writeFileSync(file, '{ not json')

    expect(() => loadProjectRegistry(file)).toThrow(/is not valid JSON/)
  })

  test('a malformed user file throws ProjectRegistryError, not a bare Error', () => {
    const file = writeRegistry({ version: 2, projects: {} })
    expect(() => loadProjectRegistry(file)).toThrow(ProjectRegistryError)
  })
})

describe('resolveProject', () => {
  test('resolves a shipped project and marks its source', () => {
    const resolved = resolveProject({ project: 'curl' })
    expect(resolved.repo).toBe(SHIPPED_PROJECTS.curl!.repo)
    expect(resolved.source).toBe('shipped')
  })

  test('marks an override as user-sourced', () => {
    const registry = loadProjectRegistry(
      writeRegistry({
        version: PROJECT_REGISTRY_VERSION,
        projects: { libarchive: { repo: 'https://mirror.test/libarchive.git' } },
      }),
    )

    const resolved = resolveProject({ project: 'libarchive', registry })
    expect(resolved.repo).toBe('https://mirror.test/libarchive.git')
    expect(resolved.source).toBe('user')
  })

  test('an unknown project is refused by name, and the known ones are listed', () => {
    // Deriving `https://github.com/<name>/<name>.git` would either 404 or resolve to
    // a fork, and a fork's history changes what §4.4.1 and §4.4.3 mine. So this
    // refusal *is* the feature.
    let message = ''
    try {
      resolveProject({
        project: 'not-a-project',
        registry: new Map([['only', { repo: 'https://example.test/only.git' }]]),
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('No remote is recorded for project "not-a-project"')
    expect(message).toContain('Known projects: only')
    expect(() =>
      resolveProject({ project: 'not-a-project', registry: new Map() }),
    ).toThrow(UnknownProjectError)
  })
})
