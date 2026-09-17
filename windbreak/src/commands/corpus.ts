import { execFileSync } from 'node:child_process'
import fs from 'fs'
import path from 'path'

import { buildCorpus, DEFAULT_MAX_FUNCTION_LINES } from '../eval'
import { parseSource } from '../recon/parser'

import type { Command } from 'commander'
import type { BuildCorpusResult, CorpusSource, ParsedCallable } from '../eval'

interface CorpusBuildOptions {
  source?: string[]
  out?: string
  maxCommits?: string
  maxFunctionLines?: string
  json?: boolean
}

const collect = (value: string, previous: string[]): string[] => [...previous, value]

/**
 * One `--source name=path`.
 *
 * Refused on a malformed spec rather than defaulting either half: a project name
 * is what the pairs are attributed to, and a path with no name would produce a
 * corpus whose provenance column reads `undefined`.
 */
const parseSourceSpec = (value: string): CorpusSource => {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `--source expects "name=path", got "${value}". The name is what the corpus ` +
        'attributes the pairs to, so it cannot be inferred from the directory.',
    )
  }

  const project = value.slice(0, separator).trim()
  const repoDir = path.resolve(value.slice(separator + 1).trim())

  if (project.length === 0) throw new Error(`--source "${value}" has an empty project name`)
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    throw new Error(
      `--source "${project}" points at ${repoDir}, which is not a git checkout. The ` +
        'builder reads fix commits and the revision before each one, so a working tree ' +
        'without history cannot produce a pair.',
    )
  }

  return { project, repoDir }
}

/**
 * Read one commit's diff.
 *
 * The buffer is generous because a single security commit can be large, and a
 * truncated diff would drop hunks silently — which is the failure mode the whole
 * tier exists to avoid, one level down.
 */
const runGit = (repoDir: string, args: readonly string[]): string =>
  String(
    execFileSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )

/** Function boundaries come from the same parser recon uses (§4.4). */
const parseCallables = async (source: string): Promise<readonly ParsedCallable[]> =>
  (await parseSource('c', source)).symbols

const renderBuildReport = (result: BuildCorpusResult, outPath: string): string => {
  const out: string[] = []
  const { stats, drops, pairSet } = result

  out.push(`${pairSet.corpus}: ${pairSet.pairs.length} pair(s)`)
  out.push('')
  out.push(`  commits read              ${stats.commitsRead}`)
  out.push(`  commits that gave a pair  ${stats.commitsWithPairs}`)
  out.push(`  files considered          ${stats.filesConsidered}`)
  out.push(`  pairs found               ${stats.pairsFound}`)
  out.push(`  duplicates collapsed      ${stats.pairsDeduplicated}`)
  out.push(`  written to                ${outPath}`)

  if (stats.dropsByReason.length > 0) {
    out.push('')
    out.push(`drops (${drops.length}):`)
    for (const entry of stats.dropsByReason) {
      out.push(`  ${String(entry.count).padStart(6)}  ${entry.reason}`)
    }
  }

  out.push('')
  out.push('caveats:')
  out.push(
    '  - the index is the commit message. A fix is in this corpus only if the commit ' +
      'that made it names a CVE id, so it is the disclosed subset rather than a sample ' +
      'of the project\u2019s vulnerabilities',
  )
  out.push(
    '  - each pair is one function at the fix commit\u2019s parent and the same function at ' +
      'the fix, so the two halves differ in code and not merely in comments',
  )
  out.push(
    '  - the pairs span the whole weakness space. The committed rule set tests seven ' +
      'shapes, so it cannot fire on every pair here and a low score is not by itself ' +
      'evidence that a rule is wrong',
  )

  return out.join('\n')
}

export const registerCorpusCommand = (program: Command): void => {
  const corpus = program
    .command('corpus')
    .description('Build a recall corpus out of upstream fix commits (spec §11.1)')

  corpus
    .command('build')
    .description(
      'Mine vulnerable/patched function pairs from commits that name a CVE, and write ' +
        'a pair set `eval --rules` can score',
    )
    .option(
      '--source <name=path>',
      'a git checkout to read, with the project name to attribute its pairs to (repeatable)',
      collect,
      [],
    )
    .requiredOption('--out <file>', 'where to write the pair set JSON')
    .option('--max-commits <n>', 'stop after this many CVE-naming commits per project')
    .option(
      '--max-function-lines <n>',
      `skip a function longer than this (default ${DEFAULT_MAX_FUNCTION_LINES})`,
    )
    .option('--json', 'emit the stats as JSON')
    .action(async (options: CorpusBuildOptions) => {
      let sources: CorpusSource[]
      try {
        sources = (options.source ?? []).map(parseSourceSpec)
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
        return
      }

      if (sources.length === 0) {
        console.error(
          'no --source given. A corpus is mined from checkouts, so there is nothing to ' +
            'read: pass `--source <project>=<path>` at least once.',
        )
        process.exitCode = 1
        return
      }

      const maxCommitsPerProject =
        options.maxCommits === undefined ? undefined : Number.parseInt(options.maxCommits, 10)
      if (
        maxCommitsPerProject !== undefined &&
        (!Number.isFinite(maxCommitsPerProject) || maxCommitsPerProject <= 0)
      ) {
        console.error(`Invalid --max-commits: ${options.maxCommits}`)
        process.exitCode = 1
        return
      }

      const maxFunctionLines =
        options.maxFunctionLines === undefined
          ? DEFAULT_MAX_FUNCTION_LINES
          : Number.parseInt(options.maxFunctionLines, 10)
      if (!Number.isFinite(maxFunctionLines) || maxFunctionLines <= 0) {
        console.error(`Invalid --max-function-lines: ${options.maxFunctionLines}`)
        process.exitCode = 1
        return
      }

      const result = await buildCorpus({
        sources,
        deps: { runGit, parseCallables },
        ...(maxCommitsPerProject === undefined ? {} : { maxCommitsPerProject }),
        maxFunctionLines,
        log: options.json ? () => {} : (line) => console.log(line),
      })

      const outPath = path.resolve(options.out!)
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, `${JSON.stringify(result.pairSet, null, 2)}\n`)

      if (options.json) {
        console.log(
          JSON.stringify({ stats: result.stats, drops: result.drops, out: outPath }, null, 2),
        )
      } else {
        console.log('')
        console.log(renderBuildReport(result, outPath))
      }

      // A corpus that produced nothing would score nothing, and `eval` would then
      // report a measurement it could not make. Failing here names the cause.
      if (result.pairSet.pairs.length === 0) process.exitCode = 1
    })
}
