import { describe, expect, it } from 'bun:test'

import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { getStubProjectFileContext } from '@codebuff/common/util/file'

import { applyOverridesToSessionState } from '../run-state'

import type { SessionState } from '@codebuff/common/types/session-state'
import type { Logger } from '@codebuff/common/types/contracts/logger'

const recorded: Array<{ data: unknown; msg?: string }> = []
const makeLogger = (events: Array<{ data: unknown; msg?: string }>): Logger => {
  const record = (data: unknown, msg?: string): void => {
    events.push({ data, msg })
  }
  return { debug: record, info: record, warn: record, error: record }
}
const logger = makeLogger(recorded)

const state = (): SessionState =>
  getInitialSessionState({ ...getStubProjectFileContext() })

/** A value JSON cannot carry, in the place the runtime used to put live schemas. */
const withCycle = (target: SessionState): Record<string, unknown> => {
  const cyclic: Record<string, unknown> = { name: 'tool' }
  cyclic.self = cyclic
  target.mainAgentState.toolDefinitions = {
    t: { description: 'a tool', inputSchema: cyclic },
  }
  return cyclic
}

describe('applyOverridesToSessionState', () => {
  it('continues from a state JSON cannot serialize instead of failing the run', async () => {
    recorded.length = 0
    const base = state()
    withCycle(base)
    const stepsBefore = base.mainAgentState.stepsRemaining

    const continued = await applyOverridesToSessionState(
      '/repo',
      base,
      { maxAgentSteps: 7 },
      logger,
    )

    // The turn's own work still happens: the overrides are applied to a real clone, not to
    // the state the caller still holds.
    expect(continued.mainAgentState.stepsRemaining).toBe(7)
    expect(base.mainAgentState.stepsRemaining).toBe(stepsBefore)
    expect(continued.mainAgentState.messageHistory).not.toBe(
      base.mainAgentState.messageHistory,
    )
    // And the reason the slow clone was paid is on the record, naming the same TypeError the
    // user used to see as `SDK client.run() failed`.
    expect(recorded.map((event) => event.msg)).toContain(
      'JSON clone of session state failed; falling back to cloneDeep',
    )
    expect(
      JSON.stringify(recorded.find((event) => event.msg?.includes('cloneDeep'))?.data),
    ).toContain('cyclic')
  })

  it('takes the JSON path, and says nothing, for a state JSON can carry', async () => {
    recorded.length = 0
    const base = state()

    const continued = await applyOverridesToSessionState('/repo', base, {}, logger)

    expect(recorded).toEqual([])
    expect(continued).not.toBe(base)
    // A clone, not a reference: the JSON path is what the state is stored as, so what comes
    // back has the same shape as a state that was persisted and reloaded.
    expect(continued.mainAgentState).toEqual(base.mainAgentState)
    expect(continued.mainAgentState).not.toBe(base.mainAgentState)
  })
})
