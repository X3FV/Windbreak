import fs from 'fs'
import path from 'path'

/**
 * `freebuff windbreak` — the adjudication surface, as a chat session.
 *
 * It used to be a screen of its own: `cli/src/windbreak` mounted a whole OpenTUI
 * app (start menu, queue, detail, decision panes, its own palette) before the
 * chat app existed. That is gone. The queue is worked by *talking* to the agent,
 * which reads it through the WindBreak CLI and records the same decisions
 * through `review --decide`, so the surface is the conversation and there is no
 * second renderer to keep in step with it.
 *
 * What survives is the invocation. `freebuff windbreak [args]` still takes its
 * own argv, because the main program has no `--db` and by design never will, and
 * the arguments become the session's first message rather than flags on a
 * screen — so a scripted invocation keeps working.
 */

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

/**
 * How the agent should reach the WindBreak CLI.
 *
 * The CLI is a workspace package (`windbreak/src/index.ts`), so from a source
 * checkout it is `bun run windbreak`; a machine with an installed build on
 * `PATH` uses the binary directly. Resolved while the prompt is built, so the
 * session's first message names a command that exists on this machine instead of
 * one the agent has to guess at. In a compiled CLI neither path is on disk and
 * the `PATH` form is the honest answer.
 */
export const resolveWindbreakCommand = (): string => {
  const repoRoot = path.resolve(import.meta.dir, '..', '..', '..')
  const entry = path.join(repoRoot, 'windbreak', 'src', 'index.ts')
  return fs.existsSync(entry) ? `bun run --cwd ${repoRoot} windbreak` : 'windbreak'
}

/**
 * The brief a WindBreak session opens with.
 *
 * `args` is whatever followed `windbreak` on the command line, or whatever the
 * researcher typed after `/windbreak` in chat — passed through verbatim so
 * `--run 41 --all` still means what it meant when the screen parsed it.
 *
 * Three things are stated outright because they are what the screen used to
 * *imply*: the CLI is `review --json` then `review --decide`; the decision is
 * the researcher's, never the model's (§5.3 records a human tiebreak, and
 * auto-resolving would either manufacture findings or discard them); and a
 * rationale is part of the record, not decoration.
 */
export const buildWindbreakPrompt = (args: string): string => {
  const cli = resolveWindbreakCommand()
  const trimmed = args.trim()

  return `Work the WindBreak adjudication queue (spec §5.3).

WindBreak's CLI is \`${cli}\` — run it with the terminal tool. The queue holds the candidates WindBreak's two providers disagreed on. A human decides each one and the decision is recorded with its rationale; nothing in WindBreak auto-resolves a queue entry, because inventing findings and discarding them are both wrong.

Read what is pending first:
\`${cli} review --json\`

For each entry, put the candidate in front of me — id, location, CWE, and the code at that location — along with both arguments as recorded (the proposer's and the refuter's). Then give me your own read of it: which way you would decide it, and why. I make the call, so ask before recording anything.

Record one decision with:
\`${cli} review --decide <candidateId> --as real|benign --rationale "<why>"\`

${
  trimmed
    ? `This invocation carried arguments — they apply to the commands above: ${trimmed}`
    : `No arguments were given, so use the defaults (the checkout's own database, and everything still pending).`
}`
}

/**
 * Take the `windbreak` subcommand out of `argv`, returning the session's first
 * message — or null when this is not a windbreak invocation, which is what tells
 * `index.tsx` to start an ordinary session.
 *
 * The tokens are *removed*, not left in place. The main program takes `login` as
 * its only positional and has no `--run`, so commander would reject the
 * subcommand ("unknown option '--run'") before the chat app ever started — the
 * very thing this module exists to avoid. `argv` is edited in place because that
 * is the array the parser downstream reads.
 *
 * Everything after the subcommand token belongs to windbreak; the flags *before*
 * it (`--cwd`, `--continue`) are the launcher's and stay.
 */
export const consumeWindbreakInvocation = (argv: string[]): string | null => {
  const index = findWindbreakCommand(argv)
  if (index === null) return null

  const prompt = buildWindbreakPrompt(argv.slice(index + 1).join(' '))
  argv.splice(index)
  return prompt
}
