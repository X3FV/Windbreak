import { describe, expect, test } from 'bun:test'

import {
  detectBackends,
  resolveBackend,
  SandboxUnavailableError,
} from './backends'

const finder = (available: Record<string, string>) => (name: string) =>
  available[name] ?? null

describe('detectBackends', () => {
  test('reports absolute paths for available backends', () => {
    const found = detectBackends({
      platform: 'linux',
      isExecutable: finder({ nsjail: '/usr/bin/nsjail', bwrap: '/usr/bin/bwrap' }),
    })

    expect(found).toEqual({ nsjail: '/usr/bin/nsjail', bwrap: '/usr/bin/bwrap' })
  })

  test('reports null for backends that are not installed', () => {
    const found = detectBackends({
      platform: 'linux',
      isExecutable: finder({ bwrap: '/usr/bin/bwrap' }),
    })

    expect(found.nsjail).toBeNull()
    expect(found.bwrap).toBe('/usr/bin/bwrap')
  })

  test('finds nothing off Linux, without even looking at PATH', () => {
    let looked = false
    const found = detectBackends({
      platform: 'darwin',
      isExecutable: () => {
        looked = true
        return '/usr/bin/bwrap'
      },
    })

    expect(found).toEqual({ nsjail: null, bwrap: null })
    expect(looked).toBe(false)
  })
})

describe('resolveBackend', () => {
  test('prefers nsjail over bwrap', () => {
    const backend = resolveBackend({
      platform: 'linux',
      isExecutable: finder({ nsjail: '/usr/bin/nsjail', bwrap: '/usr/bin/bwrap' }),
    })

    expect(backend.name).toBe('nsjail')
  })

  test('falls back to bwrap when nsjail is missing', () => {
    const backend = resolveBackend({
      platform: 'linux',
      isExecutable: finder({ bwrap: '/usr/bin/bwrap' }),
    })

    expect(backend.name).toBe('bwrap')
  })

  test('hard-stops rather than running unsandboxed', () => {
    expect(() =>
      resolveBackend({ platform: 'linux', isExecutable: () => null }),
    ).toThrow(SandboxUnavailableError)
  })

  test('does not silently downgrade an explicitly requested backend', () => {
    expect(() =>
      resolveBackend({
        platform: 'linux',
        preferred: 'nsjail',
        isExecutable: finder({ bwrap: '/usr/bin/bwrap' }),
      }),
    ).toThrow(/Requested sandbox backend "nsjail"/)
  })

  test('refuses non-Linux hosts with a clear message', () => {
    expect(() =>
      resolveBackend({
        platform: 'win32',
        isExecutable: finder({ bwrap: '/usr/bin/bwrap' }),
      }),
    ).toThrow(/requires Linux/)
  })
})
