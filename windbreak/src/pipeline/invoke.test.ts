import { describe, expect, test } from 'bun:test'

import { freeAgentIdFor } from '../freebuff-agents'
import { FreebuffSessionError } from '../freebuff-session'
import { DEFAULT_MODEL_CONFIG } from '../models'
import { buildRoleAgentDefinition, createSdkModelInvoker } from './invoke'
import { PROMPT_TEMPLATE_VERSION } from './context'
import { TRIAGE_OUTPUT_SPEC } from './prompt'

import type { CodebuffClient } from '@codebuff/sdk'
import type { FreebuffSessions } from '../freebuff-session'
import type { ModelInvocation, StructuredOutputSpec } from './types'

/**
 * A session per model, with no network.
 *
 * The invoker refuses to be constructed without one, so every test that builds one
 * needs this — which is the point: the missing session was what made every call a
 * metered call, and it went unnoticed because the parameter was optional.
 */
const fakeSessions = (): FreebuffSessions => ({
  costMode: 'free',
  forModel: async (model) => ({ instanceId: `sess-${model}`, model, reused: false }),
  release: async () => {},
})

const invocation: ModelInvocation = {
  role: 'triage',
  systemPrompt: 'system',
  userPrompt: 'user',
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  timeoutMs: 1_000,
}

interface Captured {
  agent: {
    id: string
    model: string
    toolNames?: string[]
    outputMode?: string
    outputSchema?: unknown
  }
  prompt: string
  maxAgentSteps?: number
  costMode?: string
  extraCodebuffMetadata?: Record<string, string>
}

const fakeClient = (
  output: unknown,
  capture?: (options: Captured) => void,
): CodebuffClient =>
  ({
    run: async (options: unknown) => {
      capture?.(options as Captured)
      return { output, traceSessionId: 'trace' }
    },
  }) as unknown as CodebuffClient

const spec = TRIAGE_OUTPUT_SPEC as unknown as StructuredOutputSpec<{
  label: string
  rationale: string
}>

describe('buildRoleAgentDefinition', () => {
  test('pins the role model, keeps exactly the output tool, and asks for structured output', () => {
    const definition = buildRoleAgentDefinition(
      'refuter',
      DEFAULT_MODEL_CONFIG,
      'refute it',
      TRIAGE_OUTPUT_SPEC as unknown as StructuredOutputSpec<unknown>,
    )

    // The Freebuff root agent for the refuter's model, not `windbreak-refuter`: free
    // mode admits only specific agent/model combinations, so an id of our own is refused
    // at the provider (§20.41). The role is still ours — the prompt, the fence and the
    // schema below are all windbreak's.
    expect(definition.id).toBe(freeAgentIdFor(DEFAULT_MODEL_CONFIG.refuter.model))
    expect(definition.displayName).toBe('WindBreak refuter')
    expect(definition.model).toBe(DEFAULT_MODEL_CONFIG.refuter.model)
    expect(definition.outputMode).toBe('structured_output')
    expect(definition.systemPrompt).toBe('refute it')
    expect(definition.outputSchema as unknown).toBe(TRIAGE_OUTPUT_SPEC.jsonSchema)

    // `set_output` is the answer channel, not a read tool: `structured_output`
    // reads `agentState.output`, which only that tool sets. An empty list here is
    // not a stricter fence, it is a call that always returns `value: null` — and
    // the SDK's own validation for it is disabled upstream, so only a live call or
    // this assertion can catch it.
    expect(definition.toolNames).toEqual(['set_output'])
    // The §5.1 fence is what is *absent*: no repository-reading tool may appear.
    for (const tool of definition.toolNames ?? []) {
      expect(['set_output']).toContain(tool)
    }

    // The instructions must name the tool the runtime requires. This used to read
    // "Do not use tools", which contradicted the runtime's own "You must use the
    // `set_output` tool" and cost roughly one call in two in live runs.
    expect(definition.instructionsPrompt).toContain('set_output')
    expect(definition.instructionsPrompt).not.toMatch(/do not use tools/i)
    // The fence still has to be stated: no reading the repository.
    expect(definition.instructionsPrompt).toMatch(/do not read files/i)
  })
})

describe('createSdkModelInvoker', () => {
  test('reports the configured model, vendor, and that no seed is supported', () => {
    const invoker = createSdkModelInvoker({
      client: fakeClient({}),
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })

    const identity = invoker.identity('proposer')
    expect(identity.modelId).toBe(DEFAULT_MODEL_CONFIG.proposer.model)
    expect(identity.provider).toBe('deepseek')
    expect(identity.seed).toBe(42)
    // The agent path exposes no seed, so this must not claim otherwise.
    expect(identity.seedSupported).toBe(false)
  })

  test('returns the validated value on a good structured answer', async () => {
    let captured: Captured | undefined
    const client = fakeClient(
      { type: 'structuredOutput', value: { label: 'likely-real', rationale: 'yes' } },
      (options) => {
        captured = options
      },
    )

    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })
    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value).toEqual({ label: 'likely-real', rationale: 'yes' })
    }
    expect(captured?.agent.model).toBe(DEFAULT_MODEL_CONFIG.triage.model)
    expect(captured?.agent.toolNames).toEqual(['set_output'])
    expect(captured?.prompt).toBe('user')

    // Two steps is the runtime's retry budget, not a task judgement: the retry it
    // injects for a missing output needs a step to run in, and `1` would spend the
    // only one on the first turn. On success the loop breaks before the second call.
    expect(captured?.maxAgentSteps).toBe(2)
  })

  test('treats an SDK error output as a failure, not an answer', async () => {
    const client = fakeClient({ type: 'error', message: 'rate limited' })
    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })

    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('rate limited')
  })

  test('treats an unexpected output mode as a failure', async () => {
    const client = fakeClient({ type: 'lastMessage', value: [] })
    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })

    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/instead of a structured result/)
  })

  test('treats a null structured value as a failure, and says why', async () => {
    // This is the shape the SDK returns when an agent ends its turn without
    // calling `set_output`. It gets its own message rather than the
    // "returned structuredOutput instead of a structured result" one, which read
    // as a contradiction and named neither cause.
    const client = fakeClient({ type: 'structuredOutput', value: null })
    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })

    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('returned no structured value')
      expect(outcome.error).toContain('set_output')
      expect(outcome.error).not.toContain('instead of a structured result')
    }
  })

  test('rejects a structured answer that does not satisfy the schema', async () => {
    const client = fakeClient({
      type: 'structuredOutput',
      value: { label: 'probably-real', rationale: 'x' },
    })
    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })

    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/did not match windbreak_triage/)
  })

  test('turns a thrown client error into a failed outcome', async () => {
    const client = {
      run: async () => {
        throw new Error('socket hang up')
      },
    } as unknown as CodebuffClient

    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })
    const outcome = await invoker.invoke(invocation, spec)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('socket hang up')
  })

  test('every call is billed to a Freebuff session, not to the account', async () => {
    // §20.41's regression guard. Both fields are what make the call free: without
    // `costMode` the SDK sends `'normal'`, and without the instance id the server has
    // no session to admit it against. Every call windbreak made was missing both, so
    // the model half answered HTTP 402 `Out of credits` on a command whose own model
    // table calls these models unmetered.
    let captured: Captured | undefined
    const client = fakeClient(
      { type: 'structuredOutput', value: { label: 'likely-real', rationale: 'yes' } },
      (options) => {
        captured = options
      },
    )

    const invoker = createSdkModelInvoker({
      client,
      sessions: fakeSessions(),
      models: DEFAULT_MODEL_CONFIG,
    })
    await invoker.invoke(invocation, spec)

    expect(captured?.costMode).toBe('free')
    expect(captured?.extraCodebuffMetadata?.freebuff_instance_id).toBe(
      `sess-${DEFAULT_MODEL_CONFIG.triage.model}`,
    )
  })

  test('a session that cannot be opened is a failed call, and no call is made', async () => {
    // The refusal has to land before the provider is reached: a metered fallback would
    // be the same defect wearing the error message.
    let ran = false
    const client = fakeClient({ type: 'structuredOutput', value: {} }, () => {
      ran = true
    })
    const invoker = createSdkModelInvoker({
      client,
      sessions: {
        costMode: 'free',
        forModel: async () => {
          throw new FreebuffSessionError('model_locked', 'held by a chat on glm')
        },
        release: async () => {},
      },
      models: DEFAULT_MODEL_CONFIG,
    })

    const outcome = await invoker.invoke(invocation, spec)

    expect(ran).toBe(false)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error).toContain('no Freebuff session')
      expect(outcome.error).toContain('held by a chat on glm')
    }
  })
})
