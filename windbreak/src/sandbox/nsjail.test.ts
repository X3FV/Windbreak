import { describe, expect, test } from 'bun:test'

import { buildNsjailArgv } from './nsjail'
import { createSandboxPolicy } from './policy'

import type { SandboxRequest } from './types'

const request = (): SandboxRequest => ({
  policy: createSandboxPolicy({
    readOnlyBinds: [{ source: '/work/checkout', dest: '/work/checkout' }],
    writableBinds: [{ source: '/work/scratch', dest: '/work/scratch' }],
    workingDirectory: '/work/scratch',
    timeLimitSeconds: 120,
    memoryLimitMiB: 2048,
    cpuLimitSeconds: 90,
    pathExists: () => false,
  }),
  command: ['cmake', '--build', '/work/scratch/build/cmake'],
})

describe('buildNsjailArgv', () => {
  test('enforces the time and resource limits natively', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail')
    const value = (flag: string) => argv[argv.indexOf(flag) + 1]

    expect(value('--time_limit')).toBe('120')
    expect(value('--rlimit_as')).toBe('2048')
    expect(value('--rlimit_cpu')).toBe('90')
  })

  test('never shares the network namespace', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail')

    expect(argv).not.toContain('--share_net')
  })

  test('does not inherit the host environment', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail')

    expect(argv).not.toContain('--keep_env')
  })

  test('binds the checkout read-only and scratch writable, using explicit src:dst', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail').join(' ')

    expect(argv).toContain('--bindmount_ro /work/checkout:/work/checkout')
    expect(argv).toContain('--bindmount /work/scratch:/work/scratch')
  })

  test('chdirs and sets the hostname', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail')

    expect(argv[argv.indexOf('--cwd') + 1]).toBe('/work/scratch')
    expect(argv[argv.indexOf('--hostname') + 1]).toBe('windbreak')
  })

  test('passes exactly the policy environment', () => {
    const argv = buildNsjailArgv(
      {
        ...request(),
        policy: {
          ...request().policy,
          environment: { PATH: '/usr/bin:/bin', LANG: 'C' },
        },
      },
      '/usr/bin/nsjail',
    ).join(' ')

    expect(argv).toContain('--env PATH=/usr/bin:/bin')
    expect(argv).toContain('--env LANG=C')
  })

  test('runs in one-shot mode and puts the command after a separator', () => {
    const argv = buildNsjailArgv(request(), '/usr/bin/nsjail')
    const separator = argv.indexOf('--')

    expect(argv[argv.indexOf('--mode') + 1]).toBe('o')
    expect(argv.slice(separator + 1)).toEqual([
      'cmake',
      '--build',
      '/work/scratch/build/cmake',
    ])
  })

  test('mounts a private /tmp or disables proc, never neither', () => {
    const withPseudo = buildNsjailArgv(request(), '/usr/bin/nsjail')
    expect(withPseudo).toContain('--tmpfsmount')

    const without = buildNsjailArgv(
      {
        ...request(),
        policy: { ...request().policy, mountPseudoFilesystems: false },
      },
      '/usr/bin/nsjail',
    )
    expect(without).toContain('--disable_proc')
  })

  test('a per-request time limit overrides the policy', () => {
    const argv = buildNsjailArgv(
      { ...request(), timeLimitSeconds: 15 },
      '/usr/bin/nsjail',
    )

    expect(argv[argv.indexOf('--time_limit') + 1]).toBe('15')
  })
})
