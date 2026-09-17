import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  conventionalConfigPath,
  conventionalDbPath,
  resolveScanSubject,
} from '../subject'

const created: string[] = []

const tempRepo = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-subject-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Write `<repo>/.windbreak/config.json`, returning its path. */
const writeConfig = (repo: string, config: unknown): string => {
  const dir = path.join(repo, '.windbreak')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify(config))
  return file
}

const resolve = (repoRoot: string, env: Record<string, string | undefined> = {}) => {
  const resolution = resolveScanSubject({ repoRoot, env })
  if (!resolution.ok) throw new Error(`expected a subject, got ${resolution.reason}`)
  return resolution.subject
}

describe('resolveScanSubject', () => {
  test('a checkout with no config scans itself into its own .windbreak', () => {
    const repo = tempRepo()
    const subject = resolve(repo)

    expect(subject.targetRoot).toBe(repo)
    expect(subject.dbPath).toBe(conventionalDbPath(repo))
    expect(subject.configPath).toBeNull()
    expect(subject.configuredTarget).toBeNull()
  })

  test('the configured database wins over the convention', () => {
    const repo = tempRepo()
    writeConfig(repo, { target: { db: 'elsewhere.db' } })

    // Resolved against the config's own directory — `<target>/.windbreak` — which is why
    // the conventional target is written `".."` in the target's config.
    expect(resolve(repo).dbPath).toBe(path.join(repo, '.windbreak', 'elsewhere.db'))
  })

  test('a config with no target section leaves the database where it was', () => {
    const repo = tempRepo()
    writeConfig(repo, { budget: { totalSeconds: 60 } })

    expect(resolve(repo).dbPath).toBe(conventionalDbPath(repo))
    expect(resolve(repo).configPath).toBe(conventionalConfigPath(repo))
  })

  test('the subject is the session\'s checkout even when the config names another', () => {
    const repo = tempRepo()
    const other = tempRepo()
    writeConfig(repo, { target: { location: other, db: path.join(other, 'state.db') } })

    const subject = resolve(repo)

    // The TUI knows which repository it is about, so it scans that one; `windbreak scan`
    // run bare follows the config instead, which is what the default exists for. The
    // difference is carried so the view can name it rather than hide it.
    expect(subject.targetRoot).toBe(repo)
    expect(subject.configuredTarget).toBe(other)
  })

  test('the config is looked for at the repository, not at the working directory', () => {
    const repo = tempRepo()
    writeConfig(repo, { target: { db: 'state.db' } })

    // The test process runs from the cli package, so a cwd-anchored lookup would find
    // nothing here — which is the point: the chat surface can be started in a subdirectory.
    expect(fs.existsSync(conventionalConfigPath(process.cwd()))).toBe(false)
    expect(resolve(repo).configPath).toBe(conventionalConfigPath(repo))
  })

  test('$WINDBREAK_CONFIG wins over the checkout\'s own file', () => {
    const repo = tempRepo()
    const other = tempRepo()
    writeConfig(repo, { target: { db: 'from-the-repo.db' } })
    const named = writeConfig(other, { target: { db: 'from-the-env.db' } })

    const subject = resolve(repo, { WINDBREAK_CONFIG: named })

    expect(subject.configPath).toBe(named)
    // The target stays the session's checkout: the variable names a config, not a subject.
    expect(subject.targetRoot).toBe(repo)
    expect(subject.dbPath).toBe(path.join(other, '.windbreak', 'from-the-env.db'))
  })

  test('a named config that is missing is a refusal, not a fallback', () => {
    const repo = tempRepo()
    writeConfig(repo, { target: { db: 'state.db' } })
    const missing = path.join(tempRepo(), 'nope.json')

    const resolution = resolveScanSubject({
      repoRoot: repo,
      env: { WINDBREAK_CONFIG: missing },
    })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('unreachable')
    // A typo has to be reported rather than silently scanning under the built-ins.
    expect(resolution.reason).toContain(missing)
  })

  test('a config that cannot be parsed is a refusal the view can print', () => {
    const repo = tempRepo()
    const dir = path.join(repo, '.windbreak')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json')

    const resolution = resolveScanSubject({ repoRoot: repo, env: {} })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('unreachable')
    expect(resolution.reason).toStartWith('could not read')
    expect(resolution.reason).toContain(path.join(repo, '.windbreak', 'config.json'))
  })
})
