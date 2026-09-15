import { listTables, openStateDatabase, SCHEMA_VERSION } from '../state/db'
import { defaultDbPath } from './defaults'

import type { Command } from 'commander'

interface DbInitOptions {
  path?: string
}

export const registerDbCommand = (program: Command): void => {
  const db = program
    .command('db')
    .description('Manage the WindBreak run-state database')

  db.command('init')
    .description('Create the state database and schema if they do not exist')
    .option(
      '--path <path>',
      'database path; defaults to the configured one, else <cwd>/.windbreak/state.db',
      defaultDbPath(),
    )
    .action((options: DbInitOptions) => {
      const databasePath = options.path ?? defaultDbPath()
      const database = openStateDatabase(databasePath)

      try {
        const tables = listTables(database)
        console.log(`Database: ${databasePath}`)
        console.log(`Schema version: ${SCHEMA_VERSION}`)
        console.log(`Tables (${tables.length}): ${tables.join(', ')}`)
      } finally {
        database.close()
      }
    })
}
