/**
 * The CLI version, in its own module.
 *
 * It lives here rather than in `index.ts` because commands need it (a SARIF
 * driver record carries it) and a command importing the CLI entry would create a
 * cycle: the entry imports the command.
 */
export const VERSION = '0.0.1'
