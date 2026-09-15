import { describe, expect, test } from 'bun:test'
import path from 'path'

import { findWindbreakCommand, parseWindbreakArgs, WindbreakUsageError } from '../args'

describe('findWindbreakCommand', () => {
  test('finds the subcommand in the plain invocation', () => {
    expect(findWindbreakCommand(['bun', '/app/index.ts', 'windbreak'])).toBe(2)
  })

  test('walks past the launcher\u2019s --cwd and its value', () => {
    // The client's launcher always passes this, so the subcommand is never at a
    // fixed index.
    expect(
      findWindbreakCommand(['bun', '/app/index.ts', '--cwd', '/repo', 'windbreak', 'review']),
    ).toBe(4)
  })

  test('does not mistake a prompt containing the word for the subcommand', () => {
    expect(findWindbreakCommand(['bun', '/app/index.ts', 'fix the windbreak docs'])).toBeNull()
    expect(findWindbreakCommand(['bun', '/app/index.ts', 'login'])).toBeNull()
  })

  test('treats everything after -- as a prompt', () => {
    expect(findWindbreakCommand(['bun', '/app/index.ts', '--', 'windbreak'])).toBeNull()
  })

  test('a bare launch is not the subcommand', () => {
    expect(findWindbreakCommand(['bun', '/app/index.ts'])).toBeNull()
  })
})

describe('parseWindbreakArgs', () => {
  test('defaults to the review subcommand and names no database', () => {
    // No `dbPath`: which database this screen opens depends on the repository on screen and
    // that checkout's config, so it is `database.ts`'s decision, not the parser's. A parser
    // that also invented a fallback could not tell an explicit `--db` from its own default,
    // which is how a configured database came to be overridden by a guess.
    const args = parseWindbreakArgs([])
    expect(args).toEqual({
      subcommand: 'review',
      runId: undefined,
      includeResolved: false,
      cwd: process.cwd(),
    })
  })

  test('--db is reported only when it was named', () => {
    expect(parseWindbreakArgs([]).dbPath).toBeUndefined()
    expect(parseWindbreakArgs(['--db', 'state.db']).dbPath).toBe(
      path.resolve(process.cwd(), 'state.db'),
    )
  })

  test('accepts the subcommand token explicitly', () => {
    expect(parseWindbreakArgs(['review']).subcommand).toBe('review')
  })

  test('a relative database follows --cwd, not the shell', () => {
    const args = parseWindbreakArgs(['--cwd', '/repo/project', '--db', '.windbreak/state.db'])
    expect(args.dbPath).toBe(path.resolve('/repo/project', '.windbreak/state.db'))
  })

  test('an absolute database is left alone', () => {
    const args = parseWindbreakArgs(['--cwd', '/repo/project', '--db', '/elsewhere/state.db'])
    expect(args.dbPath).toBe('/elsewhere/state.db')
  })

  test('--run narrows the queue and --all shows resolved entries', () => {
    const args = parseWindbreakArgs(['--run', 'run_abc', '--all'])
    expect(args.runId).toBe('run_abc')
    expect(args.includeResolved).toBe(true)
  })

  test('an empty --run is treated as absent', () => {
    expect(parseWindbreakArgs(['--run', '   ']).runId).toBeUndefined()
  })

  test('--config resolves beside the database, and is absent when not named', () => {
    expect(parseWindbreakArgs([]).configPath).toBeUndefined()
    expect(parseWindbreakArgs(['--config', 'wb.json']).configPath).toBe(
      path.resolve(process.cwd(), 'wb.json'),
    )
    expect(
      parseWindbreakArgs(['--cwd', '/repo/project', '--config', 'wb.json']).configPath,
    ).toBe(path.resolve('/repo/project', 'wb.json'))
    expect(parseWindbreakArgs(['--config', '/etc/wb.json']).configPath).toBe('/etc/wb.json')
  })

  test('an unknown subcommand is refused by name', () => {
    expect(() => parseWindbreakArgs(['scan'])).toThrow(WindbreakUsageError)
    expect(() => parseWindbreakArgs(['scan'])).toThrow(/only one so far is "review"/)
  })

  test('an unknown option is refused rather than ignored', () => {
    expect(() => parseWindbreakArgs(['--nope'])).toThrow(WindbreakUsageError)
  })
})
