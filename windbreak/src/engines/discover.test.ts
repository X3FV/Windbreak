import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { Database } from 'bun:sqlite'

import { createBudgetGovernor } from '../budget'
import { applySchema } from '../state/db'
import { buildInvocation, MIN_ENGINE_SECONDS, runBaselineEngines } from './discover'
import { readCandidateSummary } from './persist'

import type { SandboxSpawn } from '../sandbox/run'
import type { ResolvedEngine } from './types'

let root: string
let scratch: string
let db: Database

const SEMGREP: ResolvedEngine = {
  engine: 'semgrep',
  version: '1.170.0',
  binary: '/home/dev/.local/bin/semgrep',
  readOnlyRoots: ['/home/dev/.local/bin'],
  pathEntries: ['/home/dev/.local/bin'],
  environment: {},
}

const bwrapOnly = {
  isExecutable: (name: string) => (name === 'bwrap' ? '/usr/bin/bwrap' : null),
}

/**
 * Returns the given readings in order, then holds the last one. The governor
 * reads the clock once when a stage starts and again on every elapsed-time
 * question, so a test can place the stage's start and the current time exactly.
 */
const clockOf = (...values: number[]): (() => number) => {
  let reads = 0
  return () => values[Math.min(reads++, values.length - 1)]!
}

const sarifFor = (uri: string, line: number): string =>
  JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Semgrep OSS',
            rules: [
              {
                id: 'wb-c-unbounded-string-op',
                defaultConfiguration: { level: 'error' },
                properties: { tags: ['cwe-120'] },
              },
            ],
          },
        },
        results: [
          {
            ruleId: 'wb-c-unbounded-string-op',
            message: { text: 'unbounded copy' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri },
                  region: { startLine: line, endLine: line },
                },
              },
            ],
          },
        ],
      },
    ],
  })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-engines-'))
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-scratch-'))
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON;')
  applySchema(db)
  db.prepare('INSERT INTO targets (id, location) VALUES (?, ?)').run(
    'target-1',
    root,
  )
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status) VALUES ('run-1', 'target-1', '{}', 'abc', 'running')`,
  ).run()

  fs.writeFileSync(path.join(root, 'a.c'), 'int a;\nint b;\nstrcpy(dst, src);\n')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('buildInvocation', () => {
  test('scans the target as . so reported paths are root-relative', () => {
    const invocation = buildInvocation(
      SEMGREP,
      { rulePaths: ['/rules/security.yaml'] },
      300,
    )

    expect(invocation.engine).toBe('semgrep')
    expect(invocation.argv.at(-1)).toBe('.')
    expect(invocation.workingDirectory).toBe('.')
    expect(invocation.timeLimitSeconds).toBe(300)
  })

  test('excludes the directories recon ignores by default', () => {
    const invocation = buildInvocation(SEMGREP, { rulePaths: ['/r.yaml'] }, 300)
    const excludes = invocation.argv.flatMap((arg, index, all) =>
      arg === '--exclude' ? [all[index + 1]] : [],
    )

    expect(excludes).toContain('node_modules')
    expect(excludes).toContain('.git')
  })

  test('refuses an engine with no invocation builder rather than guessing', () => {
    expect(() =>
      buildInvocation({ ...SEMGREP, engine: 'codeql' }, { rulePaths: [] }, 60),
    ).toThrow(/No invocation builder/)
  })
})

describe('runBaselineEngines', () => {
  const spawnWith = (stdout: string, exitCode = 0): SandboxSpawn => async () => ({
    exitCode,
    stdout,
    stderr: '',
    timedOut: false,
  })

  test('runs the engine and persists normalized candidates', async () => {
    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      db,
      runId: 'run-1',
      scratchDir: scratch,
      detect: bwrapOnly,
      spawn: spawnWith(sarifFor('a.c', 3)),
    })

    expect(result.enginesAttempted).toBe(1)
    expect(result.candidates).toHaveLength(1)
    expect(result.stoppedBy).toBeNull()

    const candidate = result.candidates[0]!
    expect(candidate).toMatchObject({
      source: 'semgrep',
      patternId: 'wb-c-unbounded-string-op',
      filePath: 'a.c',
      startLine: 3,
      cwe: 'CWE-120',
      state: 'new',
    })
    expect(candidate.normalized.snippet).toContain('strcpy(dst, src);')

    expect(readCandidateSummary(db, 'run-1')).toMatchObject({
      total: 1,
      bySource: [{ source: 'semgrep', count: 1 }],
    })
  })

  test('records an engine that exited non-zero as failed, not as clean', async () => {
    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      db,
      runId: 'run-1',
      scratchDir: scratch,
      detect: bwrapOnly,
      spawn: spawnWith('', 2),
    })

    const execution = result.executions[0]!
    expect(execution.failed).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/exited 2/)
  })

  test('treats valid SARIF that reports executionSuccessful:false as a failure', async () => {
    // The runner sees exit 0, so only the SARIF invocation can reveal that the
    // engine did not actually complete. This is the killed-worker case.
    const sarif = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'Semgrep OSS', rules: [] } },
          invocations: [
            {
              executionSuccessful: false,
              toolExecutionNotifications: [
                { level: 'error', message: { text: 'semgrep-core killed (out of memory)' } },
              ],
            },
          ],
          results: [],
        },
      ],
    })

    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      db,
      runId: 'run-1',
      scratchDir: scratch,
      detect: bwrapOnly,
      spawn: spawnWith(sarif, 0),
    })

    const execution = result.executions[0]!
    expect(execution.exitCode).toBe(0)
    expect(execution.failed).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.warnings.join(' ')).toMatch(/out of memory/)
    expect(result.warnings.join(' ')).toMatch(/not a clean result/)
  })

  test('flags a killed engine and keeps whatever it managed to print', async () => {
    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      db,
      runId: 'run-1',
      scratchDir: scratch,
      detect: bwrapOnly,
      spawn: async () => ({
        exitCode: 137,
        stdout: sarifFor('a.c', 3),
        stderr: '',
        timedOut: true,
      }),
    })

    const execution = result.executions[0]!
    expect(execution.timedOut).toBe(true)
    expect(execution.failed).toBe(true)
    expect(result.candidates).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/killed at its/)
  })

  test('stops before starting an engine when the budget is spent', async () => {
    // The first read is when the session starts; every later read is 200s on,
    // which is past this 100s stage's whole quota.
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { 'static-core': 1 },
      db,
      runId: 'run-1',
      now: clockOf(0, 200_000),
      decide: async () => ({ action: 'degrade', decidedBy: 'policy:--yes' }),
    })

    let spawned = false
    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      db,
      runId: 'run-1',
      scratchDir: scratch,
      governor,
      detect: bwrapOnly,
      spawn: async () => {
        spawned = true
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    expect(spawned).toBe(false)
    expect(result.enginesAttempted).toBe(0)
    expect(result.stoppedBy).toBe('budget-degrade')
    expect(
      db.query<{ action: string }, []>('SELECT action FROM budget_events').get(),
    ).toEqual({ action: 'degrade' })
  })

  test('honours an abort decision by stopping the stage', async () => {
    const governor = createBudgetGovernor({
      totalSeconds: 100,
      shares: { 'static-core': 1 },
      now: clockOf(0, 200_000),
      decide: async () => ({ action: 'abort', decidedBy: 'human' }),
    })

    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      scratchDir: scratch,
      governor,
      detect: bwrapOnly,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    expect(result.stoppedBy).toBe('budget-abort')
  })

  test('caps the engine time limit at the stage quota, never above the ceiling', async () => {
    // Stage starts at 0, then 940s have already elapsed, leaving 60s of quota
    // against an engine ceiling of 600s.
    const governor = createBudgetGovernor({
      totalSeconds: 1000,
      shares: { 'static-core': 1 },
      now: clockOf(0, 940_000),
    })

    let observed = 0
    await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [SEMGREP],
      rulePaths: ['/rules/security.yaml'],
      scratchDir: scratch,
      governor,
      engineCapSeconds: 600,
      detect: bwrapOnly,
      spawn: async (_argv, timeoutMs) => {
        observed = timeoutMs
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
      },
    })

    // 60s of quota left, so the engine gets 60s even though its own cap is 600.
    expect(observed).toBe(60_000)
    expect(observed).toBeGreaterThanOrEqual(MIN_ENGINE_SECONDS * 1000)
  })

  test('keeps unavailable engines in the result so the gap is visible', async () => {
    const result = await runBaselineEngines({
      targetRoot: root,
      targetId: 'target-1',
      commitSha: 'abc',
      engines: [],
      rulePaths: [],
      unavailable: [
        { engine: 'codeql', reason: 'recognized, but not driven yet', unimplemented: true },
      ],
      scratchDir: scratch,
      detect: bwrapOnly,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })

    expect(result.enginesAttempted).toBe(0)
    expect(result.unavailable).toEqual([
      { engine: 'codeql', reason: 'recognized, but not driven yet', unimplemented: true },
    ])
  })
})
