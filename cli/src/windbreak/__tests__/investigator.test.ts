import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createMeteredSessions } from '@codebuff/windbreak/client'
import { openStateDatabase } from '@codebuff/windbreak/state'

import { createQueueInvestigator, investigatorLimitOptions } from '../investigator'

import type { CodebuffClient } from '@codebuff/sdk'
import type { WindbreakModelHost } from '@codebuff/windbreak/client'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** A model that answers at once and reports token usage, like §20.29.6's budget reads it. */
const answeringClient = (answer = 'The length check runs after the copy.') => {
  const client = {
    run: async (options: { onUsage?: (usage: { isRoot: boolean; totalTokens: number }) => void }) => {
      options.onUsage?.({ isRoot: true, totalTokens: 120 })
      return {
        output: {
          type: 'lastMessage',
          value: [{ role: 'assistant', content: answer }],
        },
      }
    },
  } as unknown as CodebuffClient

  return { client }
}

interface Seeded {
  repo: string
  dbPath: string
}

/** A real queue database with one disagreement in it, seeded with SQL. */
const seedQueue = (): Seeded => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bridge-'))
  created.push(repo)
  const dbPath = path.join(repo, '.windbreak', 'state.db')
  const db = openStateDatabase(dbPath)

  db.prepare(
    `INSERT INTO targets (id, location, commit_sha, build_model, scope_class)
     VALUES ('t1', ?, 'abc123', 'compile_commands', 'userspace-c')`,
  ).run(repo)
  db.prepare(
    `INSERT INTO runs (id, target_id, config_json, commit_sha, status)
     VALUES ('run-1', 't1', '{}', 'abc123', 'complete')`,
  ).run()
  db.prepare(
    `INSERT INTO candidates (id, run_id, source, file_path, start_line, cwe, normalized_json, state)
     VALUES ('cand-1', 'run-1', 'semgrep', 'src/handler.c', 6, 'CWE-120', '{}', 'escalated')`,
  ).run()
  db.close()

  return { repo, dbPath }
}

const readTurns = (dbPath: string): Array<Record<string, unknown>> => {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query('SELECT * FROM investigator_turns ORDER BY created_at').all() as Array<
      Record<string, unknown>
    >
  } finally {
    db.close()
  }
}

describe('investigatorLimitOptions', () => {
  test('speaks the engine’s names, which are not the config’s', () => {
    // The regression this pins: for one release the bridge spread `{ maxSteps }` into the
    // engine's options, and because the value arrived through a spread the excess-property
    // check never fired. The engine accepted the object, ignored the unknown key, and ran on
    // its own default of sixteen steps — so `windbreak.config`'s `maxSteps` bounded nothing,
    // silently, while the pane reported no problem at all.
    const options = investigatorLimitOptions({ maxConversationCalls: 4, maxSteps: 2 })

    expect(Object.keys(options).sort()).toEqual(['maxAgentSteps', 'maxConversationCalls'])
    expect(options).toEqual({ maxConversationCalls: 4, maxAgentSteps: 2 })
  })

  test('passes no key the engine would ignore', () => {
    const options = investigatorLimitOptions({ maxConversationCalls: 1, maxSteps: 16 })

    expect(options).not.toHaveProperty('maxSteps')
  })
})

describe('createQueueInvestigator', () => {
  let seeded: Seeded

  beforeEach(() => {
    seeded = seedQueue()
  })

  test('a turn reaches the engine, is recorded, and charges the configured ceiling', async () => {
    const { client } = answeringClient()
    const bridge = await createQueueInvestigator({
      dbPath: seeded.dbPath,
      repoRoot: seeded.repo,
      maxConversationCalls: 3,
      maxSteps: 2,
      client,
      // Injected alongside the client, and the pair is the contract: a client without a
      // session is a *metered* turn, which the engine refuses rather than bills (§20.41).
      sessions: createMeteredSessions(),
    })

    try {
      expect(bridge.unavailableReason).toBeNull()
      expect(bridge.investigator.budget().limit).toBe(3)

      const turn = await bridge.investigator.ask({
        runId: 'run-1',
        candidateId: 'cand-1',
        mode: 'explain',
        prompt: 'is the length check before the copy?',
      })

      expect(turn.ok).toBe(true)
      expect(turn.answer).toContain('length check')
      expect(turn.recordedTurnId).not.toBeNull()
      expect(turn.budget).toMatchObject({ calls: 1, turns: 1, remaining: 2 })

      // The record is the assertion that matters: §20.29.3 makes the answer a stored artifact,
      // and this is the pane's own bridge writing it — not the engine test's own setup.
      const rows = readTurns(seeded.dbPath)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.prompt).toBe('is the length check before the copy?')
      expect(rows[0]!.answer).toContain('length check')
    } finally {
      bridge.close()
    }
  })

  test('runs a turn on the transport it is handed, rather than one it resolves itself', async () => {
    // §20.41.5's case for this pane: free mode is scoped to the freebuff CLI *as a caller*, so
    // a turn taken here has to be made by this process. The default resolver is the CLI's own
    // client and live session; the assertion is that the caller is what the options are built
    // from, not a WindBreak client constructed from the same credentials.
    const { client } = answeringClient()
    const host: WindbreakModelHost = { client, sessions: createMeteredSessions() }

    const bridge = await createQueueInvestigator({
      dbPath: seeded.dbPath,
      repoRoot: seeded.repo,
      maxConversationCalls: 3,
      maxSteps: 2,
      hostResolver: async () => host,
    })

    try {
      expect(bridge.unavailableReason).toBeNull()

      const turn = await bridge.investigator.ask({
        runId: 'run-1',
        candidateId: 'cand-1',
        mode: 'explain',
        prompt: 'is the length check before the copy?',
      })

      // Reaching the injected client at all is the claim: a bridge that built its own would
      // have answered nothing here without credentials.
      expect(turn.ok).toBe(true)
      expect(turn.answer).toContain('length check')
      expect(readTurns(seeded.dbPath)).toHaveLength(1)
    } finally {
      bridge.close()
    }
  })

  test('no transport at all is a sentence, and asking still answers rather than throwing', async () => {
    const bridge = await createQueueInvestigator({
      dbPath: seeded.dbPath,
      repoRoot: seeded.repo,
      maxConversationCalls: 3,
      maxSteps: 2,
      hostResolver: async () => null,
    })

    try {
      expect(bridge.unavailableReason).toContain('no model credentials')

      const turn = await bridge.investigator.ask({
        runId: 'run-1',
        candidateId: 'cand-1',
        mode: 'explain',
        prompt: 'anything here?',
      })

      expect(turn.ok).toBe(false)
      expect(readTurns(seeded.dbPath)).toHaveLength(0)
    } finally {
      bridge.close()
    }
  })

  test('a missing client is a sentence, and asking still answers rather than throwing', async () => {
    // §18 in the pane's own chrome: the queue is readable and decidable offline, so the two
    // ways this can fail are states of the conversation, not exceptions inside a render.
    const bridge = await createQueueInvestigator({
      dbPath: seeded.dbPath,
      repoRoot: seeded.repo,
      maxConversationCalls: 3,
      maxSteps: 2,
      client: null,
      clientUnavailableReason: 'no model credentials are available',
    })

    try {
      expect(bridge.unavailableReason).toBe('no model credentials are available')

      const turn = await bridge.investigator.ask({
        runId: 'run-1',
        candidateId: 'cand-1',
        mode: 'explain',
        prompt: 'anything here?',
      })

      expect(turn.ok).toBe(false)
      expect(turn.error).toContain('no model credentials')
      expect(readTurns(seeded.dbPath)).toHaveLength(0)
    } finally {
      bridge.close()
    }
  })

  test('the bridge holds its own connection, so the queue’s reader keeps working', async () => {
    // The second connection is the reason the pane can write `investigator_turns` without
    // widening the session's read-only contract. Observable as behaviour: a connection opened
    // before the bridge still reads the queue while the bridge writes, and closing the bridge
    // leaves it usable.
    const reader = openStateDatabase(seeded.dbPath)
    const { client } = answeringClient()
    const bridge = await createQueueInvestigator({
      dbPath: seeded.dbPath,
      repoRoot: seeded.repo,
      maxConversationCalls: 2,
      maxSteps: 2,
      client,
      sessions: createMeteredSessions(),
    })

    try {
      await bridge.investigator.ask({
        runId: 'run-1',
        candidateId: 'cand-1',
        mode: 'explain',
        prompt: 'anything here?',
      })

      const pending = reader
        .query<{ candidate_id: string }, []>(
          `SELECT c.id AS candidate_id FROM candidates c
            JOIN adjudication_queue q ON q.candidate_id = c.id`,
        )
        .all()
      expect(readTurns(seeded.dbPath)).toHaveLength(1)
      expect(pending).toEqual([])
    } finally {
      bridge.close()
      // Still usable after the bridge closed its own handle: closing one connection to a file
      // is not closing the file.
      expect(reader.query('SELECT COUNT(*) AS count FROM candidates').get()).toEqual({
        count: 1,
      })
      reader.close()
    }
  })
})
