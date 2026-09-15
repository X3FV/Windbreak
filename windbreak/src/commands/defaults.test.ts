import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createProgram } from '../index'

import {
  DEFAULT_DB_PATH,
  defaultTargetPath,
  effectiveConfig,
  initCommandDefaults,
  readCommandDefaults,
  requireTargetOption,
  resetCommandDefaults,
} from './defaults'

let tmpDir: string

const writeConfig = (contents: unknown): string => {
  const configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(contents))
  return configPath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-defaults-'))
})

afterEach(() => {
  // `initCommandDefaults` writes module state and one bun process runs every file of
  // a suite, so a file that sets it has to put it back.
  resetCommandDefaults()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('readCommandDefaults', () => {
  test('no config means no default target and the conventional database', () => {
    expect(readCommandDefaults(null)).toEqual({
      target: undefined,
      dbPath: DEFAULT_DB_PATH,
      sourcePath: null,
    })
  })

  test('a configured target and database resolve against the config directory', () => {
    const configPath = writeConfig({ target: { location: '.', db: 'state.db' } })
    const defaults = readCommandDefaults(configPath)

    expect(defaults.target).toBe(tmpDir)
    expect(defaults.dbPath).toBe(path.join(tmpDir, 'state.db'))
    expect(defaults.sourcePath).toBe(configPath)
  })

  test('a config with no target section keeps the conventional database', () => {
    const configPath = writeConfig({ budget: { totalSeconds: 60 } })

    expect(readCommandDefaults(configPath)).toEqual({
      target: undefined,
      dbPath: DEFAULT_DB_PATH,
      sourcePath: configPath,
    })
  })

  test('an unreadable config throws instead of degrading to the built-ins', () => {
    // Falling back here would point a scan at the wrong target, or at none, because a
    // file the researcher did write could not be parsed. That is worse than stopping.
    expect(() => readCommandDefaults(path.join(tmpDir, 'absent.json'))).toThrow(
      /Config file not found/,
    )
  })
})

/**
 * Run something that is expected to fail a command, then clear the exit code.
 *
 * `process.exitCode` cannot simply be saved and put back, because **Bun ignores
 * `process.exitCode = undefined`** — verified: assigning it after a `1` leaves the 1 in
 * place. So a test that drives the refusal below would leave the process at 1 and a suite
 * with no failures would still exit 1, which CI reads as a red build. `0` is the reset,
 * and bun's runner sets the real code after every test has run, so clearing it here
 * cannot hide a genuine failure.
 */
const afterFailingCommand = <T>(run: () => T): T => {
  try {
    return run()
  } finally {
    process.exitCode = 0
  }
}

describe('requireTargetOption', () => {
  test('passes an explicit value through untouched', () => {
    expect(requireTargetOption('/some/checkout')).toBe('/some/checkout')
  })

  test('names both ways to supply a target and fails the command', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})

    try {
      afterFailingCommand(() => {
        expect(requireTargetOption(undefined)).toBeNull()
        expect(process.exitCode).toBe(1)
      })

      const message = errors.mock.calls.flat().join('\n')
      expect(message).toContain('--target <path>')
      expect(message).toContain('"target": { "location": "<path>" }')
      // The config file may not exist yet, and pointing at a path nobody has created is
      // otherwise the least actionable half of the message.
      expect(message).toContain('does not exist yet')
    } finally {
      errors.mockRestore()
    }
  })

  test('with a config in play, the message names that file instead', () => {
    const configPath = writeConfig({ target: { location: '.' } })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const previousEnv = process.env.WINDBREAK_CONFIG

    try {
      process.env.WINDBREAK_CONFIG = configPath
      expect(initCommandDefaults()).toEqual({ ok: true })

      // This config has a target, so the message is only reachable from one that does
      // not: rewrite it, re-resolve, and the same call names the file it read.
      fs.writeFileSync(configPath, JSON.stringify({ budget: { totalSeconds: 60 } }))
      resetCommandDefaults()
      expect(initCommandDefaults()).toEqual({ ok: true })
      expect(defaultTargetPath()).toBeUndefined()

      afterFailingCommand(() => {
        expect(requireTargetOption(undefined)).toBeNull()
      })

      const message = errors.mock.calls.flat().join('\n')
      expect(message).toContain(configPath)
      expect(message).not.toContain('does not exist yet')
    } finally {
      errors.mockRestore()
      if (previousEnv === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previousEnv
    }
  })
})

describe('the configured default reaches the commands', () => {
  test('initCommandDefaults seeds --target and --db on a per-target command', () => {
    const configPath = writeConfig({ target: { location: '.', db: 'state.db' } })
    const previousEnv = process.env.WINDBREAK_CONFIG

    try {
      process.env.WINDBREAK_CONFIG = configPath
      expect(initCommandDefaults()).toEqual({ ok: true })
      expect(defaultTargetPath()).toBe(tmpDir)

      const scan = createProgram().commands.find((command) => command.name() === 'scan')
      expect(scan).toBeDefined()

      const target = scan!.options.find((option) => option.long === '--target')
      expect(target?.defaultValue).toBe(tmpDir)
      // Not required any more — which is what makes the configured default usable, and
      // what pushes the "there is no target" case into `requireTargetOption`'s message
      // rather than into an error from commander.
      expect(target?.mandatory).toBe(false)

      const db = scan!.options.find((option) => option.long === '--db')
      expect(db?.defaultValue).toBeUndefined()
    } finally {
      if (previousEnv === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previousEnv
    }
  })

  test('a broken config stops the CLI instead of running on defaults', () => {
    const configPath = path.join(tmpDir, 'config.json')
    fs.writeFileSync(configPath, '{ not json')
    const previousEnv = process.env.WINDBREAK_CONFIG

    try {
      process.env.WINDBREAK_CONFIG = configPath
      const result = initCommandDefaults()

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain(configPath)
        expect(result.message).toMatch(/will not fall back to defaults/)
      }
    } finally {
      if (previousEnv === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previousEnv
    }
  })
})

describe('effectiveConfig', () => {
  /** Set `$WINDBREAK_CONFIG` for the duration of `run`, then put the environment back. */
  const withConfigEnv = (value: string, run: () => void): void => {
    const previousEnv = process.env.WINDBREAK_CONFIG

    try {
      process.env.WINDBREAK_CONFIG = value
      run()
    } finally {
      if (previousEnv === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previousEnv
    }
  }

  test('with nothing discovered it is the built-in defaults', () => {
    const loaded = effectiveConfig()

    expect(loaded.sourcePath).toBeNull()
    expect(loaded.config.target).toEqual({ location: null, db: null })
  })

  test('reads the discovered file, so the sections `--target` does not carry come from it', () => {
    const configPath = writeConfig({
      target: { location: '.' },
      budget: { totalSeconds: 60 },
    })

    withConfigEnv(configPath, () => {
      expect(initCommandDefaults()).toEqual({ ok: true })

      const loaded = effectiveConfig()

      expect(loaded.sourcePath).toBe(configPath)
      expect(loaded.config.budget.totalSeconds).toBe(60)
      // The point of routing both through one resolution: the budget above and the target
      // default below are now read from the same file, so `config show` cannot report
      // built-ins while a scan runs the file.
      expect(defaultTargetPath()).toBe(tmpDir)
    })
  })

  test('a named file is read instead of the discovered one, never merged with it', () => {
    const discovered = writeConfig({ budget: { totalSeconds: 60 } })
    const named = path.join(tmpDir, 'named.json')
    fs.writeFileSync(named, JSON.stringify({ budget: { totalSeconds: 90 } }))

    withConfigEnv(discovered, () => {
      expect(initCommandDefaults()).toEqual({ ok: true })

      expect(effectiveConfig(named).config.budget.totalSeconds).toBe(90)
      expect(effectiveConfig(named).sourcePath).toBe(named)
    })
  })

  test('a named file that is missing is an error, not a fall back to the discovered one', () => {
    const discovered = writeConfig({ budget: { totalSeconds: 60 } })

    withConfigEnv(discovered, () => {
      expect(initCommandDefaults()).toEqual({ ok: true })

      // Naming a file has to mean exactly that file. Silently running the discovered one
      // instead would apply a different budget than the one that was asked for.
      expect(() => effectiveConfig(path.join(tmpDir, 'absent.json'))).toThrow(
        /Config file not found/,
      )
    })
  })
})
