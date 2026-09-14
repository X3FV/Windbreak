/**
 * The adjudication screen's investigator bridge (spec §20.29.4, §20.29.5 slice 5).
 *
 * This module is the seam that lets a chat pane exist without the screen growing a model
 * client. `cli/src/windbreak/index.tsx` states the surface's design as *"it reads a local
 * state database and writes a decision back to it, and that is all it does"* — and that
 * stays true: the screen renders whatever this interface returns and constructs nothing.
 * The bridge is built in the entry point, where a client already legitimately exists.
 *
 * Three things it owns, none of which the screen should:
 *
 * 1. **Resolving the target.** A turn needs a target root, which comes from the run — and
 *    a hunt has no candidate to ask, so the run has to be found from the queue rather than
 *    from the selected row. The bridge queries it.
 * 2. **Recording the turn.** §20.29.3 makes the answer a stored artifact, so every turn
 *    writes `investigator_turns` before it returns. A model call that is not recorded is a
 *    model call nobody can review, and the point of recording it is that it happened.
 * 3. **Being honest about not being available.** No credentials, no target, or a target
 *    that cannot be opened are all normal — a database can be reviewed offline — and each
 *    is reported as a reason rather than as a pane that silently does nothing. §18 in the
 *    screen: "no investigator" must not read as "the investigator found nothing".
 *
 * §20.30 adds a fourth: **materialising the working copy**. It is built here, lazily,
 * the first time an engineer turn is asked for, because the alternative is paying for a
 * copy of the whole checkout when a researcher opens the screen to read two arguments.
 * The copy is stored once per run so a turn can name the tree it wrote to, and it is
 * rebuilt per screen session rather than reused across them — a copy that has drifted
 * from the target is the substitution §18 exists to prevent, and the transcript, not
 * the copy, is what carries an edit forward.
 */

import { createHash } from 'crypto'
import os from 'os'
import path from 'path'

import { createInvestigator, DEFAULT_INVESTIGATOR_MODEL } from '../investigate/agent'
import { DEFAULT_INVESTIGATOR_AGENT } from '../investigate/agents'
import { createConversationBudget } from '../investigate/conversation'
import { createWorkingCopy } from '../investigate/copy'
import { recordInvestigatorTurn, recordWorkingCopy } from '../investigate/persist'
import { createInvestigatorWorkspace } from '../investigate/workspace'
import { modelVendor } from '../models'

import type { Database } from 'bun:sqlite'
import type { CodebuffClient } from '@codebuff/sdk'
import type { InvestigatorAgentName } from '../investigate/agents'
import type { ConversationBudget, ConversationBudgetState } from '../investigate/conversation'
import type { ModelRoleConfig } from '../models'
import type { InvestigatorMode } from '../investigate/persist'
import type { ProposedSite, ProposalRejection } from '../investigate/propose'
import type { CopyWriteRecord } from '../investigate/tools'
import type { InjectionSignal } from '../trust/injection'
import type { InvestigatorWorkspace } from '../investigate/workspace'

/** What one turn produced, shaped for the screen rather than for the pipeline. */
/**
 * The working copy a bridge has materialised, as the screen reads it.
 *
 * A narrowed view of `WorkingCopy`: the screen names the tree and says how big it
 * is. It does not get the strategy or the exclusion list, because those are facts
 * for a log rather than for a header line.
 */
export interface ReviewWorkingCopyInfo {
  id: string
  root: string
  baseCommit: string | null
  files: number
  bytes: number
  createdAt: string
}

export interface ReviewInvestigatorTurn {
  ok: boolean
  /** Which agent produced this turn (§20.30). */
  agent: InvestigatorAgentName
  /** The working copy the turn ran against, or null for a target-only turn. */
  workingCopyId: string | null
  /** Files the turn wrote in the copy, in order. Empty for an investigator turn. */
  writes: CopyWriteRecord[]
  /**
   * True when the researcher's `AbortSignal` stopped this turn (§20.29.5 slice 6).
   *
   * The pane draws "cancelled" from this rather than from `error`, because a turn the
   * researcher stopped is not a turn that broke.
   */
  cancelled: boolean
  /** The assistant's prose. Null when the turn failed or was cut off. */
  answer: string | null
  error: string | null
  /**
   * Sites the model recorded as candidates (§20.29.4).
   *
   * Returned but **not** persisted here. A proposal becomes a candidate only when a run
   * and its target are known, and the screen's job is to show the researcher what was
   * found; turning one into a candidate row is `proposalsToCandidates` plus
   * `persistCandidates`, driven from the CLI where the run is unambiguous. Leaving it out
   * of this method is deliberate: a screen that quietly wrote to `candidates` on a
   * keystroke would be spending model budget *and* changing the pipeline's input.
   */
  proposals: ProposedSite[]
  proposalRejections: ProposalRejection[]
  /** Instruction-like lines neutralized across the turn's tool results (§5.1). */
  injectionSignals: InjectionSignal[]
  /** Tool names in order, for the transcript's audit line. */
  toolsUsed: string[]
  /** The `investigator_turns` row, or null when the turn could not be recorded. */
  recordedTurnId: string | null
  /**
   * The conversation's budget after this turn (§20.29.6).
   *
   * Returned with every turn so the pane's display cannot go stale, and returned even
   * when the turn was refused for being over it — a refusal that did not say how spent
   * the budget was would be the §18 substitution in the pane's own chrome.
   */
  budget: ConversationBudgetState
}

export interface ReviewInvestigator {
  /** Null when the investigator is usable; the reason when it is not. */
  readonly unavailableReason: string | null
  /** The mode a question runs in, given what is selected. */
  modeFor(candidateId: string | null): InvestigatorMode
  /**
   * The conversation's ceiling and usage, for display.
   *
   * A read of the same counter `ask` charges, not a copy: there is exactly one budget per
   * screen session and this is how the pane sees it before any question has been asked.
   */
  budget(): ConversationBudgetState
  /**
   * The working copy this bridge has materialised, or null before the engineer's
   * first turn (§20.30).
   *
   * Reported rather than assumed because the copy does not exist until it is asked
   * for: a pane that said "editing a copy" before one was made would be claiming a
   * writable tree the engineer has not been given.
   */
  workingCopy(): ReviewWorkingCopyInfo | null
  ask(input: {
    runId: string | null
    candidateId: string | null
    mode: InvestigatorMode
    /** Which agent answers. Defaults to the read-only investigator. */
    agent?: InvestigatorAgentName
    prompt: string
    /** Fires the SDK's own cancellation path; the turn is still recorded as cancelled. */
    signal?: AbortSignal
  }): Promise<ReviewInvestigatorTurn>
}

export interface CreateReviewInvestigatorOptions {
  db: Database
  /**
   * The checkout a turn reads when the database has no run to resolve (§20.31).
   *
   * §20.29's workspace came from the run: a turn needed a target, and a target was
   * something a scan wrote. §20.31 makes the *directory* an answer too, so the
   * models can read a checkout nothing has scanned — which is the whole point of
   * the screen opening on one.
   *
   * Only the read-only investigator uses it. An engineer turn would need to record
   * the copy it wrote to (§20.30), and `working_copies` is keyed by run and target,
   * so there is nothing to attribute a write to here. That refusal is stated where
   * it happens rather than being papered over — see `copyWorkspaceFor`.
   */
  fallbackTargetRoot?: string
  /**
   * The client, or null when credentials are missing.
   *
   * Null is a first-class case rather than an error: the adjudication screen works
   * offline, and most reviews will not use the investigator at all.
   */
  client: CodebuffClient | null
  /** Why there is no client, when there is none. Shown instead of an empty pane. */
  clientUnavailableReason?: string
  model?: ModelRoleConfig
  maxAgentSteps?: number
  /** Model calls allowed in one conversation (§20.29.6). Defaults to the config default. */
  maxConversationCalls?: number
  log?: (line: string) => void
}

interface RunTarget {
  id: string
  location: string
  commitSha: string | null
}

const targetForRun = (db: Database, runId: string): RunTarget | null => {
  const row = db
    .query<{ id: string; location: string; commit_sha: string | null }, [string]>(
      `SELECT t.id, t.location, t.commit_sha FROM runs r JOIN targets t ON t.id = r.target_id
        WHERE r.id = ?`,
    )
    .get(runId)

  return row ? { id: row.id, location: row.location, commitSha: row.commit_sha } : null
}

/**
 * The investigator's scratch, and therefore the working copy's parent.
 *
 * `<target>/.windbreak/scratch/investigator/working-copy` — inside the target's own
 * `.windbreak`, which is the convention the rest of the tool follows, and inside the
 * scratch the sandbox already binds writable. §20.30's module header records why a
 * writable subtree of a read-only bind is fine here rather than novel: §20.6's build
 * step and §20.29's scratch already do it.
 */
export const investigatorScratchDir = (targetLocation: string): string =>
  `${targetLocation}/.windbreak/scratch/investigator`

/**
 * The scratch an unscanned checkout's investigation gets (§20.31).
 *
 * Under the system temp dir rather than beside the checkout, which is the whole
 * difference from the case above: a scanned target already has a `.windbreak` that
 * a scan wrote, while an unscanned one has none — and creating one would leave a
 * directory in a tree the screen is only supposed to be reading, visible to the
 * researcher as a change they did not make.
 *
 * Keyed by the root so two checkouts in one session cannot share a `HOME` and a
 * `TMPDIR`. The digest is of the resolved path, so the same repository gets the
 * same scratch across sessions and a different one never collides.
 */
export const unscannedScratchDir = (targetRoot: string): string =>
  path.join(
    os.tmpdir(),
    'windbreak-unscanned',
    createHash('sha256').update(targetRoot).digest('hex').slice(0, 12),
  )

/** Cache key for the one workspace that belongs to no run. `runId` is nullable. */
const UNSCANNED_KEY = '\u0000unscanned'

/** The run a candidate belongs to, for an `explain` turn started from a queue row. */
const runIdForCandidate = (db: Database, candidateId: string): string | null =>
  db
    .query<{ run_id: string }, [string]>('SELECT run_id FROM candidates WHERE id = ?')
    .get(candidateId)?.run_id ?? null

/**
 * The run to attach a turn to when the caller did not name one.
 *
 * A hunt has no candidate, so its run comes from the newest run in the database. The
 * alternative — asking the researcher for a run id — would make the pane unusable for the
 * case it exists for; the alternative of *not* recording it would lose the transcript.
 */
const latestRunId = (db: Database): string | null =>
  db
    .query<{ id: string }, []>(
      'SELECT id FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1',
    )
    .get()?.id ?? null

export const createReviewInvestigator = (
  options: CreateReviewInvestigatorOptions,
): ReviewInvestigator => {
  const { db, client } = options
  const log = options.log ?? (() => {})
  const model = options.model ?? DEFAULT_INVESTIGATOR_MODEL

  // One budget for the life of this bridge, and the bridge is built once per screen
  // session — so the ceiling is per *conversation* in the sense §20.29.6 means, not per
  // candidate or per mode. Reopening the screen starts a new one; the transcript in the
  // database is what carries across, not the count.
  const conversation: ConversationBudget = createConversationBudget({
    ...(options.maxConversationCalls !== undefined
      ? { maxCalls: options.maxConversationCalls }
      : {}),
  })

  // One workspace per target root, reused across turns. Building one opens no process —
  // the sandbox is only touched when a command runs — but it does resolve the root and
  // create scratch directories, and doing that per keystroke would litter.
  const workspaces = new Map<string, InvestigatorWorkspace | { error: string }>()

  /**
   * The copy-backed workspaces, one per run, built on demand (§20.30).
   *
   * A separate map from `workspaces` rather than mutating the target-only one: the
   * workspace's roots are fixed when it is built, and a workspace that grew a copy
   * halfway through would make "which roots does this turn have" a question about
   * timing instead of about the agent.
   */
  const copyWorkspaces = new Map<string, InvestigatorWorkspace | { error: string }>()
  const copyInfos = new Map<string, ReviewWorkingCopyInfo>()
  let lastCopyRunId: string | null = null

  const unavailableReason = (() => {
    if (client === null) {
      return (
        options.clientUnavailableReason ??
        'no model credentials are available, so the investigator cannot run. The queue ' +
          'still works: reviewing a disagreement needs no model.'
      )
    }
    return null
  })()

  /**
   * Where a run's turn reads, or the fallback directory when no run applies.
   *
   * The two are one function because the caller does not care which it got: what a
   * turn needs is a root to read. What it must not do is *guess* — a run with no
   * recorded target is a different fact from no run at all, and the first is an
   * error while the second is §20.31's fallback.
   */
  const rootForRun = (
    runId: string | null,
  ): { root: string; commitSha: string | null; scratchDir: string } | null => {
    if (runId !== null) {
      const target = targetForRun(db, runId)
      if (target !== null) {
        return {
          root: target.location,
          commitSha: target.commitSha,
          scratchDir: investigatorScratchDir(target.location),
        }
      }
    }

    if (options.fallbackTargetRoot === undefined) return null

    return {
      root: options.fallbackTargetRoot,
      commitSha: null,
      // Not beside the checkout, and that is the difference from the run case: an
      // unscanned repository has no `.windbreak`, and writing one into it would be a
      // state change the researcher did not ask for — visible in `git status` of a
      // tree the screen is only supposed to be *reading*. The system temp dir is
      // where a scratch that belongs to no run goes.
      scratchDir: unscannedScratchDir(options.fallbackTargetRoot),
    }
  }

  const workspaceFor = async (
    runId: string | null,
  ): Promise<InvestigatorWorkspace | { error: string }> => {
    const key = runId ?? UNSCANNED_KEY

    const cached = workspaces.get(key)
    if (cached) return cached

    const resolved = rootForRun(runId)
    if (resolved === null) {
      const miss = {
        error:
          runId === null
            ? 'no run is on record and no checkout was resolved, so there is no ' +
              'target to investigate'
            : `run ${runId} has no recorded target location`,
      }
      workspaces.set(key, miss)
      return miss
    }

    try {
      const workspace = await createInvestigatorWorkspace({
        targetDir: resolved.root,
        scratchDir: resolved.scratchDir,
      })
      workspaces.set(key, workspace)
      return workspace
    } catch (error) {
      const failure = {
        error: `the target at ${resolved.root} cannot be opened for investigation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
      workspaces.set(key, failure)
      return failure
    }
  }

  /**
   * The copy-backed workspace for a run, materialising the copy on first use.
   *
   * Every failure is a reason rather than a fallback: if the copy cannot be made, the
   * engineer turn fails and says so. Quietly answering from the target instead would
   * be the §18 substitution in the worst place — a model that believes it edited a
   * tree it never touched, and a transcript that records an answer as though the edit
   * happened.
   */
  const copyWorkspaceFor = async (
    runId: string | null,
  ): Promise<InvestigatorWorkspace | { error: string }> => {
    if (runId === null) {
      // §20.31's refusal, and it is a refusal rather than a fallback on purpose.
      // §20.30's engineer exists because a write is recorded *and* attributable:
      // `working_copies` is keyed by run and target, and the turn stores the copy's
      // id. An unscanned checkout has neither, so a copy made here could not be
      // named in the transcript — and a model that believes it edited a tree the
      // record cannot point at is exactly the substitution §18 exists to prevent.
      // Reading the checkout is still available; it is the write that needs a run.
      return {
        error:
          'this checkout has not been scanned, so there is no run to attach a working ' +
          'copy to, and an engineer turn is only meaningful when the copy it wrote to ' +
          'is recorded. The investigator can still read the checkout; scan it to make ' +
          'a copy editable.',
      }
    }

    const cached = copyWorkspaces.get(runId)
    if (cached) return cached

    const target = targetForRun(db, runId)
    if (target === null) {
      const miss = { error: `run ${runId} has no recorded target location` }
      copyWorkspaces.set(runId, miss)
      return miss
    }

    try {
      const copy = createWorkingCopy({
        targetDir: target.location,
        scratchDir: investigatorScratchDir(target.location),
        commitSha: target.commitSha,
      })

      // Recorded before the workspace is built, and deliberately: the copy exists on
      // disk at this point, and a crash between here and the first turn must not leave
      // a tree on disk that no row accounts for.
      recordWorkingCopy({ db, runId, targetId: target.id, copy })

      const workspace = await createInvestigatorWorkspace({
        targetDir: target.location,
        scratchDir: investigatorScratchDir(target.location),
        copy,
      })

      copyWorkspaces.set(runId, workspace)
      copyInfos.set(runId, {
        id: copy.id,
        root: copy.root,
        baseCommit: copy.baseCommit,
        files: copy.files,
        bytes: copy.bytes,
        createdAt: copy.createdAt,
      })
      lastCopyRunId = runId
      return workspace
    } catch (error) {
      const failure = {
        error: `the working copy could not be made: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
      copyWorkspaces.set(runId, failure)
      return failure
    }
  }

  return {
    unavailableReason,

    modeFor: (candidateId) => (candidateId === null ? 'hunt' : 'explain'),

    budget: () => conversation.state(),

    workingCopy: () => (lastCopyRunId ? (copyInfos.get(lastCopyRunId) ?? null) : null),

    async ask({ runId, candidateId, mode, agent = DEFAULT_INVESTIGATOR_AGENT, prompt, signal }) {
      const empty: ReviewInvestigatorTurn = {
        ok: false,
        agent,
        workingCopyId: null,
        writes: [],
        cancelled: false,
        answer: null,
        error: null,
        proposals: [],
        proposalRejections: [],
        injectionSignals: [],
        toolsUsed: [],
        recordedTurnId: null,
        budget: conversation.state(),
      }

      if (client === null) {
        return { ...empty, error: unavailableReason }
      }

      // Checked before the workspace is resolved, because the point of a ceiling is to
      // refuse the cheap thing before doing the expensive one. A refusal is a *result*, not
      // an error thrown into a render loop — the same rule a refused read follows in
      // `tools.ts` — and it says how spent the budget is rather than only that it is.
      if (conversation.exhausted()) {
        const state = conversation.state()
        return {
          ...empty,
          error:
            `this conversation has spent its ceiling (${state.calls}/${state.limit} model ` +
            'calls), so the question was not asked. The ceiling is per conversation: leave ' +
            'the screen and reopen it to start a fresh one, or raise ' +
            'investigator.maxConversationCalls in the config.',
        }
      }

      // A candidate names its own run, and naming it from the row is more specific than
      // asking for the latest.
      const resolvedRunId =
        runId ?? (candidateId ? runIdForCandidate(db, candidateId) : null) ?? latestRunId(db)

      // No run at all, as opposed to a run whose target is missing: the first is
      // §20.31's unscanned checkout and the second is a broken database. Only the
      // first is expected to be unrecorded.
      const unscanned = resolvedRunId === null

      const workspace =
        agent === 'engineer'
          ? await copyWorkspaceFor(resolvedRunId)
          : await workspaceFor(resolvedRunId)
      if ('error' in workspace) {
        return { ...empty, error: workspace.error }
      }

      // Computed once, and null for an investigator turn by construction: a turn that
      // read the evidence ran against no copy, so naming one would claim a tree it never
      // touched. A researcher who switches back therefore gets a turn with no copy
      // attached, which is the honest reading.
      const workingCopyIdForTurn =
        agent === 'engineer' && resolvedRunId !== null
          ? (copyInfos.get(resolvedRunId)?.id ?? null)
          : null

      const investigator = createInvestigator({
        workspace,
        client,
        agent,
        model,
        ...(options.maxAgentSteps ? { maxAgentSteps: options.maxAgentSteps } : {}),
        log,
      })

      const startedAt = Date.now()
      const turn = await investigator.ask({ ...(signal ? { signal } : {}), prompt })
      log(
        `[investigate] ${turn.toolCalls.length} tool call(s), ` +
          `${turn.proposals.length} proposal(s) in ${Date.now() - startedAt}ms`,
      )

      // Charged whether or not the turn succeeded: a cancelled or failed turn still made
      // the calls it made, and a ceiling that only charged successful turns would be a
      // ceiling a researcher could spend a day under by asking badly. The count comes from
      // the provider's own reports, with a floor of one call per turn inside the budget.
      const budget = conversation.charge({
        calls: turn.modelCalls,
        tokens: turn.totalTokens,
      })

      const toolCalls = turn.toolCalls
      const injectionSignals = toolCalls.flatMap((call) => call.signals)

      // Recorded before returning, so a turn the screen shows is a turn the database has.
      // A recording failure is reported and does not discard the answer: losing the
      // transcript of an answer the researcher can see would be worse than a missing row.
      let recordedTurnId: string | null = null
      let recordError: string | null = null
      if (resolvedRunId !== null) {
        try {
          recordedTurnId = recordInvestigatorTurn({
            db,
            runId: resolvedRunId,
            candidateId,
            mode,
            agent,
            workingCopyId: workingCopyIdForTurn,
            prompt,
            answer: turn.answer,
            error: turn.error,
            model,
            provider: modelVendor(model.model),
            toolCalls,
            writes: turn.writes,
          }).id
        } catch (error) {
          recordError = `the turn could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
      } else {
        // Named rather than generic, because the reason is not a failure: nothing has
        // been scanned, so there is no run and no database file to write a turn to.
        // §20.28 forbids creating one here (an empty queue in a database that exists
        // reads as *clean*), so the honest report is that this conversation is not
        // being kept.
        recordError =
          'this turn is not recorded: ' +
          (unscanned
            ? 'the checkout has not been scanned, so there is no run and no state ' +
              'database to write a transcript to. Scan it to keep one.'
            : 'no run to attach it to')
      }

      return {
        ok: turn.ok,
        agent,
        workingCopyId: workingCopyIdForTurn,
        writes: turn.writes,
        cancelled: turn.cancelled,
        answer: turn.answer,
        error: turn.error ?? recordError,
        proposals: turn.proposals,
        proposalRejections: turn.proposalRejections,
        injectionSignals,
        toolsUsed: toolCalls.map((call) => call.tool),
        recordedTurnId,
        budget,
      }
    },
  }
}
