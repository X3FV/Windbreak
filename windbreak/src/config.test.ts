import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { DEFAULT_INVESTIGATOR_CONFIG, loadConfig } from './config'
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
