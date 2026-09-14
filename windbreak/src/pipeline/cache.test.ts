import { afterEach, describe, expect, test } from 'bun:test'

import {
  readVerdictCache,
  verdictCacheKey,
  writeVerdictCache,
} from './cache'
import { seedState } from './test-support'

import type { Database } from 'bun:sqlite'

let db: Database | null = null

afterEach(() => {
  db?.close()
  db = null
})

const baseInput = {
  normalizedJson: '{"ruleId":"r1"}',
  promptTemplateVersion: 'v1',
  escapedInput: '<<<UNTRUSTED>>>\nstrcpy(dst, src);',
  modelId: 'z-ai/glm-5.3-flash',
  temperature: 0,
  seed: 42,
  role: 'triage' as const,
}

describe('verdictCacheKey', () => {
  test('is deterministic for identical inputs', () => {
    expect(verdictCacheKey(baseInput)).toBe(verdictCacheKey({ ...baseInput }))
  })

  test('changes when any input component changes', () => {
    const baseline = verdictCacheKey(baseInput)

    expect(verdictCacheKey({ ...baseInput, escapedInput: 'different' })).not.toBe(baseline)
    expect(verdictCacheKey({ ...baseInput, modelId: 'deepseek/deepseek-v4-flash' })).not.toBe(
      baseline,
    )
    expect(verdictCacheKey({ ...baseInput, promptTemplateVersion: 'v2' })).not.toBe(baseline)
    expect(verdictCacheKey({ ...baseInput, seed: 7 })).not.toBe(baseline)
    expect(verdictCacheKey({ ...baseInput, temperature: 0.5 })).not.toBe(baseline)
    expect(verdictCacheKey({ ...baseInput, normalizedJson: '{"ruleId":"r2"}' })).not.toBe(
      baseline,
    )
  })

  test('separates the triage and refuter roles on otherwise identical input', () => {
    // The default config runs both roles on the same model over the same
    // evidence. Without the role in the key the two would collide.
    const triage = verdictCacheKey({ ...baseInput, role: 'triage' })
    const refuter = verdictCacheKey({ ...baseInput, role: 'refuter' })

    expect(triage).not.toBe(refuter)
  })
})

describe('verdict cache round-trip', () => {
  test('writes and replays a recorded output', () => {
    const seeded = seedState({ candidates: [{ id: 'cand-1' }] })
    db = seeded.db

    const key = verdictCacheKey(baseInput)
    expect(readVerdictCache(db, key)).toBeNull()

    writeVerdictCache(db, {
      cacheKey: key,
      role: 'triage',
      modelId: 'z-ai/glm-5.3-flash',
      provider: 'z-ai',
      promptTemplateVersion: 'v1',
      output: { label: 'likely-real', rationale: 'looks real' },
    })

    const hit = readVerdictCache(db, key)
    expect(hit?.output).toEqual({ label: 'likely-real', rationale: 'looks real' })
    expect(hit?.provider).toBe('z-ai')
    expect(hit?.promptTemplateVersion).toBe('v1')
  })

  test('replaces rather than accumulates on the same key', () => {
    const seeded = seedState({})
    db = seeded.db

    const key = verdictCacheKey(baseInput)
    writeVerdictCache(db, {
      cacheKey: key,
      role: 'triage',
      modelId: 'm',
      provider: 'p',
      promptTemplateVersion: 'v1',
      output: { label: 'likely-noise', rationale: 'first' },
    })
    writeVerdictCache(db, {
      cacheKey: key,
      role: 'triage',
      modelId: 'm',
      provider: 'p',
      promptTemplateVersion: 'v1',
      output: { label: 'likely-real', rationale: 'second' },
    })

    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM verdict_cache').get()?.n,
    ).toBe(1)
    expect(readVerdictCache(db, key)?.output).toEqual({
      label: 'likely-real',
      rationale: 'second',
    })
  })

  test('treats an unreadable cache row as a miss rather than returning garbage', () => {
    const seeded = seedState({})
    db = seeded.db

    const key = verdictCacheKey(baseInput)
    db.prepare(
      `INSERT INTO verdict_cache (cache_key, role, model_id, provider, prompt_template_version, output_json, created_at)
       VALUES (?, 'triage', 'm', 'p', 'v1', 'not json', NULL)`,
    ).run(key)

    expect(readVerdictCache(db, key)).toBeNull()
  })
})
