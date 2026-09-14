import { listTables, openStateDatabase, SCHEMA_VERSION } from '../state/db'

import type { Command } from 'commander'

const DEFAULT_DB_PATH = '.windbreak/state.db'

interface DbInitOptions {
  path?: string
}

export const registerDbCommand = (program: Command): void => {
  const db = program
    .command('db')
    .description('Manage the WindBreak run-state database')

  db.command('init')
    .description('Create the state database and schema if they do not exist')
    .option('--path <path>', 'database path', DEFAULT_DB_PATH)
    .action((options: DbInitOptions) => {
      const databasePath = options.path ?? DEFAULT_DB_PATH
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
