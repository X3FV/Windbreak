import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { applySchema } from '../state/db'

import { createReviewInvestigator } from './investigator'

import type { CodebuffClient } from '@codebuff/sdk'
import type { InvestigatorAgentName } from '../investigate/agents'
import type { ReviewInvestigator } from './investigator'

const dirs: string[] = []
const databases: Database[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  for (const db of databases.splice(0)) db.close()
})

/** A real target directory: the bridge resolves a workspace from it, so it must exist. */
const makeTarget = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-bridge-'))
  dirs.push(dir)
  fs.writeFileSync(path.join(dir, 'copy.c'), 'int main(void) { return 0; }\n')
  return dir
}

/** A state database with one target at `targetDir` and one run over it. */
const seed = (targetDir: string): Database => {
  const db = new Database(':memory:')
  databases.push(db)
  applySchema(db)
  // The pinned revision lives on the *target*, which is where the codebase pane reads it
  // too (§20.30) — so the copy's base commit and the listing's commit agree.
  db.prepare('INSERT INTO targets (id, location, commit_sha) VALUES (?, ?, ?)').run(
    'target-1',
    targetDir,
    'abc123',
  )
  db.prepare(
    'INSERT INTO runs (id, target_id, config_json, commit_sha, status) VALUES (?, ?, ?, ?, ?)',
  ).run('run-1', 'target-1', '{}', 'abc123', 'complete')
  return db
}

/**
 * A client that answers with prose and reports `calls` root model requests.
 *
 * Counting its invocations is how the test proves a refused turn never reached the
 * model — the whole point of a ceiling checked before the expensive thing.
 */
const answeringClient = (input: { calls: number; answer?: string }) => {
  let invocations = 0
  const client = {
    run: async (options: { onUsage?: (usage: { isRoot: boolean; totalTokens: number }) => void }) => {
      invocations += 1
      for (let index = 0; index < input.calls; index += 1) {
        options.onUsage?.({ isRoot: true, totalTokens: 100 })
      }
      return {
        output: {
          type: 'lastMessage',
          value: [{ role: 'assistant', content: input.answer ?? 'It is benign.' }],
        },
      }
    },
  } as unknown as CodebuffClient

  return { client, invocations: () => invocations }
}

const bridge = (db: Database, client: CodebuffClient, maxConversationCalls: number) =>
  createReviewInvestigator({ db, client, maxConversationCalls })

const ask = (
  investigator: ReviewInvestigator,
  input: {
    mode?: 'explain' | 'hunt'
    agent?: 'investigator' | 'engineer'
    prompt?: string
    signal?: AbortSignal
    /** Null names no run, which is §20.31's unscanned checkout. */
    runId?: string | null
  } = {},
) =>
  investigator.ask({
    runId: input.runId === undefined ? 'run-1' : input.runId,
    candidateId: null,
    mode: input.mode ?? 'hunt',
    ...(input.agent ? { agent: input.agent } : {}),
    prompt: input.prompt ?? 'is anything here a bug?',
    ...(input.signal ? { signal: input.signal } : {}),
  })

describe('the conversation ceiling in the pane (spec §20.29.6)', () => {
  test('it starts unspent and reports the configured limit', () => {
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 1 })

    const investigator = bridge(db, client, 40)
    expect(investigator.budget()).toEqual({
      calls: 0,
      limit: 40,
      turns: 0,
      tokens: 0,
      exhausted: false,
      remaining: 40,
    })
  })

  test('a turn charges what the provider reported and returns the state', async () => {
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 3 })

    const turn = await ask(bridge(db, client, 40))

    expect(turn.ok).toBe(true)
    expect(turn.budget.calls).toBe(3)
    expect(turn.budget.turns).toBe(1)
    expect(turn.budget.tokens).toBe(300)
    expect(turn.budget.remaining).toBe(37)
  })

  test('the count spans turns, and a spent conversation refuses before calling the model', async () => {
    const db = seed(makeTarget())
    const { client, invocations } = answeringClient({ calls: 4 })

    const investigator = bridge(db, client, 6)
    const first = await ask(investigator)
    expect(first.ok).toBe(true)
    expect(invocations()).toBe(1)

    // 4 of 6 spent. A second turn of 4 would overshoot, and the ceiling is checked
    // before the run rather than after it.
    const second = await ask(investigator)
    expect(second.ok).toBe(true)
    expect(second.budget.calls).toBe(8)
    expect(second.budget.exhausted).toBe(true)
    expect(invocations()).toBe(2)

    // The third must not reach the model at all, and must say how spent it is.
    const third = await ask(investigator)
    expect(third.ok).toBe(false)
    expect(third.error as string).toContain('spent its ceiling')
    expect(third.error as string).toContain('8/6')
    expect(third.answer).toBeNull()
    expect(invocations()).toBe(2)
    expect(third.budget.exhausted).toBe(true)
  })

  test('a hunt and an explain draw on the same budget', async () => {
    // §20.29.6 asks this directly. Two counters would let a researcher alternate modes
    // to spend twice the ceiling, so there is one — and the second mode's spend is added
    // to the first's rather than measured against a ceiling of its own.
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 3 })
    const investigator = bridge(db, client, 4)

    const hunt = await ask(investigator, { mode: 'hunt' })
    expect(hunt.budget.calls).toBe(3)
    expect(hunt.budget.exhausted).toBe(false)

    // The explain's own three calls land on the hunt's counter, and the two together
    // are what exhausts the conversation. A per-mode budget would have left this at 3.
    const explain = await ask(investigator, { mode: 'explain' })
    expect(explain.budget.calls).toBe(6)
    expect(explain.budget.exhausted).toBe(true)

    // And the next question, in either mode, is refused by the shared counter.
    const refused = await ask(investigator, { mode: 'hunt' })
    expect(refused.ok).toBe(false)
    expect(refused.budget.calls).toBe(6)
  })

  test('a failed turn is charged, because it still made the calls it made', async () => {
    const db = seed(makeTarget())
    const client = {
      run: async () => ({ output: { type: 'error', message: 'rate limited' } }),
    } as unknown as CodebuffClient

    const turn = await ask(bridge(db, client, 40))

    expect(turn.ok).toBe(false)
    // No usage was reported, so the floor of one call applies — and the point is that a
    // failure is not free, or a conversation could spend a day failing.
    expect(turn.budget.calls).toBe(1)
  })
})

describe('cancelling a turn from the pane', () => {
  test('the signal reaches the run, and the turn is recorded as cancelled', async () => {
    const db = seed(makeTarget())
    const controller = new AbortController()
    let sawSignal: AbortSignal | undefined

    const client = {
      run: async (options: { signal?: AbortSignal }) => {
        sawSignal = options.signal
        controller.abort()
        return { output: { type: 'error', message: 'Run cancelled by user.' } }
      },
    } as unknown as CodebuffClient

    const turn = await ask(bridge(db, client, 40), { signal: controller.signal })

    // The plumbing the old open item said did not exist: a signal that arrives at the
    // SDK's own cancellation path.
    expect(sawSignal).toBe(controller.signal)
    expect(turn.cancelled).toBe(true)
    expect(turn.error as string).toContain('cancelled')

    // Cancelled is not unrecorded. A stopped turn is a turn that happened.
    expect(turn.recordedTurnId).not.toBeNull()
  })

  test('a turn that was not cancelled is not marked cancelled', async () => {
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 1 })

    const turn = await ask(bridge(db, client, 40))
    expect(turn.cancelled).toBe(false)
  })
})

describe('the working copy and the switch (§20.30)', () => {
  const turnAgent = (turn: { agent: InvestigatorAgentName }) => turn.agent

  test('an investigator turn makes no copy, and says it has none', async () => {
    // Materialising a copy is O(tree); a researcher who opened the screen to read two
    // arguments must not pay for one.
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 1 })
    const investigator = bridge(db, client, 40)

    const turn = await ask(investigator)

    expect(turnAgent(turn)).toBe('investigator')
    expect(turn.workingCopyId).toBeNull()
    expect(turn.writes).toEqual([])
    expect(investigator.workingCopy()).toBeNull()
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM working_copies').get()?.n,
    ).toBe(0)
  })

  test('an engineer turn materialises the copy, records it, and names it on the turn', async () => {
    const target = makeTarget()
    const db = seed(target)
    const { client } = answeringClient({ calls: 1 })
    const investigator = bridge(db, client, 40)

    const turn = await ask(investigator, { agent: 'engineer' })

    expect(turnAgent(turn)).toBe('engineer')
    expect(turn.ok).toBe(true)

    const info = investigator.workingCopy()
    expect(info).not.toBeNull()
    expect(turn.workingCopyId).toBe(info?.id ?? null)
    // The copy is inside the scratch convention, never the target's own tree.
    expect(info?.root).toContain('.windbreak/scratch/investigator/working-copy')
    expect(info?.files).toBe(1)
    expect(info?.baseCommit).toBe('abc123')
    expect(fs.readFileSync(path.join(info!.root, 'copy.c'), 'utf8')).toBe(
      'int main(void) { return 0; }\n',
    )

    const rows = db
      .query<{ path: string; strategy: string; base_commit_sha: string | null }, []>(
        'SELECT path, strategy, base_commit_sha FROM working_copies',
      )
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.strategy).toBe('filtered-copy')
    expect(rows[0]?.base_commit_sha).toBe('abc123')
  })

  test('the copy is made once and reused, so a second engineer turn keeps its edits', async () => {
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 1 })
    const investigator = bridge(db, client, 40)

    const first = await ask(investigator, { agent: 'engineer' })
    const second = await ask(investigator, { agent: 'engineer', prompt: 'and again' })

    expect(second.workingCopyId).toBe(first.workingCopyId)
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM working_copies').get()?.n,
    ).toBe(1)
  })

  test('a write reaches the turn, the transcript, and the copy — not the target', async () => {
    const target = makeTarget()
    const db = seed(target)

    const client = {
      run: async (options: {
        customToolDefinitions?: Array<{
          toolName: string
          execute: (params: unknown) => Promise<unknown>
        }>
      }) => {
        const write = options.customToolDefinitions?.find(
          (tool) => tool.toolName === 'write_copy_file',
        )
        await write?.execute({ path: 'poc/trigger.c', content: 'int main(void) { return 1; }\n' })
        return {
          output: { type: 'lastMessage', value: [{ role: 'assistant', content: 'wrote it' }] },
        }
      },
    } as unknown as CodebuffClient

    const investigator = bridge(db, client, 40)
    const turn = await ask(investigator, { agent: 'engineer' })

    expect(turn.writes).toHaveLength(1)
    expect(turn.writes[0]?.path).toBe('poc/trigger.c')
    // The evidence is untouched, which is the property the whole slice is arranged for.
    expect(fs.existsSync(path.join(target, 'poc'))).toBe(false)

    const row = db
      .query<{ agent: string; working_copy_id: string | null; writes_json: string | null }, []>(
        'SELECT agent, working_copy_id, writes_json FROM investigator_turns',
      )
      .get()
    expect(row?.agent).toBe('engineer')
    expect(row?.working_copy_id).toBe(turn.workingCopyId)
    expect(row?.writes_json).not.toBeNull()
  })

  test('a copy that cannot be made fails the turn, and never answers from the target', async () => {
    // The §18 substitution in the worst place: a model that believes it edited a tree it
    // never touched, and a transcript that records an edit as having happened.
    const target = makeTarget()
    const db = seed(target)
    const { client, invocations } = answeringClient({ calls: 1 })
    fs.rmSync(target, { recursive: true, force: true })

    const investigator = bridge(db, client, 40)
    const turn = await ask(investigator, { agent: 'engineer' })

    expect(turn.ok).toBe(false)
    expect(turn.agent).toBe('engineer')
    expect(turn.error as string).toContain('working copy could not be made')
    expect(turn.workingCopyId).toBeNull()
    // The expensive thing was not attempted.
    expect(invocations()).toBe(0)
    expect(investigator.workingCopy()).toBeNull()
  })

  test('switching back to the investigator records no copy for that turn', async () => {
    const db = seed(makeTarget())
    const { client } = answeringClient({ calls: 1 })
    const investigator = bridge(db, client, 40)

    await ask(investigator, { agent: 'engineer' })
    const back = await ask(investigator, { prompt: 'what does the target do?' })

    expect(back.agent).toBe('investigator')
    expect(back.workingCopyId).toBeNull()
    // The copy still exists for the conversation; the investigator turn simply is not
    // about it.
    expect(investigator.workingCopy()).not.toBeNull()
  })
})

describe('an unscanned checkout (spec §20.31)', () => {
  /** A database with the schema and nothing in it: no target, no run. */
  const emptyDb = (): Database => {
    const db = new Database(':memory:')
    databases.push(db)
    applySchema(db)
    return db
  }

  /** A client that reads one file through the target tool and reports its text. */
  const readingClient = () => {
    let read: string | null = null
    let invocations = 0
    const client = {
      run: async (options: {
        customToolDefinitions?: Array<{
          toolName: string
          execute: (params: unknown) => Promise<unknown>
        }>
      }) => {
        invocations += 1
        const tool = options.customToolDefinitions?.find(
          (definition) => definition.toolName === 'read_target_file',
        )
        const result = await tool?.execute({ path: 'copy.c' })
        read = JSON.stringify(result)
        return {
          output: { type: 'lastMessage', value: [{ role: 'assistant', content: 'read it' }] },
        }
      },
    } as unknown as CodebuffClient

    return { client, read: () => read, invocations: () => invocations }
  }

  test('the models read the directory the screen was opened in', async () => {
    // The point of §20.31's second decision: reading a checkout never needed a scan, so a
    // scan is not what makes the investigator available.
    const repo = makeTarget()
    const { client, read } = readingClient()
    const investigator = createReviewInvestigator({
      db: emptyDb(),
      client,
      fallbackTargetRoot: repo,
    })

    const turn = await ask(investigator, { runId: null })

    expect(turn.ok).toBe(true)
    expect(read()).toContain('int main(void) { return 0; }')
  })

  test('the turn says it is not recorded, and names why', async () => {
    // Not a failure and not silent: there is no run, so there is no transcript. §20.28
    // forbids creating a database here (an empty queue in a database that exists reads as
    // *clean*), so the honest report is that this conversation is not being kept.
    const repo = makeTarget()
    const { client } = readingClient()
    const investigator = createReviewInvestigator({
      db: emptyDb(),
      client,
      fallbackTargetRoot: repo,
    })

    const turn = await ask(investigator, { runId: null })

    expect(turn.recordedTurnId).toBeNull()
    expect(turn.error as string).toContain('not recorded')
    expect(turn.error as string).toContain('has not been scanned')
  })

  test('an engineer turn is refused, because a copy cannot be attributed to a run', async () => {
    // §20.30's engineer rests on the write being *recorded*: `working_copies` is keyed by
    // run and target and the turn stores the copy's id. With neither, a copy would be a
    // tree the transcript cannot point at — so this is a refusal, and the read-only
    // investigator is what remains available.
    const repo = makeTarget()
    const { client, invocations } = readingClient()
    const investigator = createReviewInvestigator({
      db: emptyDb(),
      client,
      fallbackTargetRoot: repo,
    })

    const turn = await ask(investigator, { runId: null, agent: 'engineer' })

    expect(turn.ok).toBe(false)
    expect(turn.error as string).toContain('has not been scanned')
    expect(turn.error as string).toContain('working copy')
    expect(turn.workingCopyId).toBeNull()
    expect(investigator.workingCopy()).toBeNull()
    // Nothing was copied and the model was never asked.
    expect(invocations()).toBe(0)
    expect(fs.readdirSync(repo)).toEqual(['copy.c'])
  })

  test('a run with a recorded target still wins over the fallback', async () => {
    // The fallback is for a checkout that has nothing on record, not a redirection: a
    // bridge that preferred it would move an investigation off the evidence it was
    // opened for.
    const scanned = makeTarget()
    const elsewhere = makeTarget()
    fs.writeFileSync(path.join(elsewhere, 'copy.c'), 'this is the wrong tree\n')

    const db = seed(scanned)
    const { client, read } = readingClient()
    const investigator = createReviewInvestigator({
      db,
      client,
      fallbackTargetRoot: elsewhere,
    })

    await ask(investigator)

    expect(read()).toContain('int main(void) { return 0; }')
    expect(read()).not.toContain('wrong tree')
  })
})

