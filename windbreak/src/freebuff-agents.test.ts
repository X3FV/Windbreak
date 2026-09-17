import { describe, expect, test } from 'bun:test'

import {
  FREE_MODE_MODEL_IDS,
  FreeModeModelError,
  freeAgentIdFor,
} from './freebuff-agents'
import { CONFIGURABLE_ROLES, DEFAULT_MODEL_CONFIG } from './models'

/**
 * The map is data, and these tests are what keeps it honest (spec §20.41).
 *
 * A model free mode will not serve is not a subtle failure — the gate answers
 * `free_mode_invalid_agent_model` and the run produces nothing. But it is a failure that
 * only appears against a live provider, which is exactly the kind of defect a suite
 * should be able to prevent instead of discover. So the shipped configuration is pinned
 * against the map here.
 */

describe('freeAgentIdFor', () => {
  test('maps the models windbreak ships with to Freebuff root agents', () => {
    expect(freeAgentIdFor('deepseek/deepseek-v4-flash')).toBe('base3-free-deepseek-flash')
    expect(freeAgentIdFor('z-ai/glm-5.3-flash')).toBe('base3-free-glm-5-3-flash')
  })

  test('refuses a model with no free agent, naming the ones that have one', () => {
    // No fallback to `windbreak-<role>`: that trades a legible error here for a provider
    // refusal about "agent and model combinations" that names neither.
    const error = (() => {
      try {
        freeAgentIdFor('anthropic/claude-sonnet-4')
      } catch (caught) {
        return caught
      }
      return null
    })()

    expect(error).toBeInstanceOf(FreeModeModelError)
    expect((error as Error).message).toContain('anthropic/claude-sonnet-4')
    for (const model of FREE_MODE_MODEL_IDS) {
      expect((error as Error).message).toContain(model)
    }
  })
})

describe('the shipped model configuration', () => {
  test('every configurable role can run in free mode', () => {
    // The failure this prevents: someone points a role at a stronger model, the config
    // validates (it only checks the vendor prefix and the cross-vendor gate), and the
    // run then fails at the provider with a message about agent/model combinations.
    for (const role of CONFIGURABLE_ROLES) {
      const model = DEFAULT_MODEL_CONFIG[role].model
      expect(() => freeAgentIdFor(model)).not.toThrow()
    }
  })

  test('each role resolves to a root agent whose model matches the role', () => {
    // The two are separate tables — this tool's roles and Freebuff's roots — so the
    // relationship between them is exactly what can drift.
    const seen = new Set<string>()
    for (const role of CONFIGURABLE_ROLES) {
      seen.add(freeAgentIdFor(DEFAULT_MODEL_CONFIG[role].model))
    }
    // The default config uses two models, so it needs two roots: a single id here would
    // mean two roles were pointed at one model, which §5.2's gate forbids for proposer
    // and refuter.
    expect(seen.size).toBe(2)
    expect(seen.has('base3-free-deepseek-flash')).toBe(true)
    expect(seen.has('base3-free-glm-5-3-flash')).toBe(true)
  })
})
