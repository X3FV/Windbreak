/**
 * The investigator agent (spec §20.29.2, §20.29.5 slice 2).
 *
 * This is the one model in WindBreak that is *not* fenced off from the target, and
 * the three things that keep that safe are all visible in this file:
 *
 * 1. **Its tools are ours.** `customToolDefinitions` carries the four tools from
 *    `./tools`, and `toolNames` lists exactly those — so there is no built-in read,
 *    write or network tool on this agent even by inheritance.
 * 2. **Its output is prose, not a verdict.** `outputMode` is `'last_message'`, so
 *    nothing it says is a `set_output` value and nothing it says can be read as one
 *    by `runVerification` (§20.29.3). Recording it is slice 3's job; *not* feeding
 *    §5.2's gate is this file's.
 * 3. **It carries §5.1's framing.** `TRUST_FRAMING` — rules 1–3 — is on the system
 *    prompt, and rule 4 is deliberately *not*, because rule 4 tells the model to
 *    answer in a schema this agent does not have.
 *
 * The `client.run` call here is a second model entry point beside
 * `pipeline/invoke.ts`, which is a real cost and is recorded rather than hidden: the
 * verdict roles are one-shot structured calls with no tools, and an investigating
 * agent is a multi-step tool-using loop, so a single invoker interface would have to
 * be the union of both. The union is `CodebuffClient.run`, and that is what both
 * files call.
 *
 * ## Two agents, one runtime (§20.30)
 *
 * §20.30's researcher switch is *which root you are talking to*, and it is built as two
 * definitions rather than one definition with a mode flag:
 *
 * - **`windbreak-investigator`** answers about the **target**. Its tool list is
 *   §20.29's five and nothing has been added to it — it still cannot write anywhere, so
 *   every answer it gives is about the artifact a finding cites.
 * - **`windbreak-engineer`** works on the **working copy**. It reads, runs, and writes
 *   inside the copy, and its writes cannot reach the target because the copy is a
 *   different root bound writable and the target is bound read-only.
 *
 * Two definitions rather than one is what makes the fence checkable: the engineer's
 * tool list is the only one that contains a write tool, so "the investigator cannot
 * change the code" is a statement about a list in this file rather than about a branch
 * somewhere in a loop.
 */

import { freeAgentIdFor } from '../freebuff-agents'
import { freebuffMetadata, FreebuffSessionError } from '../freebuff-session'
import { TRUST_FRAMING } from '../pipeline/prompt'
import { DEFAULT_MODEL_CONFIG } from '../models'
import { classifyProviderFailure, statusCodeOf } from '../provider-failure'

import { DEFAULT_INVESTIGATOR_STEPS } from './limits'
import { DEFAULT_INVESTIGATOR_AGENT, createInvestigatorTools, investigatorToolNames } from './tools'

import type { AgentDefinition, CodebuffClient, RunOptions } from '@codebuff/sdk'
import type { FreebuffSessions } from '../freebuff-session'
import type { ModelRoleConfig } from '../models'
import type { ProviderFailure } from '../provider-failure'
import type { ProposedSite, ProposalRejection } from './propose'
import type { CopyWriteRecord, InvestigatorAgentName, InvestigatorToolOptions, ToolResultRecord } from './tools'
import type { InvestigatorWorkspace } from './workspace'

/**
 * The investigator's standing rules.
 *
 * `TRUST_FRAMING` first and unchanged, then the part that is about *this* role. The
 * stances are stated as rules rather than as encouragement because each one is a
 * place the model would otherwise substitute a plausible answer for a checked one:
 *
 * - **Reproduce, or say you could not.** An agent that can run commands has no
 *   excuse for asserting a defect it never demonstrated, and the failure mode of a
 *   chat is a confident answer built on a file it read once.
 * - **Cite `file:line`.** The evidence bundle's whole design is that a claim is
 *   attached to a location; an investigator's answer that is not is unusable to the
 *   human adjudicating beside it.
 * - **Report the refutation too.** The investigator is not the Proposer. A model
 *   asked to look into a candidate that turns out to be benign should say so, or the
 *   screen gains a third voice that only ever agrees with whoever asked first.
 * - **You cannot change the target.** Stated because the tools make it look
 *   possible — `run_in_target` takes a command — and a model that believes it can
 *   write will waste turns discovering otherwise.
 */
const INVESTIGATOR_TASK = [
  'TASK: you investigate a target checkout and report what you find.',
  '',
  'Unlike the pipeline roles that judge candidates from a fixed evidence bundle, you',
  'may read the checkout and run commands in it. Use that:',
  '',
  '- read_target_file, search_target_files, list_target_directory, run_in_target, and',
  '  propose_candidate are your only tools. There is no write tool, and there is no',
  '  network.',
  '- The target is mounted read-only. A command that tries to modify it will fail; do',
  '  not attempt it, and do not treat the failure as a finding.',
  '- Prefer demonstrating to asserting. If you can compile, run, or otherwise execute',
  '  something that settles the question, do that and report the command and its output.',
  '  If you cannot, say plainly that the claim is unverified and why.',
  '- Cite file:line for every factual claim about the code.',
  '',
  'When you are asked to explain a specific candidate, argue neither for nor against',
  'it: establish what the code actually does, and report that — including when what it',
  'does is benign.',
  '',
  'When you are asked to hunt, **every site you find must go through',
  'propose_candidate**. That call is what records it. A site you only describe in your',
  'prose answer is not recorded and nothing downstream will ever see it — no triage, no',
  'verification, no report. Prose is how you summarise; propose_candidate is how you',
  'file. A hunt that ends with findings in its summary and none in proposals has not',
  'done its job, so before you finish, check that you have proposed each site you are',
  'claiming.',
  '',
  'Also say which parts of the checkout you did not examine. An accurate statement of',
  'what you did not look at is worth more than a confident one about what you did.',
  '',
  'Answer in prose. There is no output schema and no structured result to fill in.',
].join('\n')

/**
 * The engineer's standing rules.
 *
 * `TRUST_FRAMING` first and unchanged — target text is data for this agent too, and
 * more so: the engineer is the one being asked to *act* on what it reads, so an
 * instruction smuggled into a file is a proposed edit rather than a wrong sentence.
 */
const ENGINEER_TASK = [
  'TASK: you work on a writable working copy of a target checkout, for security',
  'research — writing proofs of concept, patching to test whether a fix holds, and',
  'building the tree to see what it actually does.',
  '',
  'The checkout itself is mounted read-only at its own path and you cannot change it.',
  'The working copy is a copy of it, made when this conversation started, and it is',
  'yours to edit and build. Every edit lands in the copy; the target stays exactly as',
  'the finding cites it, which is what makes your work re-checkable.',
  '',
  '- read_copy_file, search_copy_files, list_copy_directory, run_in_copy,',
  '  write_copy_file, replace_in_copy_file, apply_patch_in_copy, and',
  '  propose_candidate are your only tools. There is no network.',
  '- Edit the copy, never the target. Paths outside the copy are refused, and the',
  '  refusal is not a hint that the path is elsewhere. To read the original, read it',
  '  from the target path in a run command: it is mounted read-only beside the copy.',
  '- Prefer demonstrating to asserting. Write the harness, build it, run it, and',
  '  report the command and its output. If the build fails, report the failure rather',
  '  than working around it silently — a tree that does not build is a result.',
  '- Use apply_patch_in_copy for a change you can express as a diff, and',
  '  replace_in_copy_file for one exact edit. Both refuse rather than guess, and a',
  '  refusal means the file does not say what you thought: re-read it and try again.',
  '- Cite file:line for every factual claim. When you cite the target, cite the',
  '  target; when you cite something you changed, say that you changed it.',
  '- propose_candidate records a site in the **target** — the evidence, never your',
  '  own patch. Describing a site in your answer does not record it.',
  '',
  'Say what you changed, what you did not examine, and what you did not build.',
  '',
  'Answer in prose. There is no output schema and no structured result to fill in.',
].join('\n')

export const buildInvestigatorSystemPrompt = (
  agent: InvestigatorAgentName = DEFAULT_INVESTIGATOR_AGENT,
): string =>
  `${TRUST_FRAMING}\n\n${agent === 'engineer' ? ENGINEER_TASK : INVESTIGATOR_TASK}`

/**
 * The investigator's default model.
 *
 * Read from the config table rather than repeated here, so `models.investigator` in a
 * config file reaches the agent and there is one place the default lives. Slice 3 gave
 * it a row; before that this file was the only copy, which is the kind of duplicate that
 * survives right up until someone changes one of them.
 */
export const DEFAULT_INVESTIGATOR_MODEL: ModelRoleConfig =
  DEFAULT_MODEL_CONFIG.investigator

/**
 * One turn's outcome.
 *
 * A failed call is a result here for the same reason a refused read is a result in
 * `./tools`: an investigator that could not run is a fact the human needs, and an
 * exception thrown into a render loop is not a way to report it.
 */
export interface InvestigatorTurn {
  ok: boolean
  /** The agent that produced this turn (§20.30). */
  agent: InvestigatorAgentName
  /**
   * Files this turn wrote in the working copy, in order (§20.30.1).
   *
   * Empty for every investigator turn by construction — its tool list has no write
   * tool — so a non-empty list here is itself evidence that the engineer ran.
   */
  writes: CopyWriteRecord[]
  /**
   * True when the caller's `AbortSignal` stopped this turn (spec §20.29.5 slice 6).
   *
   * A flag rather than a wording convention on `error`: "you stopped it" and "it broke"
   * are different facts and §18 is about not letting one read as the other. A cancelled
   * turn is not a failed one, and the pane says so.
   */
  cancelled: boolean
  /** The assistant's prose, or null when the run produced none. */
  answer: string | null
  /**
   * Every tool call the run made, in order, as recorded by the tool set.
   *
   * The record carries which tool, the signals it neutralized, and any failure — the
   * arguments the model passed are not kept here, because a record's job is to be the
   * audit trail for *what the model was shown* (§20.29.3), and slice 3 is where a
   * transcript that wants arguments will store them.
   */
  toolCalls: ToolResultRecord[]
  /**
   * Sites the run recorded as candidates, in the order it proposed them (§20.29.4).
   *
   * Validated locations, not candidates: turning one into a §4.5 candidate needs a run
   * id and the target root, and this method has neither. That split is deliberate — it
   * is what keeps the agent from being able to write to `candidates` at all.
   */
  proposals: ProposedSite[]
  /** Proposals the tool refused, with the reason, so a hunt can report them. */
  proposalRejections: ProposalRejection[]
  /**
   * Provider-reported model requests this turn made.
   *
   * Counted here rather than in the budget because this is where the SDK reports it: the
   * runtime fires `onUsage` once per root-agent request, so a turn's cost is observable
   * and does not have to be inferred from tool calls (which under-counts, since one
   * request may call several tools). Zero means the provider reported nothing — a fake
   * client, or a request that ended before a receipt arrived — and the conversation
   * budget charges one call in that case.
   */
  modelCalls: number
  /** Total tokens across those requests, when reported. Informational, never a ceiling. */
  totalTokens: number
  error: string | null
  /**
   * Why the turn was refused, when the reason was the *account* rather than the call
   * (§18, `provider-failure.ts`).
   *
   * Separate from `error`, which says what happened in one turn. This says the turn
   * could not have happened, and neither could the next one: a balance with no credits
   * or a credential the provider rejects is a fact about the caller, so a surface has to
   * be able to tell it apart from the ordinary failures a long session accumulates.
   * Null whenever `error` is null, and for every failure that is about the call itself.
   */
  failure: ProviderFailure | null
}

export interface InvestigatorOptions {
  client: CodebuffClient
  /**
   * The Freebuff session this turn is billed to (spec §20.41).
   *
   * Required for the same reason `createSdkModelInvoker`'s is: without one the run
   * is billed as a metered call, and the account this was built for has no credits
   * — a live turn met exactly that 402. A session is bound to one model, so an
   * investigator on a different model than the pipeline's uses its own.
   */
  sessions: FreebuffSessions
  workspace: InvestigatorWorkspace
  /** Which agent runs. The engineer requires a workspace with a working copy. */
  agent?: InvestigatorAgentName
  model?: ModelRoleConfig
  maxAgentSteps?: number
  /** Extra options for the tool set; `onResult` is chained, not replaced. */
  toolOptions?: Omit<InvestigatorToolOptions, 'workspace'>
  /**
   * Every provider usage report, forwarded after this module has counted it.
   *
   * Chained rather than replaced for the same reason the tool recorders are: a caller's
   * observer must not be able to hide a call from the count the turn returns.
   *
   * The type is derived rather than named: the SDK reports usage through
   * `RunOptions['onUsage']` and does not re-export the usage shape, so borrowing the one
   * that exists keeps this honest instead of restating it and drifting.
   */
  onUsage?: NonNullable<RunOptions['onUsage']>
  log?: (line: string) => void
}

export interface Investigator {
  /** Which agent this investigator is. */
  readonly agent: InvestigatorAgentName
  /** The agent definition, exposed so a caller can assert its tool list. */
  readonly definition: AgentDefinition
  ask(input: { prompt: string; signal?: AbortSignal }): Promise<InvestigatorTurn>
}

/**
 * The agent definition.
 *
 * `toolNames` is the custom tool names and nothing else. That is stronger than it
 * looks: the runtime filters `customToolDefinitions` down to the names in this list
 * (`run-agent-step.ts`'s `additionalToolDefinitions`), so the list is the *only*
 * thing that decides what this agent can call — and it contains no built-in.
 *
 * The list is chosen by agent (§20.30), and the two are exported as constants so a
 * test can assert the difference directly: `ENGINEER_TOOL_NAMES` is the only one with a
 * write tool in it, and `INVESTIGATOR_TOOL_NAMES` has none.
 */
export const buildInvestigatorAgentDefinition = (
  model: ModelRoleConfig = DEFAULT_INVESTIGATOR_MODEL,
  agent: InvestigatorAgentName = DEFAULT_INVESTIGATOR_AGENT,
): AgentDefinition => ({
  // The Freebuff root agent for this model (§20.41): free mode admits only specific
  // agent/model combinations, so an id of our own is refused at the provider. Which of
  // the two *windbreak* agents this is stays in `displayName` and in the recorded turn —
  // the gate matches the id, and both agents are the same root as far as it is concerned.
  id: freeAgentIdFor(model.model),
  displayName: agent === 'engineer' ? 'WindBreak engineer' : 'WindBreak investigator',
  model: model.model,
  toolNames: investigatorToolNames(agent),
  systemPrompt: buildInvestigatorSystemPrompt(agent),
  // The tool is named here because a capability the instructions never mention is a
  // capability the model may not use: the first live hunt read both files, ran seven
  // commands, and proposed nothing, because the system prompt said "report what you
  // found" and reporting in prose is what it did. That is the same defect as
  // `pipeline/invoke.ts` telling a role not to use the tool its output mode requires —
  // found the same way, by running it.
  instructionsPrompt:
    agent === 'engineer'
      ? 'Work on the working copy: read what you need, make the edit or write the ' +
        'harness, build and run it, and report the exact commands and their output. ' +
        'Record any site you find in the target with propose_candidate. Do not claim ' +
        'anything you have not run or read.'
      : 'Investigate the target. Record every site you find with the propose_candidate ' +
        'tool — describing it in your answer does not record it — then summarise what you ' +
        'proposed and what you did not examine. Do not guess about files you have not read.',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Text of one assistant message's content, which is a string or a part array. */
const textOfContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('')
}

/**
 * The assistant's prose out of a `last_message` run.
 *
 * The filter on `role: 'assistant'` is the load-bearing part: a `last_message` value
 * is the whole last turn — tool results included — and joining everything would put
 * the *target's own text* into the answer we record. That is §5.1's boundary being
 * crossed by a string concatenation rather than by a prompt, which is the kind of
 * leak no fence can catch afterwards.
 */
export const assistantTextFrom = (value: unknown): string | null => {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (!Array.isArray(value)) return null

  const text = value
    .filter((message) => isRecord(message) && message.role === 'assistant')
    .map((message) => textOfContent((message as { content?: unknown }).content))
    .filter((part) => part.length > 0)
    .join('\n')

  return text.length > 0 ? text : null
}

/**
 * Build an investigator bound to one client and one workspace.
 *
 * The workspace is captured here and handed to the tools, so the root is fixed for
 * the life of the object: an `ask` cannot be pointed at a different checkout, which
 * is the confinement `./workspace` implements, held for the whole conversation
 * rather than one call.
 */
export const createInvestigator = (options: InvestigatorOptions): Investigator => {
  const {
    client,
    workspace,
    agent = DEFAULT_INVESTIGATOR_AGENT,
    model = DEFAULT_INVESTIGATOR_MODEL,
    maxAgentSteps = DEFAULT_INVESTIGATOR_STEPS,
  } = options
  const log = options.log ?? (() => {})

  const definition = buildInvestigatorAgentDefinition(model, agent)

  return {
    agent,
    definition,

    async ask({ prompt, signal }) {
      const toolCalls: ToolResultRecord[] = []
      const proposals: ProposedSite[] = []
      const proposalRejections: ProposalRejection[] = []
      /**
       * What this turn wrote, in order (§20.30.1).
       *
       * Collected here rather than derived from `toolCalls` because a patch that
       * touched four files is four reads of "what did the model do" and one line of the
       * transcript is not enough to say so.
       */
      const writes: CopyWriteRecord[] = []

      // Provider-reported model requests, counted as they arrive. Zero means nothing was
      // reported, which `conversation.ts` charges as one call rather than as free.
      let modelCalls = 0
      let totalTokens = 0

      /**
       * Fill in the fields no return site should have to remember.
       *
       * `signal?.aborted` is read at call time rather than captured, so a turn the caller
       * cancelled mid-flight reports itself as cancelled even though the SDK settles it as
       * a plain error (`getCancelledRunState` produces `{ type: 'error' }`).
       */
      const outcome = ({
        statusCode,
        ...partial
      }: Pick<InvestigatorTurn, 'ok' | 'answer' | 'error'> & {
        /**
         * The thrown error's HTTP status, where there is one to read.
         *
         * Read at the throw site and passed in rather than carried on the type: it is
         * evidence for the classification below and not a fact about the turn, and the
         * `output` path has no status to offer at all.
         */
        statusCode?: number | undefined
      }): InvestigatorTurn => ({
        ...partial,
        agent,
        cancelled: signal?.aborted === true,
        modelCalls,
        totalTokens,
        toolCalls,
        proposals,
        proposalRejections,
        writes,
        // Classified from the error the turn is reporting, so the two cannot disagree:
        // an `error` that reads as a refusal but is not labelled as one is the failure
        // this field exists to prevent.
        failure: classifyProviderFailure({
          message: partial.error ?? '',
          statusCode,
        }),
      })

      /** Wording for a turn the caller stopped, used wherever the abort surfaces. */
      const CANCELLED = 'the turn was cancelled before it finished'

      const tools = createInvestigatorTools({
        workspace,
        agent,
        ...options.toolOptions,
        // All three chained rather than replaced, for the same reason: a caller-supplied
        // recorder must not be able to hide a call or a proposal from what this method
        // returns.
        onResult: (record) => {
          toolCalls.push(record)
          options.toolOptions?.onResult?.(record)
        },
        onWrite: (record) => {
          writes.push(record)
          options.toolOptions?.onWrite?.(record)
        },
        onProposal: (site) => {
          proposals.push(site)
          options.toolOptions?.onProposal?.(site)
        },
        onRejection: (rejection) => {
          proposalRejections.push(rejection)
          options.toolOptions?.onRejection?.(rejection)
        },
      })

      // Opened before the run, like the pipeline's: the session is what makes the
      // call free, so a turn that could not get one never reaches the provider.
      let lease
      try {
        lease = await options.sessions.forModel(model.model)
      } catch (error) {
        return outcome({
          ok: false,
          answer: null,
          error:
            error instanceof FreebuffSessionError
              ? `no Freebuff session for ${model.model}: ${error.message}`
              : `could not open a Freebuff session: ${
                  error instanceof Error ? error.message : String(error)
                }`,
        })
      }

      try {
        const result = await client.run({
          agent: definition,
          prompt,
          customToolDefinitions: tools,
          maxAgentSteps,
          costMode: options.sessions.costMode,
          ...(freebuffMetadata(lease)
            ? { extraCodebuffMetadata: freebuffMetadata(lease) }
            : {}),
          // Counted here, not inferred from tool calls: one request can ask for several
          // tools, so `toolCalls + 1` is an upper bound on requests and not the count.
          // §20.29.6's ceiling is on what a provider charges for, which is this.
          onUsage: (usage) => {
            // Only root requests. This agent has no sub-agents today, and counting every
            // report would still be right, but `isRoot` is what makes the number the one a
            // provider invoice for *this* turn would show rather than a widened one.
            if (usage.isRoot) {
              modelCalls += 1
              totalTokens += Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0
            }
            options.onUsage?.(usage)
          },
          ...(signal ? { signal } : {}),
        })

        const output = result.output

        if (output.type === 'error') {
          return outcome({
            ok: false,
            answer: null,
            error: signal?.aborted ? CANCELLED : `investigator: ${output.message}`,
          })
        }

        if (output.type === 'lastMessage') {
          const answer = assistantTextFrom(output.value)

          // No prose means the agent never finished its turn — most often because it ran
          // out of steps. Reporting that as `ok` was a real defect: the first live hunt
          // came back `ok: true, answer: null, proposals: []`, which reads as a run that
          // looked and found nothing rather than one that was cut off mid-exploration
          // (§18, and the same substitution as an empty result standing in for a failed
          // search). Any proposals are still returned — sites the model did record before
          // it stopped are sites — but the turn is not a success.
          if (answer === null) {
            return outcome({
              ok: false,
              answer: null,
              // A cut-off run and a cancelled one are both incomplete but they are not
              // the same fact: one ran out of room, the other was stopped. Answered
              // separately because §18 is exactly about not conflating those.
              error: signal?.aborted
                ? CANCELLED
                : 'the investigator produced no answer, which means it ran out of steps ' +
                  'before finishing its turn' +
                  (proposals.length > 0
                    ? `; ${proposals.length} candidate(s) were proposed before it stopped, ` +
                      'and are returned, but the turn is incomplete'
                    : ' and proposed nothing'),
            })
          }

          return outcome({ ok: true, answer, error: null })
        }

        // `all_messages` and `structured` are both wrong for this agent: the first is
        // a configuration change nobody asked for, and the second would mean the
        // definition grew an output schema this role must not have (§20.29.3). Read
        // as a failure rather than coerced into an answer.
        return outcome({
          ok: false,
          answer: null,
          error:
            `investigator returned ${output.type}, but this agent is built for prose ` +
            'output. A structured result here would be a verdict the pipeline did not ' +
            'ask for and must not read.',
        })
      } catch (error) {
        log(`[investigate] run failed: ${error instanceof Error ? error.message : error}`)
        // Kept even on a failed run: a site the model proposed before the failure is
        // still a site, and dropping it would lose work the researcher asked for.
        return outcome({
          ok: false,
          answer: null,
          error: signal?.aborted
            ? CANCELLED
            : `investigator run failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
          // The path a rejected credential takes: the SDK throws rather than returning
          // an error output, and the message it throws (`Authentication failed`) does
          // not name the account — the status is what makes the refusal legible.
          statusCode: signal?.aborted ? undefined : statusCodeOf(error),
        })
      }
    },
  }
}
