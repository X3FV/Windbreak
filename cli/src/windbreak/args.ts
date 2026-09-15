import path from 'path'

import { Command, CommanderError, Option } from 'commander'

/**
 * `freebuff windbreak` — the adjudication surface (spec D32).
 *
 * Two reasons this is parsed separately rather than added to the main CLI's
 * options. The main program has no place for `--db`, and `windbreak` is a
 * distinct surface with its own lifetime: it opens a state database, renders,
 * and exits without starting a chat session. Keeping the parser here is what
 * lets `freebuff windbreak --help` describe only what it accepts.
 */

export interface WindbreakArgs {
  /** The only subcommand so far; the token is optional. */
  subcommand: 'review'
  /**
   * `--db`, when the caller named one — **never a default**.
   *
   * The database this screen opens depends on the repository on screen and that checkout's own
   * config, neither of which is known here, so choosing one is `database.ts`'s job. This reports
   * what was *asked for*; a parser that also invented a fallback could not tell the two apart,
   * which is exactly how a configured database came to be overridden by a guess.
   *
   * Same shape as the batch commands, whose `--db` carries no default either — the command
   * resolves `options.db ?? defaultDbPath()`.
   */
  dbPath?: string | undefined
  runId?: string | undefined
  includeResolved: boolean
  /** `--cwd`, so the default database path follows the client's working dir. */
  cwd: string
  /**
   * The windbreak config file, when one was named.
   *
   * The screen's only configurable numbers are the investigator's limits (§20.29.6), and
   * they live in the same file the batch commands read — so `--config` is named once and
   * every surface sees one configuration rather than each having its own defaults.
   */
  configPath?: string | undefined
}

export class WindbreakUsageError extends Error {
  constructor(
    message: string,
    /** True when the caller asked for help, which is not a misuse. */
    readonly help: boolean = false,
  ) {
    super(message)
    this.name = 'WindbreakUsageError'
  }
}

const DEFAULT_SUBCOMMAND = 'review'

/**
 * Options that consume the next token, so the dispatch scan below does not
 * mistake a value for the subcommand.
 *
 * The client's launcher always passes `--cwd <dir>`, so `windbreak` is rarely
 * the first token after the entry point — the scan has to walk past options
 * rather than look at a fixed index.
 */
const VALUE_TAKING_FLAGS = new Set(['--cwd', '--agent', '--continue'])

/**
 * The index of the `windbreak` subcommand token, or null.
 *
 * Stops at the first positional: an initial prompt that merely contains the word
 * "windbreak" is a prompt, not a subcommand.
 */
export const findWindbreakCommand = (argv: readonly string[]): number | null => {
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!

    if (token === '--') return null
    if (!token.startsWith('-')) return token === 'windbreak' ? index : null
    if (VALUE_TAKING_FLAGS.has(token) && !token.includes('=')) index += 1
  }

  return null
}

const buildProgram = (): Command => {
  const program = new Command()

  program
    .name('freebuff windbreak')
    .description('Work the WindBreak adjudication queue (spec §5.3)')
    .argument('[subcommand]', `what to open (default: ${DEFAULT_SUBCOMMAND})`)
    .option(
      '--db <path>',
      "WindBreak state database to read and write (default: the checkout's own)",
    )
    .option('--run <id>', 'only the disagreements from this run')
    .addOption(
      new Option(
        '--all',
        'include disagreements that have already been decided',
      ).default(false),
    )
    .option('--cwd <directory>', 'resolve the default database path from here')
    .option(
      '--config <path>',
      'config file with the investigator limits the chat pane uses',
    )
    .configureOutput({
      writeErr: () => {},
      writeOut: () => {},
    })
    .exitOverride()

  return program
}

export const windbreakHelp = (): string => {
  const lines: string[] = []
  const program = buildProgram()
  program.configureOutput({
    writeOut: (text) => lines.push(text),
    writeErr: (text) => lines.push(text),
  })
  program.outputHelp()
  return lines.join('').trimEnd()
}

/** Parse the argv *after* the `windbreak` token. */
export const parseWindbreakArgs = (argvAfterCommand: readonly string[]): WindbreakArgs => {
  const program = buildProgram()

  try {
    program.parse([...argvAfterCommand], { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed') {
        throw new WindbreakUsageError(windbreakHelp(), true)
      }
      throw new WindbreakUsageError(error.message)
    }
    throw error
  }

  const options = program.opts<{
    db?: string
    run?: string
    all: boolean
    cwd?: string
    config?: string
  }>()

  // `program.args` holds what was actually typed; commander's argument default
  // lives in the action handler this parser does not use.
  const subcommand = program.args[0] ?? DEFAULT_SUBCOMMAND
  if (subcommand !== DEFAULT_SUBCOMMAND) {
    throw new WindbreakUsageError(
      `unknown windbreak subcommand "${String(subcommand)}"; the only one so far is "review"`,
    )
  }

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd()

  return {
    subcommand: DEFAULT_SUBCOMMAND,
    // A relative --db follows the client's working directory, not the shell's: the launcher
    // changes directory for the whole session, and a database is found where the scan that
    // wrote it was run from. Absent stays absent — see `dbPath` above.
    ...(options.db === undefined
      ? {}
      : {
          dbPath: path.isAbsolute(options.db)
            ? options.db
            : path.resolve(cwd, options.db),
        }),
    runId: options.run?.trim() ? options.run.trim() : undefined,
    includeResolved: options.all === true,
    cwd,
    // Relative to the same working directory the database follows, so a config named
    // beside a repository resolves the way the launcher's `--cwd` implies.
    configPath: options.config
      ? path.isAbsolute(options.config)
        ? options.config
        : path.resolve(cwd, options.config)
      : undefined,
  }
}
