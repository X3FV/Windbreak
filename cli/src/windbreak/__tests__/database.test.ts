import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { checkoutConfigPath, checkoutDatabasePath, configPathForScreen, resolveScreenDatabase } from '../database'

/**
 * Which database the screen opens (§20.33, §7.3).
 *
 * The rules are checked against a real filesystem and real config files rather than with a
 * mocked `loadConfig`: the thing under test is a *resolution order* over paths that have to
 * agree with what the batch commands read, and a mock would let the order be right while both
 * readers disagreed about the file.
 */

let repoRoot: string

/** A checkout with a `.windbreak`, which is what makes it look like a target. */
const makeRepo = (config?: unknown): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-screen-db-'))
  fs.mkdirSync(path.join(root, '.windbreak'), { recursive: true })

  if (config !== undefined) {
    fs.writeFileSync(path.join(root, '.windbreak', 'config.json'), JSON.stringify(config))
  }

  return root
}

beforeEach(() => {
  repoRoot = makeRepo()
})

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true })
})

/** Run with `$WINDBREAK_CONFIG` unset, so a developer's own environment cannot decide a test. */
const withoutEnvConfig = <T>(run: () => T): T => {
  const previous = process.env.WINDBREAK_CONFIG
  delete process.env.WINDBREAK_CONFIG

  try {
    return run()
  } finally {
    if (previous !== undefined) process.env.WINDBREAK_CONFIG = previous
  }
}

describe('resolveScreenDatabase', () => {
  test("with nothing configured it is the checkout's conventional database", () => {
    withoutEnvConfig(() => {
      expect(resolveScreenDatabase({ repoRoot })).toBe(
        path.join(repoRoot, '.windbreak', 'state.db'),
      )
    })
  })

  test('a configured database wins over the convention', () => {
    // The fix this module exists for: before it, the screen resolved the conventional path
    // only, so a checkout whose state had been moved opened an absent database and drew an
    // empty queue over the run sitting in the file it was told to use.
    const root = makeRepo({ target: { db: '/var/lib/windbreak/state.db' } })

    withoutEnvConfig(() => {
      expect(resolveScreenDatabase({ repoRoot: root })).toBe('/var/lib/windbreak/state.db')
    })

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a database configured as a relative path resolves against the config, not the caller', () => {
    // The rule `config.loadConfig` states for the batch side, checked here because the screen
    // has to agree with it: the config lives at `<target>/.windbreak/config.json`, so a
    // relative `db` is relative to `<target>/.windbreak` — which is why the conventional file
    // is written `".."` for `location` and `"state.db"` for `db`.
    const root = makeRepo({ target: { db: 'state.db' } })

    withoutEnvConfig(() => {
      expect(resolveScreenDatabase({ repoRoot: root })).toBe(
        path.join(root, '.windbreak', 'state.db'),
      )
      // The same file the convention would have chosen, so a config that spells out the
      // default changes nothing — which is what makes it safe to write down.
      expect(resolveScreenDatabase({ repoRoot: root })).toBe(checkoutDatabasePath(root))
    })

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('--db beats a configured database', () => {
    const root = makeRepo({ target: { db: '/var/lib/windbreak/state.db' } })

    withoutEnvConfig(() => {
      expect(resolveScreenDatabase({ named: '/tmp/explicit.db', repoRoot: root })).toBe(
        '/tmp/explicit.db',
      )
    })

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('a config naming no database leaves the convention in place', () => {
    // `null` is the absence of a default rather than a path, so a config that only sets models
    // must not be read as "state lives nowhere".
    const root = makeRepo({ budget: { totalSeconds: 60 } })

    withoutEnvConfig(() => {
      expect(resolveScreenDatabase({ repoRoot: root })).toBe(checkoutDatabasePath(root))
    })

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('the config is found at the repository root, not the working directory', () => {
    // The screen is opened from wherever the researcher is, and a configured database that
    // only worked when the command was typed at the checkout root would be worse than none:
    // it would work in the case the researcher tests and not in the one they use.
    const root = makeRepo({ target: { db: '/var/lib/windbreak/state.db' } })
    const nested = path.join(root, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    withoutEnvConfig(() => {
      expect(configPathForScreen({ repoRoot: root })).toBe(checkoutConfigPath(root))
      expect(resolveScreenDatabase({ repoRoot: root })).toBe('/var/lib/windbreak/state.db')
    })

    fs.rmSync(root, { recursive: true, force: true })
  })

  test('$WINDBREAK_CONFIG names the file outright', () => {
    const root = makeRepo({ target: { db: '/from/the/config.db' } })
    const elsewhere = path.join(repoRoot, 'elsewhere.json')
    fs.writeFileSync(elsewhere, JSON.stringify({ target: { db: '/from/the/env.db' } }))

    const previous = process.env.WINDBREAK_CONFIG
    process.env.WINDBREAK_CONFIG = elsewhere

    try {
      expect(resolveScreenDatabase({ repoRoot: root })).toBe('/from/the/env.db')
    } finally {
      if (previous === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('--config beats $WINDBREAK_CONFIG', () => {
    const named = path.join(repoRoot, 'named.json')
    const fromEnv = path.join(repoRoot, 'env.json')
    fs.writeFileSync(named, JSON.stringify({ target: { db: '/named.db' } }))
    fs.writeFileSync(fromEnv, JSON.stringify({ target: { db: '/env.db' } }))

    const previous = process.env.WINDBREAK_CONFIG
    process.env.WINDBREAK_CONFIG = fromEnv

    try {
      expect(resolveScreenDatabase({ configPath: named, repoRoot })).toBe('/named.db')
    } finally {
      if (previous === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previous
    }
  })

  test('a config that cannot be read refuses rather than falling back to the convention', () => {
    // Falling back would open a different database than the one that was configured, and the
    // screen would show an empty queue that looks like a clean checkout. Stopping is the
    // honest answer, and it is what `commands/defaults.ts` does on the batch side.
    const root = makeRepo()
    fs.writeFileSync(path.join(root, '.windbreak', 'config.json'), '{ not json')

    withoutEnvConfig(() => {
      // Names the file as well as the fault: a parse error is about the *contents*, and the
      // researcher may not know a config was found here at all.
      expect(() => resolveScreenDatabase({ repoRoot: root })).toThrow(
        new RegExp(`could not read ${checkoutConfigPath(root)}`),
      )
    })

    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('configPathForScreen', () => {
  test('with no config anywhere there is none, rather than a path that does not exist', () => {
    withoutEnvConfig(() => {
      expect(configPathForScreen({ repoRoot })).toBeNull()
    })
  })

  test('a named config is returned even when the file is missing', () => {
    // A typo has to be a `Config file not found` rather than a silent fall back to the
    // checkout's own config, which is what `discoverConfigPath` does and what the batch
    // commands rely on.
    const missing = path.join(repoRoot, 'absent.json')

    withoutEnvConfig(() => {
      expect(configPathForScreen({ configPath: missing, repoRoot })).toBe(missing)
    })
  })
})
