import { describe, expect, test } from 'bun:test'

import { buildBwrapArgv, RLIMIT_WRAPPER_NAME } from './bwrap'
import { createSandboxPolicy } from './policy'

import type { SandboxRequest } from './types'

const request = (overrides: Partial<SandboxRequest['policy']> = {}): SandboxRequest => ({
  policy: createSandboxPolicy({
    readOnlyBinds: [{ source: '/work/checkout', dest: '/work/checkout' }],
    writableBinds: [{ source: '/work/scratch', dest: '/work/scratch' }],
    workingDirectory: '/work/scratch',
    pathExists: () => false,
    ...overrides,
  }),
  command: ['make', '-j', '4'],
})

describe('buildBwrapArgv', () => {
  test('unshares every namespace, which is what removes the network route', () => {
    const argv = buildBwrapArgv(request(), '/usr/bin/bwrap')

    expect(argv).toContain('--unshare-all')
    expect(argv).not.toContain('--share-net')
  })

  test('cleans the environment and drops capabilities', () => {
    const argv = buildBwrapArgv(request(), '/usr/bin/bwrap')

    expect(argv).toContain('--clearenv')
    expect(argv.slice(argv.indexOf('--cap-drop'), argv.indexOf('--cap-drop') + 2)).toEqual([
      '--cap-drop',
      'ALL',
    ])
  })

  test('does not allow the sandbox to outlive its parent', () => {
    expect(buildBwrapArgv(request(), '/usr/bin/bwrap')).toContain('--die-with-parent')
  })

  test('binds the checkout read-only and scratch writable', () => {
    const argv = buildBwrapArgv(request(), '/usr/bin/bwrap')

    expect(argv.join(' ')).toContain('--ro-bind /work/checkout /work/checkout')
    expect(argv.join(' ')).toContain('--bind /work/scratch /work/scratch')
  })

  test('chdirs into the requested directory', () => {
    const argv = buildBwrapArgv(
      { ...request(), workingDirectory: '/work/scratch/build' },
      '/usr/bin/bwrap',
    )

    expect(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2)).toEqual([
      '--chdir',
      '/work/scratch/build',
    ])
  })

  test('only the policy environment is passed through', () => {
    const argv = buildBwrapArgv(
      {
        ...request(),
        policy: {
          ...request().policy,
          environment: { PATH: '/usr/bin:/bin', LANG: 'C' },
        },
      },
      '/usr/bin/bwrap',
    )

    expect(argv.join(' ')).toContain('--setenv PATH /usr/bin:/bin')
    expect(argv.join(' ')).toContain('--setenv LANG C')
    expect(argv.join(' ')).not.toContain('HOME=/home')
  })

  test('applies rlimits through a wrapper before exec', () => {
    const argv = buildBwrapArgv(request(), '/usr/bin/bwrap')
    const separator = argv.indexOf('--')
    const wrapped = argv.slice(separator + 1)

    expect(wrapped.slice(0, 3)).toEqual(['/bin/sh', '-c', expect.any(String)])
    expect(wrapped[3]).toBe(RLIMIT_WRAPPER_NAME)
    // ulimit -v counts KiB, the policy counts MiB.
    expect(wrapped[4]).toBe(String(request().policy.memoryLimitMiB * 1024))
    expect(wrapped[5]).toBe(String(request().policy.cpuLimitSeconds))
  })

  test('passes the command as positionals, so it needs no shell quoting', () => {
    const argv = buildBwrapArgv(
      { ...request(), command: ['sh', '-c', 'echo "spaces and $dollars"'] },
      '/usr/bin/bwrap',
    )
    const separator = argv.indexOf('--')

    expect(argv.slice(separator + 1).slice(6)).toEqual([
      'sh',
      '-c',
      'echo "spaces and $dollars"',
    ])
  })

  test('omits pseudo-filesystems when the policy says so', () => {
    const argv = buildBwrapArgv(
      {
        ...request(),
        policy: { ...request().policy, mountPseudoFilesystems: false },
      },
      '/usr/bin/bwrap',
    )

    expect(argv).not.toContain('--proc')
    expect(argv).not.toContain('--dev')
  })
})
