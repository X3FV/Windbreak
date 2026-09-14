import { describe, expect, test } from 'bun:test'

import { dedupePaths, resolveEngines, resolveSemgrep, requireEngines } from './resolve'
import { EngineUnavailableError } from './resolve'

import type { HostRunner } from './resolve'

/**
 * A host runner that answers from a scripted map, so `prepare` can be tested
 * without a real Semgrep install.
 */
const runner = (answers: Record<string, string>): HostRunner => async (argv) => {
  const key = argv.join(' ')
  for (const [prefix, stdout] of Object.entries(answers)) {
    if (key.startsWith(prefix)) {
      return { exitCode: 0, stdout, stderr: '' }
    }
  }
  return { exitCode: 1, stdout: '', stderr: 'not scripted' }
}

const SEMGREP_PATH = '/home/dev/.local/bin/semgrep'

describe('resolveSemgrep', () => {
  test('reports a missing engine with the reason instead of throwing', async () => {
    const result = await resolveSemgrep({ which: () => null })

    expect(result).toEqual({ engine: 'semgrep', reason: 'not found on PATH' })
  })

  test('resolves the version and the bind roots a user install needs', async () => {
    const result = await resolveSemgrep({
      which: (binary) => (binary === 'semgrep' ? SEMGREP_PATH : null),
      run: runner({
        [SEMGREP_PATH]: '1.170.0\n',
        'python3 -c': '/home/dev/.local/lib/python3.14/site-packages\n',
      }),
    })

    expect(result).toMatchObject({
      engine: 'semgrep',
      version: '1.170.0',
      binary: SEMGREP_PATH,
      pathEntries: ['/home/dev/.local/bin'],
    })
    expect((result as { readOnlyRoots: string[] }).readOnlyRoots).toEqual([
      '/home/dev/.local/bin',
      '/home/dev/.local/lib/python3.14/site-packages',
    ])
  })

  test('tolerates an unknown version and an unqueryable package root', async () => {
    const result = await resolveSemgrep({
      which: () => '/usr/bin/semgrep',
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'nope' }),
    })

    expect(result).toMatchObject({
      version: 'unknown',
      readOnlyRoots: ['/usr/bin'],
    })
  })

  test('names the package root on PYTHONPATH so the bind is importable', async () => {
    const result = await resolveSemgrep({
      which: () => SEMGREP_PATH,
      run: runner({
        [SEMGREP_PATH]: '1.170.0\n',
        'python3 -c': '/home/dev/.local/lib/python3.14/site-packages\n',
      }),
    })

    // Binding site-packages alone is not enough: the sandbox sets HOME to a
    // scratch dir, which moves Python's user-site off the bound directory.
    expect(
      (result as { environment: Record<string, string> }).environment.PYTHONPATH,
    ).toBe('/home/dev/.local/lib/python3.14/site-packages')
  })

  test('omits PYTHONPATH when the package root could not be determined', async () => {
    const result = await resolveSemgrep({
      which: () => '/usr/bin/semgrep',
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    })

    expect(
      (result as { environment: Record<string, string> }).environment.PYTHONPATH,
    ).toBeUndefined()
  })

  test('pins telemetry off so a networkless sandbox is not stalled', async () => {
    const result = await resolveSemgrep({
      which: () => '/usr/bin/semgrep',
      run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    })

    expect(
      (result as { environment: Record<string, string> }).environment
        .SEMGREP_SEND_METRICS,
    ).toBe('off')
  })
})

describe('dedupePaths', () => {
  test('drops paths nested under a bound ancestor', () => {
    expect(
      dedupePaths([
        '/home/dev/.local/bin',
        '/home/dev/.local/bin',
        '/home/dev/.local/lib/python3.14/site-packages',
        '/home/dev/.local',
      ]),
    ).toEqual(['/home/dev/.local'])
  })

  test('keeps siblings', () => {
    expect(dedupePaths(['/a', '/b'])).toEqual(['/a', '/b'])
  })
})

describe('resolveEngines', () => {
  test('names engines the spec lists but this build does not drive', async () => {
    const result = await resolveEngines({
      engines: ['semgrep', 'codeql'],
      which: () => null,
    })

    expect(result.unavailable.map((entry) => entry.engine)).toEqual([
      'semgrep',
      'codeql',
    ])
    expect(result.unavailable[1]).toMatchObject({ unimplemented: true })
  })
})

describe('requireEngines', () => {
  test('fails closed when a required engine is missing', async () => {
    await expect(
      requireEngines({ required: ['semgrep'], which: () => null }),
    ).rejects.toThrow(EngineUnavailableError)
  })

  test('the error names the engine and the reason', async () => {
    await expect(
      requireEngines({ required: ['semgrep'], which: () => null }),
    ).rejects.toThrow(/semgrep \(not found on PATH\)/)
  })

  test('returns the resolved engine when it is present', async () => {
    const result = await requireEngines({
      required: ['semgrep'],
      which: () => SEMGREP_PATH,
      run: runner({
        [SEMGREP_PATH]: '1.170.0\n',
        'python3 -c': '/home/dev/.local/lib/python3.14/site-packages\n',
      }),
    })

    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]!.version).toBe('1.170.0')
  })
})
