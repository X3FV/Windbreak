import { describe, expect, test } from 'bun:test'

import {
  buildWindbreakPrompt,
  consumeWindbreakInvocation,
  findWindbreakCommand,
  resolveWindbreakCommand,
} from '../windbreak-launch'

describe('findWindbreakCommand', () => {
  test('finds the subcommand after the entry point', () => {
    expect(findWindbreakCommand(['bun', 'entry.ts', 'windbreak'])).toBe(2)
  })

  test('walks past options that consume a value', () => {
    // The client's launcher always passes --cwd, so `windbreak` is rarely the
    // token right after the entry point.
    expect(
      findWindbreakCommand(['bun', 'entry.ts', '--cwd', '/repo', 'windbreak']),
    ).toBe(4)
    expect(
      findWindbreakCommand(['bun', 'entry.ts', '--cwd=/repo', 'windbreak']),
    ).toBe(3)
  })

  test('does not mistake a prompt for the subcommand', () => {
    // A first positional that is not the subcommand ends the scan, so a prompt
    // that happens to contain the word is still a prompt.
    expect(
      findWindbreakCommand(['bun', 'entry.ts', 'fix the windbreak build']),
    ).toBeNull()
    expect(findWindbreakCommand(['bun', 'entry.ts', '--', 'windbreak'])).toBeNull()
  })

  test('is null when nothing is asked of windbreak', () => {
    expect(findWindbreakCommand(['bun', 'entry.ts'])).toBeNull()
    expect(findWindbreakCommand(['bun', 'entry.ts', 'login'])).toBeNull()
  })
})

describe('resolveWindbreakCommand', () => {
  test('names the workspace CLI from a source checkout', () => {
    // The test file lives in the checkout, so the resolved command has to be
    // one that can actually be run there.
    expect(resolveWindbreakCommand()).toContain('windbreak')
  })
})

describe('buildWindbreakPrompt', () => {
  test('names the read and the write, and leaves the decision to the human', () => {
    const prompt = buildWindbreakPrompt('')

    expect(prompt).toContain('review --json')
    expect(prompt).toContain('--decide <candidateId> --as real|benign')
    // The queue is a human tiebreak; the brief must not read as an instruction
    // to resolve entries on its own.
    expect(prompt).toContain('ask before recording')
    expect(prompt).toContain('No arguments were given')
  })

  test('passes the invocation arguments through', () => {
    const prompt = buildWindbreakPrompt('--run 41 --all')

    expect(prompt).toContain('--run 41 --all')
    expect(prompt).not.toContain('No arguments were given')
  })
})

describe('consumeWindbreakInvocation', () => {
  test('is null for an ordinary invocation, and leaves argv alone', () => {
    const argv = ['bun', 'entry.ts', 'refactor the parser']

    expect(consumeWindbreakInvocation(argv)).toBeNull()
    expect(argv).toEqual(['bun', 'entry.ts', 'refactor the parser'])
  })

  test('turns the subcommand, and only the subcommand, into the first message', () => {
    const argv = ['bun', 'entry.ts', '--cwd', '/repo', 'windbreak', '--run', '41']
    const prompt = consumeWindbreakInvocation(argv)

    expect(prompt).toContain('--run 41')
    // The launcher's own flags are not part of what the agent is asked to do —
    // only the arguments after the subcommand token travel with it.
    expect(prompt).not.toContain('/repo')
  })

  test('removes the subcommand and its arguments from argv', () => {
    // Load-bearing: the main parser accepts `login` as its only positional and
    // has no `--run`, so leaving these behind makes commander reject the launch
    // before the chat app starts. It is what the old screen intercepted for.
    const argv = ['bun', 'entry.ts', '--cwd', '/repo', 'windbreak', '--run', '41']

    consumeWindbreakInvocation(argv)

    expect(argv).toEqual(['bun', 'entry.ts', '--cwd', '/repo'])
  })
})
