import { describe, expect, test } from 'bun:test'

import { createMeteredSessions } from '../freebuff-session'
import { DEFAULT_MODEL_CONFIG } from '../models'
import { PROMPT_TEMPLATE_VERSION } from '../pipeline/context'
import { TRIAGE_OUTPUT_SPEC } from '../pipeline/prompt'
import { defaultResolveInvoker } from './run'

import type { CodebuffClient } from '@codebuff/sdk'
import type { WindbreakModelHost } from '../client'
import type { ModelInvocation, StructuredOutputSpec } from '../pipeline/types'

/**
 * A scan run on a host it did not open (spec §20.41).
 *
 * The scan is the stage a hosted caller reaches through `launchScan` — the freebuff CLI's
 * `/scan` — and this is the seam that decides whose client pays. Two properties are
 * asserted, and they are the two that the free-mode question turns on:
 *
 * 1. The invoker runs on the **injected** client. A stage that resolved its own transport
 *    would make the whole seam decorative, and against a caller-restricted free tier it
 *    would also be refused at the provider.
 * 2. The outcome reports **no `close`**, so the scan's end-of-run release steps over it.
 *    Releasing a borrowed session would end a chat the scan did not open.
 */

const invocation: ModelInvocation = {
  role: 'triage',
  systemPrompt: 'system',
  userPrompt: 'user',
  promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  timeoutMs: 1_000,
}

const spec = TRIAGE_OUTPUT_SPEC as unknown as StructuredOutputSpec<{
  label: string
  rationale: string
}>

describe('defaultResolveInvoker with an injected host', () => {
  test('builds the invoker on the caller’s client, and offers nothing to release', async () => {
    let calls = 0
    const client = {
      run: async () => {
        calls += 1
        return {
          output: { type: 'structuredOutput', value: { label: 'likely-real', rationale: 'x' } },
          traceSessionId: 'trace',
        }
      },
    } as unknown as CodebuffClient

    const host: WindbreakModelHost = { client, sessions: createMeteredSessions() }
    const outcome = await defaultResolveInvoker(DEFAULT_MODEL_CONFIG, () => {}, host)()

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // The borrowed host is not the scan's to close. Absent rather than a no-op, because
    // the scan calls it unconditionally when it is present.
    expect(outcome.close).toBeUndefined()

    // And the call actually went through the injected client rather than a resolved one,
    // which is what a credential-less environment would have refused outright.
    const result = await outcome.invoker.invoke(invocation, spec)
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
  })

  test('carries the injected billing through to the call', async () => {
    // A borrowed host that arrived free must not be quietly downgraded to metered: that
    // would change who pays for the scan without saying so, which is the subject of the
    // section rather than a detail of it.
    const seen: string[] = []
    const client = {
      run: async (options: { costMode?: string }) => {
        seen.push(options.costMode ?? '(none)')
        return {
          output: { type: 'structuredOutput', value: { label: 'likely-real', rationale: 'x' } },
          traceSessionId: 'trace',
        }
      },
    } as unknown as CodebuffClient

    const host: WindbreakModelHost = {
      client,
      sessions: { ...createMeteredSessions(), costMode: 'free' },
    }
    const outcome = await defaultResolveInvoker(DEFAULT_MODEL_CONFIG, () => {}, host)()

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    await outcome.invoker.invoke(invocation, spec)
    expect(seen).toEqual(['free'])
  })
})
