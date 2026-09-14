import { describe, expect, test } from 'bun:test'

import {
  CONFIGURABLE_ROLES,
  DEEPSEEK_V4_1_FLASH_MODEL_ID,
  DEFAULT_MODEL_CONFIG,
  GLM_53_FLASH_MODEL_ID,
  INVESTIGATOR_ROLE,
  MODEL_ROLES,
  modelVendor,
  parseModelConfig,
  UNMETERED_MODEL_IDS,
  validateModelConfig,
} from './models'

import type { ConfigurableRole, ModelRole } from './models'

/**
 * Compile-time assertions, not tests with expectations.
 *
 * §20.29.3's containment is a *type* property — `insertVerdict` and `invokeCached` take
 * `ModelRole`, so the union's membership is the whole enforcement — and a property that
 * only exists at compile time has to be checked there. `Extract<X, U>` is `never` when
 * `U` has no `X`, so each of these resolves to `true` exactly while the relationship
 * holds: if the investigator is ever added to `ModelRole`, the second one becomes
 * `false` and the assignment below it stops compiling.
 */
type InvestigatorIsConfigurable = Extract<
  'investigator',
  ConfigurableRole
> extends never
  ? false
  : true
type InvestigatorIsNotAModelRole = Extract<'investigator', ModelRole> extends never
  ? true
  : false

const investigatorIsConfigurable: InvestigatorIsConfigurable = true
const investigatorIsNotAModelRole: InvestigatorIsNotAModelRole = true

describe('modelVendor', () => {
  test('takes the first segment of a vendor-prefixed id', () => {
    expect(modelVendor(GLM_53_FLASH_MODEL_ID)).toBe('z-ai')
    expect(modelVendor(DEEPSEEK_V4_1_FLASH_MODEL_ID)).toBe('deepseek')
  })

  test('returns the id itself when there is no prefix', () => {
    expect(modelVendor('glm-5.3-flash')).toBe('glm-5.3-flash')
  })
})

describe('unmetered model list', () => {
  test('contains the two session-free models the default config uses', () => {
    expect(UNMETERED_MODEL_IDS).toContain(GLM_53_FLASH_MODEL_ID)
    expect(UNMETERED_MODEL_IDS).toContain(DEEPSEEK_V4_1_FLASH_MODEL_ID)
  })

  test('excludes the retired DeepSeek V4 Pro', () => {
    expect(
      UNMETERED_MODEL_IDS.some((id) => id.includes('deepseek-v4-pro')),
    ).toBe(false)
  })
})

describe('validateModelConfig', () => {
  test('the default config is valid', () => {
    expect(validateModelConfig(DEFAULT_MODEL_CONFIG)).toEqual([])
  })

  test('rejects a proposer and refuter from the same provider', () => {
    const violations = validateModelConfig({
      ...DEFAULT_MODEL_CONFIG,
      refuter: { ...DEFAULT_MODEL_CONFIG.refuter, model: GLM_53_FLASH_MODEL_ID },
      proposer: { ...DEFAULT_MODEL_CONFIG.proposer, model: GLM_53_FLASH_MODEL_ID },
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toMatch(/different providers/)
  })

  test('flags a model id with no vendor prefix', () => {
    const violations = validateModelConfig({
      ...DEFAULT_MODEL_CONFIG,
      triage: { ...DEFAULT_MODEL_CONFIG.triage, model: 'glm-5.3-flash' },
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]?.role).toBe('triage')
  })
})

/**
 * §20.29.3 keeps the investigator out of the verdict unions, and that containment is a
 * compile-time property, so it is asserted at compile time.
 *
 * The two type-level checks live in a helper file rather than here because a
 * `@ts-expect-error` line proves the *opposite* of what it looks like it proves when the
 * expression stops being an error: TypeScript then reports the unused directive, which
 * is the assertion turning red for the right reason. `models-test-types.ts` has the
 * detail.
 */
describe('the investigator is configurable but not a verdict role', () => {
  test('it is a configurable row and not a ModelRole', () => {
    expect(CONFIGURABLE_ROLES).toContain(INVESTIGATOR_ROLE)
    // The direction that matters: `ModelRole` is what `insertVerdict` and `invokeCached`
    // accept, so membership there is how a turn would become a verdict row.
    expect(MODEL_ROLES).not.toContain(INVESTIGATOR_ROLE)
    expect(CONFIGURABLE_ROLES).toEqual([...MODEL_ROLES, INVESTIGATOR_ROLE])

    // Reading the constants is what keeps the two compile-time assertions above from
    // being dead code a linter or a refactor would happily delete.
    expect(investigatorIsConfigurable).toBe(true)
    expect(investigatorIsNotAModelRole).toBe(true)
  })

  test('the default config has a row for it', () => {
    expect(DEFAULT_MODEL_CONFIG.investigator.model).toBe(DEEPSEEK_V4_1_FLASH_MODEL_ID)
    expect(validateModelConfig(DEFAULT_MODEL_CONFIG)).toEqual([])
  })

  test('a vendor-less investigator model id is a violation too', () => {
    const violations = validateModelConfig({
      ...DEFAULT_MODEL_CONFIG,
      investigator: { ...DEFAULT_MODEL_CONFIG.investigator, model: 'deepseek-v4-flash' },
    })

    expect(violations).toHaveLength(1)
    expect(violations[0]?.role).toBe('investigator')
  })
})

describe('parseModelConfig', () => {
  test('applies the deterministic defaults', () => {
    const parsed = parseModelConfig({
      triage: { model: GLM_53_FLASH_MODEL_ID },
      proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID },
      refuter: { model: GLM_53_FLASH_MODEL_ID },
    })

    expect(parsed.triage.temperature).toBe(0)
    expect(parsed.triage.seed).toBeUndefined()
  })

  test('defaults the investigator when the config file omits it', () => {
    // The `checker-synth` precedent: a config written before §20.29 keeps working.
    const parsed = parseModelConfig({
      triage: { model: GLM_53_FLASH_MODEL_ID },
      proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID },
      refuter: { model: GLM_53_FLASH_MODEL_ID },
    })

    expect(parsed.investigator).toEqual(DEFAULT_MODEL_CONFIG.investigator)
  })

  test('reads an investigator row when the config file sets one', () => {
    const parsed = parseModelConfig({
      triage: { model: GLM_53_FLASH_MODEL_ID },
      proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID },
      refuter: { model: GLM_53_FLASH_MODEL_ID },
      investigator: { model: GLM_53_FLASH_MODEL_ID, temperature: 0.2 },
    })

    expect(parsed.investigator.model).toBe(GLM_53_FLASH_MODEL_ID)
    expect(parsed.investigator.temperature).toBe(0.2)
  })

  test('rejects an out-of-range temperature', () => {
    expect(() =>
      parseModelConfig({
        triage: { model: GLM_53_FLASH_MODEL_ID, temperature: 3 },
        proposer: { model: DEEPSEEK_V4_1_FLASH_MODEL_ID },
        refuter: { model: GLM_53_FLASH_MODEL_ID },
      }),
    ).toThrow()
  })
})
