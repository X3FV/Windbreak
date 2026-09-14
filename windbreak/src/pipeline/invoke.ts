/**
 * The SDK-backed model invoker (spec §5.2, §8.1).
 *
 * This is the only module in the pipeline that talks to `@codebuff/sdk`, so
 * model routing stays a single point (§8) and every stage above it depends on
 * the `ModelInvoker` interface instead.
 *
 * Routing choice: `CodebuffClient.run()` with an inline `AgentDefinition` per
 * role. That pins the model per role through the public client, which is what
 * §8.1's per-role policy needs. The trade-off is recorded honestly rather than
 * hidden: the agent path exposes no temperature and no seed, so
 * `seedSupported` is false and §8.4's reproducibility rests on the verdict
 * cache (see `./cache`). Swapping to the SDK's single-shot `promptAiSdkStructured`
 * later is a change to this file only.
 */

import { modelVendor } from '../models'

import type { AgentDefinition, CodebuffClient } from '@codebuff/sdk'
import type { ModelConfig, ModelRole } from '../models'
import type {
  InvokeOutcome,
  ModelIdentity,
  ModelInvocation,
  ModelInvoker,
  StructuredOutputSpec,
} from './types'

export interface CreateSdkModelInvokerOptions {
  client: CodebuffClient
  models: ModelConfig
  /**
   * Hard ceiling on agent steps. Two by default, and that number is the
   * runtime's retry budget rather than a judgement about the task — see
   * `DEFAULT_MAX_AGENT_STEPS`.
   */
  maxAgentSteps?: number
  log?: (line: string) => void
}

/**
 * Two, because one is not enough and three buys nothing.
 *
 * The runtime already self-repairs a missing structured output: when the agent
 * ends its turn without setting one, `run-agent-step.ts` appends `You must use
 * the "set_output" tool to provide a result that matches the output schema` and
 * continues the loop (`hasRetriedOutputSchema`, exactly once). That retry needs a
 * step to run in, and `stepsRemaining` is initialised from this number
 * (`sdk/src/run-state.ts`), so **`1` guarantees the repair cannot happen**: the
 * first turn spends the only step, the reminder is appended with zero steps left,
 * and the guard at the top of the step force-ends the turn with no output — which
 * `getAgentOutput` then reports as `{ type: 'structuredOutput', value: null }`.
 *
 * This is not a cost trade. When the first turn *does* set the output, `shouldEndTurn`
 * breaks the loop before another model call, so two steps cost exactly what one
 * costs on the happy path and one extra call only on the path that would
 * otherwise have produced nothing at all.
 */
const DEFAULT_MAX_AGENT_STEPS = 2

const collapse = (text: string, max = 400): string => {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

/**
 * The only tool a role may use: the channel its answer comes back through.
 *
 * `set_output` is not a read tool. It reads nothing — it is how the agent hands
 * its finished answer to the runtime, and `structured_output` reads the value it
 * sets (`packages/agent-runtime/src/util/agent-output.ts` returns
 * `agentState.output`, which only `set_output` ever assigns, and
 * `run-agent-step.ts` injects `You must use the "set_output" tool to provide a
 * result` for exactly this mode).
 *
 * **This list must not be empty, and it must not grow.** An empty list was the
 * original value here, with the reasoning that a classifier must not go read the
 * repository — which is right, and which is about *read* tools. Because
 * `outputMode: 'structured_output'` has no other way to produce a value, the
 * empty list did not fence the role: it made every call fail, with
 * `{ type: 'structuredOutput', value: null }` and no error from the SDK, since
 * the validation that would have rejected it is deliberately disabled upstream
 * (`common/src/types/dynamic-agent-template.ts`: "If outputMode is
 * 'structured_output', 'set_output' tool must be included"). Nothing in the test
 * suite could see it either — the fixtures below feed the SDK's result in
 * directly, so a wrong `toolNames` is invisible to a fake client. It was found by
 * the first live model call.
 */
const ROLE_TOOLS: readonly string[] = ['set_output']

/**
 * Build the inline agent that represents one role.
 *
 * The tool list is load-bearing in both directions (§5.1): a role must not be
 * able to go read the repository, because that would be a second, unfenced path
 * for target content to reach the model and would make the verdict depend on
 * state the Refuter cannot see — and it must still be able to answer. So the list
 * is exactly `set_output`, and the fence is enforced by what is *absent* from it
 * rather than by it being empty.
 */
export const buildRoleAgentDefinition = (
  role: ModelRole,
  models: ModelConfig,
  systemPrompt: string,
  output: StructuredOutputSpec<unknown>,
): AgentDefinition => ({
  id: `windbreak-${role}`,
  displayName: `WindBreak ${role}`,
  model: models[role].model,
  toolNames: [...ROLE_TOOLS],
  outputMode: 'structured_output',
  // The SDK types this as its own JSON-schema shape; ours is a plain JSON
  // Schema for the same small contract.
  outputSchema: output.jsonSchema as unknown as AgentDefinition['outputSchema'],
  systemPrompt,
  // "Do not use tools" was here, and it was wrong the moment the answer travels
  // through a tool: the runtime injects "You must use the `set_output` tool", so
  // the model was told to use a tool and not to use tools in the same turn. Live
  // runs showed the cost — roughly one triage call in two ended its turn with
  // prose and no value set. This says the same thing about prose and about
  // reading the repository, which is what the original sentence was for.
  instructionsPrompt:
    'Call the `set_output` tool with the JSON object and nothing else. Do not read ' +
    'files, call any other tool, or add prose.',
})

export const createSdkModelInvoker = (
  options: CreateSdkModelInvokerOptions,
): ModelInvoker => {
  const { client, models } = options
  const log = options.log ?? (() => {})
  const maxAgentSteps = options.maxAgentSteps ?? DEFAULT_MAX_AGENT_STEPS

  const identity = (role: ModelRole): ModelIdentity => {
    const config = models[role]
    return {
      modelId: config.model,
      provider: modelVendor(config.model),
      temperature: config.temperature,
      seed: config.seed ?? null,
      // See the module comment: the agent path cannot set either.
      seedSupported: false,
    }
  }

  return {
    identity,

    async invoke<T>(
      request: ModelInvocation,
      output: StructuredOutputSpec<T>,
    ): Promise<InvokeOutcome<T>> {
      const base = identity(request.role)
      const definition = buildRoleAgentDefinition(
        request.role,
        models,
        request.systemPrompt,
        output as StructuredOutputSpec<unknown>,
      )

      let result
      try {
        result = await client.run({
          agent: definition,
          prompt: request.userPrompt,
          maxAgentSteps,
          // The stage budget is the governor's unit, so a single call needs its
          // own ceiling or a hung provider eats the stage silently.
          signal: AbortSignal.timeout(request.timeoutMs),
        })
      } catch (error) {
        return {
          ...base,
          ok: false,
          error: `${request.role} call failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }

      const agentOutput = result.output

      if (agentOutput.type === 'error') {
        return { ...base, ok: false, error: `${request.role}: ${agentOutput.message}` }
      }

      if (agentOutput.type !== 'structuredOutput') {
        // An unexpected output mode must never be read as a benign answer.
        return {
          ...base,
          ok: false,
          error: `${request.role} returned ${agentOutput.type} instead of a structured result`,
        }
      }

      if (agentOutput.value === null) {
        // A distinct condition from the one above, and it needs its own message:
        // this is what an agent looks like when it ended its turn without calling
        // `set_output` — the tool this definition must therefore keep enabled.
        return {
          ...base,
          ok: false,
          error:
            `${request.role} returned no structured value: the agent ended its turn ` +
            'without calling `set_output`, which is the only channel this output mode ' +
            'reads (§5.1 keeps every other tool off the role).',
        }
      }

      const parsed = output.schema.safeParse(agentOutput.value)
      if (!parsed.success) {
        log(`[pipeline] ${request.role} output failed schema validation`)
        return {
          ...base,
          ok: false,
          error: `${request.role} output did not match ${output.name}: ${collapse(
            parsed.error.message,
          )}`,
        }
      }

      return { ...base, ok: true, value: parsed.data }
    },
  }
}
