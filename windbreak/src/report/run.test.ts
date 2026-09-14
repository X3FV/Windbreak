import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { parseSarif } from '../engines/sarif'
import { createProgramContext } from '../pipeline'
import { seedState } from '../pipeline/test-support'

import { readLedger } from './persist'
import { runReport } from './run'

import type { SeededState } from '../pipeline/test-support'

let root: string
let targetDir: string
let outDir: string
let seeded: SeededState | null = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-report-'))
  targetDir = path.join(root, 'target')
  outDir = path.join(root, 'out')
  fs.mkdirSync(path.join(targetDir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(targetDir, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.10)\nproject(t C)\n',
  )
  fs.writeFileSync(path.join(targetDir, 'src', 'handler.c'), 'int x;\n')
})

afterEach(() => {
  seeded?.db.close()
  seeded = null
  fs.rmSync(root, { recursive: true, force: true })
})

const insertVerdict = (
  state: SeededState,
  candidateId: string,
  role: string,
  output: unknown,
): void => {
  state.db
    .prepare(
      `INSERT INTO verdicts
         (id, candidate_id, stage, role, model_id, provider, temperature, seed,
          seed_supported, cache_key, output_json, created_at)
       VALUES (?, ?, 'verification', ?, ?, ?, 0, 42, 0, ?, ?, NULL)`,
    )
    .run(
      `${candidateId}-${role}`,
      candidateId,
      role,
      `${role}-model`,
      `vendor-${role}`,
      `${candidateId}-${role}-key`,
      JSON.stringify(output),
    )
}

interface SeedOptions {
  states?: Record<string, string>
  decision?: { candidateId: string; decision: 'real' | 'benign' }
}

const seed = (options: SeedOptions = {}): SeededState => {
  const state = seedState({
    candidates: [
      { id: 'cand-1', filePath: 'src/handler.c', startLine: 13 },
      { id: 'cand-2', filePath: 'src/handler.c', startLine: 20 },
      { id: 'cand-3', filePath: 'src/handler.c', startLine: 30 },
    ],
    symbols: [{ filePath: 'src/handler.c', name: 'parse_header', startLine: 10, endLine: 18 }],
    symbolRefs: [{ filePath: 'src/handler.c', name: 'parse_header', line: 40 }],
  })

  state.db
    .prepare('UPDATE targets SET location = ?, build_model = ?, scope_class = ? WHERE id = ?')
    .run(targetDir, 'compile_commands', 'userspace-c', state.targetId)

  for (const [candidateId, value] of Object.entries(options.states ?? {})) {
    state.db
      .prepare('UPDATE candidates SET state = ? WHERE id = ?')
      .run(value, candidateId)
  }

  for (const candidateId of state.candidateIds) {
    insertVerdict(state, candidateId, 'triage', { label: 'likely-real', rationale: 'looks real' })
    insertVerdict(state, candidateId, 'proposer', {
      verdict: 'real',
      reasoning: 'the caller passes attacker data',
      preconditions: ['attacker controls body'],
    })
    insertVerdict(state, candidateId, 'refuter', {
      verdict: 'real',
      reasoning: 'no guard exists',
      preconditions: [],
    })
  }

  if (options.decision) {
    state.db
      .prepare(
        `INSERT INTO adjudication_queue
           (candidate_id, run_id, proposer_verdict_id, refuter_verdict_id, decision, decided_at, rationale)
         VALUES (?, ?, 'pv', 'rv', ?, NULL, NULL)`,
      )
      .run(options.decision.candidateId, state.runId, options.decision.decision)
  }

  seeded = state
  return state
}

const report = async (state: SeededState, overrides: Record<string, unknown> = {}) =>
  runReport({
    db: state.db,
    runId: state.runId,
    targetId: state.targetId,
    targetLocation: targetDir,
    commitSha: 'abc123',
    version: '0.0.1',
    outDir,
    programContext: createProgramContext(state.db, state.targetId),
    log: () => {},
    ...overrides,
  })

describe('runReport', () => {
  test('writes SARIF, an index, a writeup, and a harness for a confirmed finding', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)

    expect(result.findings).toHaveLength(1)
    expect(fs.existsSync(result.sarifPath)).toBe(true)
    expect(fs.existsSync(result.indexPath)).toBe(true)

    const finding = result.findings[0]!
    expect(fs.existsSync(finding.writeupPath)).toBe(true)
    expect(finding.harnessFiles.map((file) => path.basename(file))).toEqual([
      'poc.c',
      'build-and-run.sh',
    ])
    for (const file of finding.harnessFiles) expect(fs.existsSync(file)).toBe(true)
  })

  test('the SARIF it writes is readable by our own SARIF reader', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)

    const document: unknown = JSON.parse(fs.readFileSync(result.sarifPath, 'utf8'))
    const parsed = parseSarif(document, 'semgrep')

    expect(parsed.executionFailed).toBe(false)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]!.filePath).toBe('src/handler.c')
    expect(parsed.findings[0]!.startLine).toBe(13)
  })

  test('records the finding and drafts a ledger entry', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)

    const row = state.db
      .query<{ sarif_path: string; writeup_path: string; evidence_tier: string }, []>(
        'SELECT sarif_path, writeup_path, evidence_tier FROM findings',
      )
      .get()

    expect(row?.evidence_tier).toBe('statically-verified')
    expect(row?.sarif_path).toBe(result.sarifPath)
    expect(row?.writeup_path).toBe(result.findings[0]!.writeupPath)

    expect(readLedger(state.db)).toEqual([
      expect.objectContaining({ findingId: result.findings[0]!.id, status: 'drafted' }),
    ])
  })

  test('re-running does not reset a ledger status the researcher moved on', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const first = await report(state)
    const findingId = first.findings[0]!.id

    state.db
      .prepare(`UPDATE ledger SET status = 'submitted', channel = 'email' WHERE finding_id = ?`)
      .run(findingId)

    await report(state)

    const row = readLedger(state.db).find((entry) => entry.findingId === findingId)
    expect(row?.status).toBe('submitted')
    expect(row?.channel).toBe('email')
  })

  test('reports a contested disagreement with the lower SARIF level', async () => {
    const state = seed({ states: { 'cand-1': 'escalated' } })
    const result = await report(state)

    expect(result.findings[0]!.evidenceTier).toBe('contested')

    const document = JSON.parse(fs.readFileSync(result.sarifPath, 'utf8')) as {
      runs: Array<{ results: Array<{ level: string }> }>
    }
    expect(document.runs[0]!.results[0]!.level).toBe('note')
  })

  test('an escalated candidate the human rejected is listed, not reported', async () => {
    const state = seed({
      states: { 'cand-1': 'escalated' },
      decision: { candidateId: 'cand-1', decision: 'benign' },
    })
    const result = await report(state)

    expect(result.findings).toHaveLength(0)
    expect(result.excluded).toHaveLength(1)
    expect(result.excluded[0]!.reason).toMatch(/benign/)
    expect(fs.readFileSync(result.indexPath, 'utf8')).toContain('Candidates not reported')
  })

  test('separates rediscoveries from findings in the index', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed', 'cand-2': 'rediscovery' } })
    state.db
      .prepare(`UPDATE candidates SET osv_match_json = ? WHERE id = 'cand-2'`)
      .run(JSON.stringify({ vulnId: 'GHSA-1', signals: ['file-path'], basis: 'named in GHSA-1' }))

    const result = await report(state)

    expect(result.findings).toHaveLength(1)
    expect(result.rediscoveries).toHaveLength(1)
    expect(result.rediscoveries[0]!.vulnId).toBe('GHSA-1')
    expect(fs.readFileSync(result.indexPath, 'utf8')).toContain('known vulnerabilities, not discoveries')
  })

  test('applies an asserted reproduction and warns about an unknown candidate id', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state, { reproduced: ['cand-1', 'cand-typo'] })

    expect(result.findings[0]!.evidenceTier).toBe('human-reproduced')
    expect(result.warnings.join(' ')).toMatch(/cand-typo matched no reportable candidate/)
  })

  test('includes real build steps from the target in the harness', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)

    const script = fs.readFileSync(result.findings[0]!.harnessFiles[1]!, 'utf8')
    expect(script).toContain('cmake')
  })

  test('says the report is partial when the run was not complete', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    state.db.prepare(`UPDATE runs SET status = 'partial' WHERE id = ?`).run(state.runId)

    const result = await report(state)

    expect(result.partial).toBe(true)
    expect(fs.readFileSync(result.indexPath, 'utf8')).toContain('this report is partial')
  })

  test('is complete when the run was complete', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    expect((await report(state)).partial).toBe(false)
  })

  test('the index table states the class, not the finding id', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)
    const index = fs.readFileSync(result.indexPath, 'utf8')
    const row = index.split('\n').find((line) => line.startsWith('| Unbounded copy'))

    expect(row).toBeDefined()

    // Columns: [empty, Finding, Class, Tier, Location, Writeup, empty].
    const cells = row!.split('|').map((cell) => cell.trim())
    expect(cells[2]).toBe('CWE-120')
    expect(cells[1]).toBe('Unbounded copy in parse_header')
  })

  test('reports zero findings honestly rather than failing', async () => {
    const state = seed({ states: { 'cand-1': 'dropped', 'cand-2': 'dropped', 'cand-3': 'dropped' } })
    const result = await report(state)

    expect(result.findings).toEqual([])
    expect(fs.existsSync(result.sarifPath)).toBe(true)
    expect(fs.readFileSync(result.indexPath, 'utf8')).toContain(
      'No candidate survived to a reportable finding',
    )
  })
})

describe('report artifacts are private (§17 item 8)', () => {
  test('the output directory and every file are unreadable to group and others', async () => {
    const state = seed({ states: { 'cand-1': 'confirmed' } })
    const result = await report(state)

    const modeOf = (p: string) => fs.statSync(p).mode & 0o777
    // No group or other bits: the writeups carry live exploit detail.
    expect(modeOf(result.outDir) & 0o077).toBe(0)

    for (const p of [
      result.sarifPath,
      result.indexPath,
      result.findings[0]!.writeupPath,
      ...result.findings[0]!.harnessFiles,
    ]) {
      expect(modeOf(p) & 0o077).toBe(0)
    }
  })
})
