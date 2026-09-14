import { afterEach, describe, expect, test } from 'bun:test'

import { seedState } from '../pipeline/test-support'
import { readPipelineSummary } from '../pipeline/persist'
import { DEFAULT_MODEL_CONFIG } from '../models'
import {
  investigatorTurnId,
  readInvestigatorSummary,
  readInvestigatorTurns,
  readInvestigatorTurnsForCandidate,
  readWorkingCopies,
  recordInvestigatorTurn,
  recordWorkingCopy,
} from './persist'

import type { SeededState } from '../pipeline/test-support'
import type { WorkingCopy } from './copy'
import type { CopyWriteRecord, ToolResultRecord } from './tools'

let seeded: SeededState | null = null

afterEach(() => {
  seeded?.db.close()
  seeded = null
})

/** One candidate, so an `explain` turn has something to attach to. */
const state = (): SeededState =>
  seedState({ candidates: [{ id: 'cand-1', filePath: 'src/a.c', startLine: 4 }] })

const toolCall = (overrides: Partial<ToolResultRecord> = {}): ToolResultRecord => ({
  tool: 'read_target_file',
  signals: [],
  sourceBytes: 100,
  truncated: false,
  error: null,
  ...overrides,
})

const record = (input: {
  runId: string
  mode?: 'explain' | 'hunt'
  agent?: 'investigator' | 'engineer'
  workingCopyId?: string | null
  candidateId?: string | null
  prompt?: string
  answer?: string | null
  error?: string | null
  toolCalls?: ToolResultRecord[]
  writes?: CopyWriteRecord[]
  now?: () => number
}) => {
  if (!seeded) throw new Error('no seeded state')
  return recordInvestigatorTurn({
    db: seeded.db,
    runId: input.runId,
    candidateId: input.candidateId ?? null,
    mode: input.mode ?? 'explain',
    ...(input.agent ? { agent: input.agent } : {}),
    workingCopyId: input.workingCopyId ?? null,
    prompt: input.prompt ?? 'is this real?',
    answer: input.answer === undefined ? 'It is benign.' : input.answer,
    error: input.error ?? null,
    model: DEFAULT_MODEL_CONFIG.investigator,
    provider: 'deepseek',
    toolCalls: input.toolCalls ?? [toolCall()],
    writes: input.writes ?? [],
    ...(input.now ? { now: input.now } : {}),
  })
}

const writeRecord = (overrides: Partial<CopyWriteRecord> = {}): CopyWriteRecord => ({
  tool: 'write_copy_file',
  path: 'poc/trigger.c',
  action: 'create',
  bytes: 40,
  inserted: 0,
  removed: 0,
  ...overrides,
})

describe('recording an investigator turn', () => {
  test('round-trips an explain turn with its role and provenance', () => {
    seeded = state()
    const written = record({
      runId: seeded.runId,
      candidateId: 'cand-1',
      prompt: 'Does src/a.c overflow?',
      answer: 'Yes, at src/a.c:4.',
    })

    // The literal is the invariant: a consumer can discriminate on it, and it is not a
    // member of `ModelRole`, which is the union the verdict path accepts.
    expect(written.role).toBe('investigator')
    expect(written.toolDerived).toBe(true)

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read).toEqual(written)
    expect(read?.candidateId).toBe('cand-1')
    expect(read?.answer).toBe('Yes, at src/a.c:4.')
    expect(read?.modelId).toBe(DEFAULT_MODEL_CONFIG.investigator.model)
  })

  test('a hunt has no candidate and is still recorded', () => {
    // §20.29.4's second mode: hunting has no queue entry to attach to, and a table
    // that could not hold it would force a fake candidate row.
    seeded = state()
    record({ runId: seeded.runId, mode: 'hunt', prompt: 'find integer overflows' })

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.mode).toBe('hunt')
    expect(read?.candidateId).toBeNull()
    expect(readInvestigatorTurnsForCandidate(seeded.db, 'cand-1')).toHaveLength(0)
  })

  test('a failed turn is recorded, so "no answer" is not "never asked"', () => {
    seeded = state()
    record({
      runId: seeded.runId,
      answer: null,
      error: 'investigator: rate limited',
      toolCalls: [],
    })

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.answer).toBeNull()
    expect(read?.error).toContain('rate limited')
    // Not tool-derived: there is nothing an answer could have been derived from.
    expect(read?.toolDerived).toBe(false)

    const summary = readInvestigatorSummary(seeded.db, seeded.runId)
    expect(summary.turns).toBe(1)
    expect(summary.failed).toBe(1)
  })

  test('instruction-like content in tool results survives into the row', () => {
    // §20.29.3's third consequence: the signals are stored, so an answer produced by
    // attacker-influenced reasoning is reviewable *as* one.
    seeded = state()
    record({
      runId: seeded.runId,
      toolCalls: [
        toolCall({
          signals: [
            {
              kind: 'instruction-override',
              evidence: 'ignore all previous instructions',
              line: 1,
            },
          ],
        }),
        toolCall({ tool: 'run_in_target' }),
      ],
    })

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.injectionSignals).toHaveLength(1)
    expect(read?.injectionSignals[0]?.kind).toBe('instruction-override')
    expect(read?.toolCalls.map((call) => call.tool)).toEqual([
      'read_target_file',
      'run_in_target',
    ])

    const summary = readInvestigatorSummary(seeded.db, seeded.runId)
    expect(summary.withSignals).toBe(1)
  })

  test('asking the same question twice replaces the row rather than duplicating it', () => {
    seeded = state()
    record({ runId: seeded.runId, candidateId: 'cand-1', prompt: 'same question' })
    record({
      runId: seeded.runId,
      candidateId: 'cand-1',
      prompt: 'same question',
      answer: 'a better answer',
    })

    const turns = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.answer).toBe('a better answer')
  })

  test('the turn id is a function of the question, not of the clock', () => {
    const base = { runId: 'run-1', mode: 'hunt' as const, candidateId: null }

    expect(investigatorTurnId({ ...base, prompt: 'a' })).toBe(
      investigatorTurnId({ ...base, prompt: 'a' }),
    )
    expect(investigatorTurnId({ ...base, prompt: 'a' })).not.toBe(
      investigatorTurnId({ ...base, prompt: 'b' }),
    )
    // The candidate is part of it, so the same question about two candidates is two rows.
    expect(investigatorTurnId({ ...base, prompt: 'a' })).not.toBe(
      investigatorTurnId({ ...base, candidateId: 'cand-1', prompt: 'a' }),
    )
  })

  test('a mode this version does not know reads as unknown, not as hunt', () => {
    // The row can only carry a third mode if some other writer put it there. Coercing
    // it into `hunt` would report an unreadable row as a search for candidates (§18).
    seeded = state()
    const written = record({ runId: seeded.runId, mode: 'hunt' })
    seeded.db
      .prepare(`UPDATE investigator_turns SET mode = 'grep-for-secrets' WHERE id = ?`)
      .run(written.id)

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.mode).toBe('unknown')
    // The stored value is still visible in the summary, so nothing is hidden.
    expect(readInvestigatorSummary(seeded.db, seeded.runId).byMode).toEqual([
      { mode: 'grep-for-secrets', count: 1 },
    ])
  })

  test('a turn writes nothing to verdicts and moves no candidate', () => {
    // The structural claim of slice 3, asserted rather than described: the investigator
    // has a table of its own, and recording an answer is not a step in the pipeline.
    seeded = state()
    const before = readPipelineSummary(seeded.db, seeded.runId)

    record({ runId: seeded.runId, candidateId: 'cand-1', answer: 'real, definitely' })

    const after = readPipelineSummary(seeded.db, seeded.runId)
    expect(after.verdicts).toBe(before.verdicts)
    expect(after.byState).toEqual(before.byState)
    expect(after.queuePending).toBe(0)

    const verdictRows = seeded.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM verdicts')
      .get()?.n
    expect(verdictRows).toBe(0)
  })
})

describe('which agent, and what it wrote (§20.30)', () => {
  test('a turn records its agent, its copy and its writes', () => {
    seeded = state()
    const written = record({
      runId: seeded.runId,
      agent: 'engineer',
      workingCopyId: 'wcopy_1',
      candidateId: null,
      mode: 'hunt',
      prompt: 'patch it',
      writes: [writeRecord()],
    })

    expect(written.agent).toBe('engineer')
    expect(written.workingCopyId).toBe('wcopy_1')
    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.agent).toBe('engineer')
    expect(read?.workingCopyId).toBe('wcopy_1')
    expect(read?.writes).toHaveLength(1)
    expect(read?.writes[0]?.path).toBe('poc/trigger.c')
  })

  test('an unstated agent records as the investigator, so an old caller is unchanged', () => {
    seeded = state()
    const written = record({ runId: seeded.runId, candidateId: 'cand-1' })
    expect(written.agent).toBe('investigator')
    expect(written.workingCopyId).toBeNull()
    expect(written.writes).toEqual([])
  })

  test('an agent this version does not know reads as unknown, not as the investigator', () => {
    // Coercing it would attribute a write to the read-only agent, which is the one
    // attribution this column exists to get right.
    seeded = state()
    const written = record({ runId: seeded.runId, candidateId: 'cand-1' })
    seeded.db
      .prepare(`UPDATE investigator_turns SET agent = 'architect' WHERE id = ?`)
      .run(written.id)

    const [read] = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(read?.agent).toBe('unknown')
    expect(readInvestigatorSummary(seeded.db, seeded.runId).byAgent).toEqual([
      { agent: 'architect', count: 1 },
    ])
  })

  test('the same question to two agents is two rows, not one replacing the other', () => {
    // Without the agent in the turn id the engineer's answer would overwrite the
    // investigator's, losing exactly the comparison the switch exists to allow.
    seeded = state()
    record({ runId: seeded.runId, candidateId: null, mode: 'hunt', prompt: 'is it real?' })
    record({
      runId: seeded.runId,
      agent: 'engineer',
      candidateId: null,
      mode: 'hunt',
      prompt: 'is it real?',
      workingCopyId: 'wcopy_1',
    })

    const turns = readInvestigatorTurns(seeded.db, seeded.runId)
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.agent)).toEqual(['investigator', 'engineer'])
  })

  test('the turn id is a function of the agent, the question and the run', () => {
    const base = { runId: 'run-1', mode: 'hunt' as const, candidateId: null, prompt: 'q' }
    expect(investigatorTurnId(base)).toBe(investigatorTurnId(base))
    expect(investigatorTurnId(base)).not.toBe(
      investigatorTurnId({ ...base, agent: 'engineer' }),
    )
  })

  test('the summary counts turns that wrote, separately from turns that did not', () => {
    seeded = state()
    record({ runId: seeded.runId, candidateId: 'cand-1' })
    record({
      runId: seeded.runId,
      agent: 'engineer',
      candidateId: null,
      mode: 'hunt',
      prompt: 'patch it',
      writes: [writeRecord(), writeRecord({ path: 'src/a.c', action: 'update' })],
    })

    const summary = readInvestigatorSummary(seeded.db, seeded.runId)
    expect(summary.turns).toBe(2)
    // One *turn* wrote, whatever number of files it touched.
    expect(summary.wrote).toBe(1)
    expect(summary.byAgent).toEqual([
      { agent: 'engineer', count: 1 },
      { agent: 'investigator', count: 1 },
    ])
  })

  test('a working copy round-trips, and its rows are per run', () => {
    seeded = state()
    const copy: WorkingCopy = {
      id: 'wcopy_1',
      root: '/repo/.windbreak/scratch/investigator/working-copy',
      targetDir: '/repo',
      baseCommit: 'abc123',
      strategy: 'filtered-copy',
      files: 12,
      bytes: 4096,
      createdAt: '2026-09-13T00:00:00.000Z',
      excluded: ['.git'],
    }

    const stored = recordWorkingCopy({
      db: seeded.db,
      runId: seeded.runId,
      targetId: seeded.targetId,
      copy,
    })

    expect(stored.strategy).toBe('filtered-copy')
    expect(readWorkingCopies(seeded.db, seeded.runId)).toEqual([stored])
    // And a recording is idempotent on the copy's own id, so a re-recorded copy is one
    // row rather than two identities for one tree.
    recordWorkingCopy({ db: seeded.db, runId: seeded.runId, targetId: seeded.targetId, copy })
    expect(readWorkingCopies(seeded.db, seeded.runId)).toHaveLength(1)
  })
})
