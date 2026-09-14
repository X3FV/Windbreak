import fs from 'fs'
import os from 'os'
import path from 'path'

import { createSandboxPolicy } from './policy'
import { runInSandbox } from './run'

import type { RunInSandboxOptions } from './run'

export type SandboxProbeName =
  | 'exec'
  | 'read-only-enforcement'
  | 'network-isolation'

export interface SandboxProbeResult {
  name: SandboxProbeName
  ok: boolean
  detail: string
}

/** Parse `/proc/net/dev` down to the interface names it lists. */
export const parseNetworkInterfaces = (procNetDev: string): string[] =>
  procNetDev
    .split('\n')
    // Two header lines, then `iface: stats...`.
    .slice(2)
    .map((line) => line.split(':')[0]?.trim())
    .filter((name): name is string => !!name)

/**
 * Run the security-relevant properties of §6 as live probes.
 *
 * These assert behaviour, not argv: a policy that looks right but does not
 * actually stop a write is the failure mode that matters, and only running it
 * catches that.
 *
 * The writable scratch bind is intentional — the read-only probe must show that
 * a path bound read-only refuses writes *while* a writable path in the same
 * sandbox succeeds, otherwise a sandbox that simply cannot write anything would
 * pass.
 */
export const runSandboxProbes = async (
  options: RunInSandboxOptions = {},
): Promise<SandboxProbeResult[]> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-probe-'))
  const readOnlyDir = path.join(root, 'read-only')
  const scratchDir = path.join(root, 'scratch')
  fs.mkdirSync(readOnlyDir)
  fs.mkdirSync(scratchDir)
  fs.writeFileSync(path.join(readOnlyDir, 'existing.txt'), 'present\n')

  const policy = createSandboxPolicy({
    readOnlyBinds: [{ source: readOnlyDir, dest: readOnlyDir }],
    writableBinds: [{ source: scratchDir, dest: scratchDir }],
    workingDirectory: scratchDir,
    timeLimitSeconds: 30,
    memoryLimitMiB: 512,
    cpuLimitSeconds: 30,
  })

  const results: SandboxProbeResult[] = []

  try {
    const exec = await runInSandbox(
      { policy, command: ['/bin/sh', '-c', 'echo windbreak-probe-ok'] },
      options,
    )
    results.push({
      name: 'exec',
      ok: exec.exitCode === 0 && exec.stdout.includes('windbreak-probe-ok'),
      detail:
        exec.exitCode === 0
          ? 'a shell runs inside the sandbox'
          : `sandbox failed to start (exit ${exec.exitCode}): ${exec.stderr.trim().slice(0, 300)}`,
    })

    const writeProbe = await runInSandbox(
      {
        policy,
        command: [
          '/bin/sh',
          '-c',
          `if echo x > ${readOnlyDir}/write.test 2>/dev/null; then ` +
            `echo READ_ONLY_BIND_WRITABLE; ` +
            `elif echo y > ${scratchDir}/write.test 2>/dev/null; then ` +
            `echo READ_ONLY_ENFORCED; else echo NO_WRITES_AT_ALL; fi`,
        ],
      },
      options,
    )

    const hostUntouched = !fs.existsSync(path.join(readOnlyDir, 'write.test'))
    const readOnlyEnforced =
      writeProbe.stdout.includes('READ_ONLY_ENFORCED') && hostUntouched

    results.push({
      name: 'read-only-enforcement',
      ok: readOnlyEnforced,
      detail: readOnlyEnforced
        ? 'the checkout bind rejects writes while scratch accepts them'
        : writeProbe.stdout.includes('READ_ONLY_BIND_WRITABLE')
          ? 'a read-only bind accepted a write — isolation is not holding'
          : hostUntouched
            ? `could not confirm: sandbox produced "${writeProbe.stdout.trim()}"`
            : 'a write under the read-only bind reached the host',
    })

    const netProbe = await runInSandbox(
      { policy, command: ['/bin/cat', '/proc/net/dev'] },
      options,
    )
    const interfaces = parseNetworkInterfaces(netProbe.stdout)
    const nonLoopback = interfaces.filter((name) => name !== 'lo')

    results.push({
      name: 'network-isolation',
      ok: netProbe.exitCode === 0 && nonLoopback.length === 0,
      detail:
        netProbe.exitCode !== 0
          ? `could not read /proc/net/dev (exit ${netProbe.exitCode})`
          : nonLoopback.length === 0
            ? `only loopback is present (${interfaces.join(', ') || 'none'})`
            : `sandbox has network interfaces: ${nonLoopback.join(', ')}`,
    })

    return results
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
