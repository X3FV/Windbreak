import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  DEFAULT_INVESTIGATOR_CONFIG,
  conventionalConfigPath,
  discoverConfigPath,
  loadConfig,
  loadEffectiveConfig,
} from './config'
import {
  DEFAULT_INVESTIGATOR_STEPS,
  DEFAULT_MAX_CONVERSATION_CALLS,
} from './investigate/limits'
import { DEEPSEEK_V4_1_FLASH_MODEL_ID, GLM_53_FLASH_MODEL_ID } from './models'

let tmpDir: string

const writeConfig = (contents: unknown): string => {
  const configPath = path.join(tmpDir, 'windbreak.json')
  fs.writeFileSync(configPath, JSON.stringify(contents))
  return configPath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-config-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  test('falls back to defaults when no path is given', () => {
    const loaded = loadConfig()

    expect(loaded.sourcePath).toBeNull()
    expect(loaded.violations).toEqual([])
    expect(loaded.config.models.triage.model).toBe(GLM_53_FLASH_MODEL_ID)
  })

  test('reads models from a file', () => {
    const configPath = writeConfig({
      models: {
        triage: { model: GLM_53_FLASH_MODEL_ID },
        proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID },
        refuter: { model: GLM_53_FLASH_MODEL_ID },
      },
    })

    const loaded = loadConfig(configPath)

    expect(loaded.sourcePath).toBe(configPath)
    expect(loaded.config.models.proposer.model).toBe(
      DEEPSEEK_V4_1_FLASH_MODEL_ID,
    )
  })

  test('reports cross-provider violations rather than throwing', () => {
    const configPath = writeConfig({
      models: {
        triage: { model: GLM_53_FLASH_MODEL_ID },
        proposer: { model: GLM_53_FLASH_MODEL_ID },
        refuter: { model: GLM_53_FLASH_MODEL_ID },
      },
    })

    const loaded = loadConfig(configPath)

    expect(loaded.violations.length).toBeGreaterThan(0)
  })

  test('throws for a missing file', () => {
    expect(() => loadConfig(path.join(tmpDir, 'absent.json'))).toThrow(
      /Config file not found/,
    )
  })
})

describe('the target section (spec §7.3)', () => {
  test('defaults to no target and the conventional database', () => {
    expect(loadConfig().config.target).toEqual({ location: null, db: null })
  })

  test('resolves a relative path against the config file, not the working directory', () => {
    const configPath = writeConfig({ target: { location: '.', db: 'state.db' } })
    const { target } = loadConfig(configPath).config

    // The rule this pins: a configured target has to mean the same checkout no matter
    // which directory the command was run from. Resolving against the working directory
    // would make the default depend on which shell you happened to be in, which is the
    // mistake the section exists to remove.
    expect(target.location).toBe(tmpDir)
    expect(target.db).toBe(path.join(tmpDir, 'state.db'))
  })

  test('keeps an absolute location as written', () => {
    const repo = path.join(tmpDir, 'repo')
    const configPath = writeConfig({ target: { location: repo } })

    expect(loadConfig(configPath).config.target.location).toBe(repo)
  })

  test('an explicit null is the absence of a default, not a path', () => {
    const configPath = writeConfig({ target: { location: null, db: null } })

    expect(loadConfig(configPath).config.target).toEqual({ location: null, db: null })
  })

  test('an empty path is refused structurally rather than resolved to a directory', () => {
    const configPath = writeConfig({ target: { location: '' } })

    expect(() => loadConfig(configPath)).toThrow()
  })
})

describe('config discovery', () => {
  const withEnv = (value: string | undefined, run: () => void): void => {
    const previous = process.env.WINDBREAK_CONFIG
    if (value === undefined) delete process.env.WINDBREAK_CONFIG
    else process.env.WINDBREAK_CONFIG = value
    try {
      run()
    } finally {
      if (previous === undefined) delete process.env.WINDBREAK_CONFIG
      else process.env.WINDBREAK_CONFIG = previous
    }
  }

  test('$WINDBREAK_CONFIG selects the file, and the whole config is read from it', () => {
    const configPath = writeConfig({ target: { location: '.' } })

    withEnv(configPath, () => {
      expect(discoverConfigPath()).toBe(configPath)

      const loaded = loadEffectiveConfig()
      expect(loaded.sourcePath).toBe(configPath)
      expect(loaded.config.target.location).toBe(tmpDir)
    })
  })

  test('an explicitly set but missing file is an error, not a silent fallback', () => {
    // A typo in the variable would otherwise read as "there are no defaults", which is
    // indistinguishable from "there is no config" — the shape §18 rejects.
    withEnv(path.join(tmpDir, 'absent.json'), () => {
      expect(() => loadEffectiveConfig()).toThrow(/Config file not found/)
    })
  })

  test('with no variable set, discovery only ever returns a file that exists', () => {
    // Deliberately not asserting "returns null": whether a conventional config exists
    // depends on the working directory the suite was started from, and a test that
    // depends on the developer's own `.windbreak` is a test of their filesystem.
    withEnv(undefined, () => {
      const found = discoverConfigPath()

      expect(found === null || fs.existsSync(found)).toBe(true)
      if (found !== null) expect(found).toBe(conventionalConfigPath())
    })
  })
})

describe('the investigator section (§20.29.6)', () => {
  test('defaults match the agent, so there is one place the numbers live', () => {
    // The duplication this prevents is the one `models.ts` already documents once: a
    // default that exists in two files drifts the first time one of them changes.
    expect(DEFAULT_INVESTIGATOR_CONFIG.maxConversationCalls).toBe(
      DEFAULT_MAX_CONVERSATION_CALLS,
    )
    expect(DEFAULT_INVESTIGATOR_CONFIG.maxSteps).toBe(DEFAULT_INVESTIGATOR_STEPS)
    expect(loadConfig().config.investigator).toEqual(DEFAULT_INVESTIGATOR_CONFIG)
  })

  test('reads the limits from a file, and the absent half defaults', () => {
    const configPath = writeConfig({ investigator: { maxConversationCalls: 7 } })
    const loaded = loadConfig(configPath)

    expect(loaded.config.investigator.maxConversationCalls).toBe(7)
    expect(loaded.config.investigator.maxSteps).toBe(DEFAULT_INVESTIGATOR_STEPS)
  })

  test('a nonsense limit is refused structurally rather than silently used', () => {
    // A zero ceiling is not a ceiling, and `zod` is where that is decided — the budget
    // module's fallback is for a value it is *handed*, not for a config file.
    const configPath = writeConfig({ investigator: { maxConversationCalls: 0 } })
    expect(() => loadConfig(configPath)).toThrow()
  })
})
