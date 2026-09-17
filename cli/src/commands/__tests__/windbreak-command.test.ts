import { describe, expect, mock, test } from 'bun:test'

import { COMMAND_REGISTRY } from '../command-registry'

import type { RouterParams } from '../command-registry'

/**
 * `/windbreak` has two behaviours behind one name: bare it opens the queue view, and with a brief
 * it hands the brief to the agent. Which one runs is the whole contract — a bare `/windbreak` that
 * silently sent a prompt would leave a researcher waiting on a model to do a screen's job, and a
 * `/windbreak review --run X` that opened a view would ignore its own arguments.
 */
const createMockParams = (overrides: Partial<RouterParams> = {}): RouterParams =>
  ({
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue: '/windbreak',
    isChainInProgressRef: { current: false },
    isStreaming: false,
    logoutMutation: {} as RouterParams['logoutMutation'],
    streamMessageIdRef: { current: null },
    addToQueue: mock(() => {}),
    clearMessages: mock(() => {}),
    saveToHistory: mock(() => {}),
    scrollToLatest: mock(() => {}),
    sendMessage: mock(async () => {}),
    setCanProcessQueue: mock(() => {}),
    setInputFocused: mock(() => {}),
    setInputValue: mock(() => {}),
    setIsAuthenticated: mock(() => {}),
    setMessages: mock(() => {}),
    setUser: mock(() => {}),
    ...overrides,
  }) as RouterParams

const windbreak = (): NonNullable<ReturnType<typeof COMMAND_REGISTRY.find>> =>
  COMMAND_REGISTRY.find((command) => command.name === 'windbreak')!

describe('/windbreak', () => {
  test('bare, it opens the queue view rather than sending a brief', () => {
    const sendMessage = mock(async () => {})
    const params = createMockParams({ inputValue: '/windbreak', sendMessage })

    const result = windbreak().handler(params, '')

    expect(result).toEqual({ openWindbreakQueue: true })
    expect(sendMessage).not.toHaveBeenCalled()
    // The typed command still lands in history, and the composer is cleared, whichever branch ran.
    expect(params.saveToHistory).toHaveBeenCalledWith('/windbreak')
  })

  test('whitespace is not a brief', () => {
    const sendMessage = mock(async () => {})
    const params = createMockParams({ inputValue: '/windbreak   ', sendMessage })

    expect(windbreak().handler(params, '   ')).toEqual({ openWindbreakQueue: true })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  test('with arguments it still sends the brief to the agent', () => {
    const sendMessage = mock(
      async (_input: { content: string; agentMode: string }) => {},
    )
    const params = createMockParams({ inputValue: '/windbreak review --run run-9', sendMessage })

    const result = windbreak().handler(params, 'review --run run-9')

    expect(result).toBeUndefined()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const sent = sendMessage.mock.calls[0]![0] as { content: string; agentMode: string }
    expect(sent.content).toContain('run-9')
    expect(sent.agentMode).toBe('DEFAULT')
  })

  test('it is registered as accepting arguments', () => {
    expect(windbreak().acceptsArgs).toBe(true)
  })
})
