import { getAuthTokenDetails } from '../auth'

import type { Command } from 'commander'

export const registerAuthCommand = (program: Command): void => {
  const auth = program
    .command('auth')
    .description('Inspect the credentials WindBreak will use for model routing')

  auth
    .command('status')
    .description(
      'Report whether credentials resolve, and from where. Never prints the token.',
    )
    .action(() => {
      const { token, source, credentialsPath } = getAuthTokenDetails()

      console.log(`credentials file: ${credentialsPath}`)

      if (!token || !source) {
        console.error(
          '\nNo credentials found. Run `freebuff` to log in, or set CODEBUFF_API_KEY.',
        )
        process.exitCode = 1
        return
      }

      console.log(`token source:     ${source}`)
      console.log('token:            [redacted]')
      console.log('\nOK: model routing has credentials.')
    })
}
