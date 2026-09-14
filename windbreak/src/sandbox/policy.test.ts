import { describe, expect, test } from 'bun:test'

import {
  createSandboxPolicy,
  DEFAULT_SANDBOX_ENVIRONMENT,
  resolveOptionalBinds,
  RUNTIME_READ_ONLY_DIRS,
} from './policy'

describe('resolveOptionalBinds', () => {
  test('drops optional binds whose host path is missing', () => {
    const resolved = resolveOptionalBinds(
      [
        { source: '/lib64', dest: '/lib64', optional: true },
        { source: '/usr', dest: '/usr', optional: true },
        { source: '/work/checkout', dest: '/work/checkout' },
      ],
      (candidate) => candidate !== '/lib64',
    )

    expect(resolved).toEqual([
      { source: '/usr', dest: '/usr' },
      { source: '/work/checkout', dest: '/work/checkout' },
    ])
  })

  test('keeps a missing bind when it was not marked optional', () => {
    const resolved = resolveOptionalBinds(
      [{ source: '/does/not/exist', dest: '/does/not/exist' }],
      () => false,
    )

    expect(resolved).toHaveLength(1)
  })
})

describe('createSandboxPolicy', () => {
  const base = {
    readOnlyBinds: [{ source: '/work/checkout', dest: '/work/checkout' }],
    writableBinds: [{ source: '/work/scratch', dest: '/work/scratch' }],
    workingDirectory: '/work/scratch',
    pathExists: () => false,
  }

  test('always includes the caller binds even when no runtime path exists', () => {
    const policy = createSandboxPolicy(base)

    expect(policy.readOnlyBinds).toEqual([
      { source: '/work/checkout', dest: '/work/checkout' },
    ])
    expect(policy.writableBinds).toEqual([
      { source: '/work/scratch', dest: '/work/scratch' },
    ])
  })

  test('includes runtime directories that do exist', () => {
    const policy = createSandboxPolicy({
      ...base,
      pathExists: (candidate) => candidate === '/usr',
    })

    const sources = policy.readOnlyBinds.map((bind) => bind.source)
    expect(sources).toContain('/usr')
    expect(sources).toContain('/work/checkout')
    expect(RUNTIME_READ_ONLY_DIRS).toContain('/usr')
  })

  test('the checkout bind is last, so nothing can shadow it', () => {
    const policy = createSandboxPolicy({
      ...base,
      pathExists: () => true,
    })

    expect(policy.readOnlyBinds.at(-1)).toEqual({
      source: '/work/checkout',
      dest: '/work/checkout',
    })
  })

  test('never binds the home directory', () => {
    const policy = createSandboxPolicy({ ...base, pathExists: () => true })

    expect(policy.readOnlyBinds.some((bind) => bind.source.includes('home'))).toBe(
      false,
    )
  })

  test('applies the documented defaults', () => {
    const policy = createSandboxPolicy(base)

    expect(policy.timeLimitSeconds).toBe(300)
    expect(policy.memoryLimitMiB).toBe(4096)
    expect(policy.hostname).toBe('windbreak')
    expect(policy.environment).toEqual(DEFAULT_SANDBOX_ENVIRONMENT)
  })

  test('caller environment overrides merge rather than replace', () => {
    const policy = createSandboxPolicy({ ...base, environment: { CC: 'clang' } })

    expect(policy.environment.CC).toBe('clang')
    expect(policy.environment.PATH).toBe(DEFAULT_SANDBOX_ENVIRONMENT.PATH)
  })
})
