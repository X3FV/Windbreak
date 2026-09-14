/**
 * Investigator persistence (spec §20.29, §20.29.3, §20.29.5 slice 3).
 *
 * This module exists to record an investigator turn **without** giving it a vote. Two
 * things follow from that and are the whole reason the code is shaped this way:
 *
 * 1. **It writes `investigator_turns`, never `verdicts`.** There is no call to
 *    `insertVerdict` here and no `cache_key`, because §20.29.3 makes the recorded
 *    answer a thing the human weighs rather than a thing the pipeline counts. The
 *    `role` field on every record is the literal `'investigator'`, so a consumer that
 *    wants to discriminate has something to switch on — and `ModelRole`, the union the
 *    verdict path takes, does not include it (`models.ts`).
 * 2. **A failed turn is recorded.** `answer` is nullable and `error` is not decorative:
 *    a model that could not run is a fact the researcher needs, and dropping the row
 *    would make "the investigator said nothing" indistinguishable from "nobody asked"
 *    — §18, in the transcript.
 *
 * The transcript is also where §20.29.3's third consequence lands: `toolDerived` and
 * `injectionSignals` are stored so a reader can tell a tool-derived answer apart from a
 * verdict produced under §5.1's fence, and can see what was neutralized on the way in.
 * Nothing here decides anything. There is no `state` update on `candidates`, no
 * `adjudication_queue` write, and no function that `runVerification` calls.
 *
 * §20.30 added three columns and a table, and the shape of the addition is the point:
 * a turn now records **which agent** produced it, **which working copy** it ran
 * against, and **what files it wrote**. The first is what makes the researcher's switch
 * visible in the transcript; the second is what makes a write attributable to a *copy*
 * rather than to the evidence; the third is what makes "what did the model do"
 * answerable at all. None of them is a vote, and none is read by `runVerification` —
 * the table's absence from that path is unchanged, which is the property §20.29.3
 * exists to hold.
 */

import { createHash } from 'crypto'

import { INVESTIGATOR_ROLE } from '../models'

import { DEFAULT_INVESTIGATOR_AGENT, INVESTIGATOR_AGENTS } from './agents'

import type { Database } from 'bun:sqlite'
import type { ModelRoleConfig } from '../models'
import type { InvestigatorAgentName } from './agents'
import type { WorkingCopy } from './copy'
import type { CopyWriteRecord, ToolResultRecord } from './tools'
import type { InjectionSignal } from '../trust/injection'

/** §20.29.4's two modes, which are the two jobs on one surface. */
export const INVESTIGATOR_MODES = ['explain', 'hunt'] as const
export type InvestigatorMode = (typeof INVESTIGATOR_MODES)[number]

/**
 * A mode read back from a row, which may not be one this version knows.
 *
 * `'unknown'` rather than a cast, because a row can only carry a third mode if some
 * other writer put it there — a future version, or a hand-edited database. Coercing it
 * into `'hunt'` would report an unreadable row as a search for candidates, which is §18
 * again; showing it as unknown keeps the union exhaustive and lets a caller see that it
 * does not know what it is looking at.
 */
export type RecordedInvestigatorMode = InvestigatorMode | 'unknown'

/**
 * An agent read back from a row, which may not be one this version knows.
 *
 * Same rule as `RecordedInvestigatorMode`, for the same reason: coercing an
 * unrecognised value into `'investigator'` would attribute a write to the read-only
 * agent, which is the one attribution this column exists to get right.
 */
export type RecordedAgentName = InvestigatorAgentName | 'unknown'

/**
 * One recorded turn, as it is read back.
 *
 * `role` is a literal rather than a `ModelRole` field, and that is the point: a
 * consumer holding an `InvestigatorTurnRecord` cannot pass its role to
 * `insertVerdict` or `invokeCached`, because `'investigator'` is not a member of the
 * union those accept.
 */
export interface InvestigatorTurnRecord {
  id: string
  role: typeof INVESTIGATOR_ROLE
  runId: string
  /** NULL for a hunt. */
  candidateId: string | null
  mode: RecordedInvestigatorMode
  /** Which agent said this (§20.30). */
  agent: RecordedAgentName
  /** The working copy the turn ran against, or null for a target-only turn. */
  workingCopyId: string | null
  prompt: string
  answer: string | null
  error: string | null
  /** True when the answer rests on tool results; every successful turn. */
  toolDerived: boolean
  toolCalls: ToolResultRecord[]
  /** What the turn wrote in the copy, in order. Empty for an investigator turn. */
  writes: CopyWriteRecord[]
  /** Instruction-like lines neutralized across the turn's tool results. */
  injectionSignals: InjectionSignal[]
  modelId: string
  provider: string
  createdAt: string | null
}

export interface RecordInvestigatorTurnInput {
  db: Database
  runId: string
  /** Set for `explain`, null for `hunt`. */
  candidateId?: string | null
  mode: InvestigatorMode
  /** Defaults to the investigator, so a caller that predates §20.30 is unchanged. */
  agent?: InvestigatorAgentName
  /** The working copy this turn ran against, when it had one. */
  workingCopyId?: string | null
  prompt: string
  /** The assistant's prose, or null when the turn failed. */
  answer: string | null
  error?: string | null
  model: ModelRoleConfig
  provider: string
  /** What the tool set recorded, in order. */
  toolCalls?: readonly ToolResultRecord[]
  /** What the turn wrote in the working copy, in order. */
  writes?: readonly CopyWriteRecord[]
  now?: () => number
}

/**
 * A turn's identity, derived from the run, the mode, and the question.
 *
 * Deterministic rather than random so that asking the same thing twice on the same run
 * *replaces* the record instead of accumulating near-identical rows. That is a smaller
 * commitment than it looks: it makes the transcript's identity a function of what was
 * asked, not of a clock, which is the closest this table gets to the reproducibility
 * `verdict_cache` provides and is not a substitute for it (§20.29.6 — a conversation
 * that read files is not replayable from a key).
 * §20.30 puts the **agent** in the key as well. It has to: the same question asked of
 * the investigator and of the engineer are two different turns with two different
 * answers, and a key that ignored the agent would make the second silently replace the
 * first — losing exactly the comparison the switch exists to allow.
 */
export const investigatorTurnId = (input: {
  runId: string
  mode: InvestigatorMode
  candidateId: string | null
  prompt: string
  agent?: InvestigatorAgentName
}): string =>
  `inv_${createHash('sha256')
    .update(
      `${input.runId}:${input.agent ?? DEFAULT_INVESTIGATOR_AGENT}:${input.mode}:${
        input.candidateId ?? '-'
      }:${input.prompt}`,
    )
    .digest('hex')
    .slice(0, 24)}`

/**
 * Whether an answer rests on tool results.
 *
 * Derived from the recorded calls rather than passed in, because the flag is a claim
 * about the row and a caller that could set it could also get it wrong. A turn with no
 * calls is not tool-derived — including a failed turn, where there is nothing to have
 * derived anything from.
 */
const isToolDerived = (answer: string | null, toolCalls: readonly ToolResultRecord[]): boolean =>
  answer !== null && toolCalls.length > 0

/** Flattened signals across a turn's tool calls, for the row's own summary. */
const signalsFrom = (calls: readonly ToolResultRecord[]): InjectionSignal[] =>
  calls.flatMap((call) => call.signals)

export const recordInvestigatorTurn = (
  input: RecordInvestigatorTurnInput,
): InvestigatorTurnRecord => {
  const candidateId = input.candidateId ?? null
  const agent = input.agent ?? DEFAULT_INVESTIGATOR_AGENT
  const workingCopyId = input.workingCopyId ?? null
  const toolCalls = [...(input.toolCalls ?? [])]
  const writes = [...(input.writes ?? [])]
  const injectionSignals = signalsFrom(toolCalls)

  const id = investigatorTurnId({
    runId: input.runId,
    mode: input.mode,
    candidateId,
    prompt: input.prompt,
    agent,
  })

  const createdAt = new Date((input.now ?? Date.now)()).toISOString()

  input.db
    .prepare(
      `INSERT OR REPLACE INTO investigator_turns
         (id, run_id, candidate_id, mode, agent, working_copy_id, prompt, answer, error,
          tool_derived, tool_calls_json, writes_json, injection_signals_json, model_id,
          provider, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId,
      candidateId,
      input.mode,
      agent,
      workingCopyId,
      input.prompt,
      input.answer,
      input.error ?? null,
      isToolDerived(input.answer, toolCalls) ? 1 : 0,
      JSON.stringify(toolCalls),
      writes.length > 0 ? JSON.stringify(writes) : null,
      injectionSignals.length > 0 ? JSON.stringify(injectionSignals) : null,
      input.model.model,
      input.provider,
      createdAt,
    )

  return {
    id,
    role: INVESTIGATOR_ROLE,
    runId: input.runId,
    candidateId,
    mode: input.mode,
    agent,
    workingCopyId,
    prompt: input.prompt,
    answer: input.answer,
    error: input.error ?? null,
    toolDerived: isToolDerived(input.answer, toolCalls),
    toolCalls,
    writes,
    injectionSignals,
    modelId: input.model.model,
    provider: input.provider,
    createdAt,
  }
}

interface TurnRow {
  id: string
  run_id: string
  candidate_id: string | null
  mode: string
  agent: string
  working_copy_id: string | null
  prompt: string
  answer: string | null
  error: string | null
  tool_derived: number
  tool_calls_json: string | null
  writes_json: string | null
  injection_signals_json: string | null
  model_id: string
  provider: string
  created_at: string | null
}

/**
 * Parse a JSON column that is expected to hold an array.
 *
 * Returns `[]` rather than throwing, matching `parseNormalized`: a malformed row must
 * read as "nothing recorded here" and never as a confident clean value.
 */
const parseArray = <T>(json: string | null): T[] => {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/** SQLite returns the column as a string; this is where it becomes the union. */
const toRecordedMode = (value: string): RecordedInvestigatorMode =>
  (INVESTIGATOR_MODES as readonly string[]).includes(value)
    ? (value as InvestigatorMode)
    : 'unknown'

const toRecordedAgent = (value: string): RecordedAgentName =>
  (INVESTIGATOR_AGENTS as readonly string[]).includes(value)
    ? (value as InvestigatorAgentName)
    : 'unknown'

const toTurn = (row: TurnRow): InvestigatorTurnRecord => ({
  id: row.id,
  role: INVESTIGATOR_ROLE,
  runId: row.run_id,
  candidateId: row.candidate_id,
  mode: toRecordedMode(row.mode),
  agent: toRecordedAgent(row.agent),
  workingCopyId: row.working_copy_id,
  prompt: row.prompt,
  answer: row.answer,
  error: row.error,
  toolDerived: row.tool_derived === 1,
  toolCalls: parseArray<ToolResultRecord>(row.tool_calls_json),
  writes: parseArray<CopyWriteRecord>(row.writes_json),
  injectionSignals: parseArray<InjectionSignal>(row.injection_signals_json),
  modelId: row.model_id,
  provider: row.provider,
  createdAt: row.created_at,
})

/** Every turn on a run, oldest first, so a transcript reads in order. */
export const readInvestigatorTurns = (
  db: Database,
  runId: string,
): InvestigatorTurnRecord[] =>
  db
    .query<TurnRow, [string]>(
      `SELECT * FROM investigator_turns WHERE run_id = ? ORDER BY rowid`,
    )
    .all(runId)
    .map(toTurn)

/** The turns that were about one candidate, in order. */
export const readInvestigatorTurnsForCandidate = (
  db: Database,
  candidateId: string,
): InvestigatorTurnRecord[] =>
  db
    .query<TurnRow, [string]>(
      `SELECT * FROM investigator_turns WHERE candidate_id = ? ORDER BY rowid`,
    )
    .all(candidateId)
    .map(toTurn)

/**
 * Counts for §20.29's "did anyone investigate this?" question, run-scoped.
 *
 * Reported beside the candidate counts rather than folded into them — an investigator
 * turn is not a candidate, a verdict, or a decision, and a summary that added it to any
 * of those would make the pipeline look busier than it was.
 */
export interface InvestigatorSummary {
  turns: number
  failed: number
  /** Turns whose tool results carried instruction-like content. */
  withSignals: number
  /** Turns that wrote in a working copy (§20.30). */
  wrote: number
  /** Grouped by the stored mode, so an unknown one is reported as itself. */
  byMode: Array<{ mode: string; count: number }>
  /** Grouped by agent, so the researcher's switch is visible in a summary. */
  byAgent: Array<{ agent: string; count: number }>
}

export const readInvestigatorSummary = (
  db: Database,
  runId: string,
): InvestigatorSummary => {
  const byMode = db
    .query<{ mode: string; count: number }, [string]>(
      `SELECT mode, COUNT(*) AS count FROM investigator_turns
        WHERE run_id = ? GROUP BY mode ORDER BY mode`,
    )
    .all(runId)

  const turns = byMode.reduce((total, row) => total + row.count, 0)

  const byAgent = db
    .query<{ agent: string; count: number }, [string]>(
      `SELECT agent, COUNT(*) AS count FROM investigator_turns
        WHERE run_id = ? GROUP BY agent ORDER BY agent`,
    )
    .all(runId)

  return {
    turns,
    failed:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM investigator_turns
            WHERE run_id = ? AND answer IS NULL`,
        )
        .get(runId)?.n ?? 0,
    withSignals:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM investigator_turns
            WHERE run_id = ? AND injection_signals_json IS NOT NULL`,
        )
        .get(runId)?.n ?? 0,
    // `writes_json` is set to NULL rather than '[]' when there were no writes, so a
    // non-NULL value is the whole test and does not have to be parsed to be counted.
    wrote:
      db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM investigator_turns
            WHERE run_id = ? AND writes_json IS NOT NULL`,
        )
        .get(runId)?.n ?? 0,
    byMode,
    byAgent,
  }
}

// ---- working copies (§20.30) -----------------------------------------------

/** The row shape of a stored copy, as it is written and read back. */
export interface RecordedWorkingCopy {
  id: string
  runId: string
  targetId: string
  path: string
  baseCommitSha: string | null
  strategy: string
  files: number
  bytes: number
  createdAt: string
}

export interface RecordWorkingCopyInput {
  db: Database
  runId: string
  targetId: string
  copy: WorkingCopy
}

/**
 * Store a copy's identity, so a turn can point at it.
 *
 * `INSERT OR REPLACE` on the copy's own deterministic id, matching the turns: a
 * screen session that recreated the same copy at the same second is one copy, and a
 * second row for it would split one tree's writes across two identities.
 */
export const recordWorkingCopy = (input: RecordWorkingCopyInput): RecordedWorkingCopy => {
  input.db
    .prepare(
      `INSERT OR REPLACE INTO working_copies
         (id, run_id, target_id, path, base_commit_sha, strategy, files, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.copy.id,
      input.runId,
      input.targetId,
      input.copy.root,
      input.copy.baseCommit,
      input.copy.strategy,
      input.copy.files,
      input.copy.bytes,
      input.copy.createdAt,
    )

  return {
    id: input.copy.id,
    runId: input.runId,
    targetId: input.targetId,
    path: input.copy.root,
    baseCommitSha: input.copy.baseCommit,
    strategy: input.copy.strategy,
    files: input.copy.files,
    bytes: input.copy.bytes,
    createdAt: input.copy.createdAt,
  }
}

interface WorkingCopyRow {
  id: string
  run_id: string
  target_id: string
  path: string
  base_commit_sha: string | null
  strategy: string
  files: number
  bytes: number
  created_at: string | null
}

/** Every copy stored for a run, oldest first, so a transcript can name one. */
export const readWorkingCopies = (
  db: Database,
  runId: string,
): RecordedWorkingCopy[] =>
  db
    .query<WorkingCopyRow, [string]>(
      `SELECT * FROM working_copies WHERE run_id = ? ORDER BY rowid`,
    )
    .all(runId)
    .map((row) => ({
      id: row.id,
      runId: row.run_id,
      targetId: row.target_id,
      path: row.path,
      baseCommitSha: row.base_commit_sha,
      strategy: row.strategy,
      files: row.files,
      bytes: row.bytes,
      createdAt: row.created_at ?? '',
    }))
