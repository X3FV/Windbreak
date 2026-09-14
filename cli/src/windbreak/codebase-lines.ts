/**
 * The codebase pane's text (spec §20.30).
 *
 * Kept out of the component for the reason `detail-lines.ts` and `chat-lines.ts` are: the
 * listing is the part that can be *wrong* — a tree that loses a directory, a file counted
 * twice, a truncated listing that reads as complete, an empty inventory that reads as a
 * clean repository — and all of that is checkable without a renderer.
 *
 * ## Two listings, and it says which one it drew
 *
 * Preferring §4.1's `recon_files` over a directory walk is deliberate: the inventory is
 * what every stage reasons over, so listing it lists the same files the findings are
 * about, and a walk shown *as* an inventory would promise coverage that does not exist.
 * §20.31 keeps that rule and answers the other half of it — a checkout nothing has scanned
 * still has a codebase worth showing — by making the walk a **second source with its own
 * label** rather than a substitute for the first. The header names which one it is, and
 * the filesystem listing says outright that no finding cites what it lists.
 *
 * ## Four states, said differently
 *
 * An inventory, a filesystem walk, and `null` (no target *and* no directory) are three
 * facts; an empty list is a fourth, and which sentence it gets depends on which source it
 * came from — "recon indexed nothing" and "the walk found nothing" are different claims
 * about different things. §18's rule is about not letting "not checked" read as "clean",
 * and a file pane is exactly where that mistake is easy: an empty tree looks like an empty
 * repository.
 */

import { REPO_WALK_MAX_FILES } from '@codebuff/windbreak/review'

import type { ReviewCodebase, ReviewCodebaseFile } from '@codebuff/windbreak/review'

/**
 * Rows the pane will render before it stops.
 *
 * A large repository has tens of thousands of files, and a listing is not improved by
 * being complete — it is improved by being *honest about being partial*. The cap is
 * reported as a count rather than silently applied, the same discipline each sweep's
 * site cap follows.
 */
export const MAX_CODEBASE_ROWS = 500

/** What a line is *for*, so the pane colours it without parsing its text. */
export type CodebaseTone = 'normal' | 'muted' | 'info' | 'warning'

export interface CodebaseLine {
  text: string
  tone: CodebaseTone
}

export interface CodebaseTreeRow {
  /** Path relative to the target root, as the pipeline names it. */
  path: string
  /** The last segment, which is what the tree shows. */
  name: string
  depth: number
  kind: 'directory' | 'file'
  language: string | null
  bytes: number
  binary: boolean
  /** Files underneath, for a directory. Zero for a file. */
  fileCount: number
}

/** `1.2k` / `8.2M` — abbreviated, because the exact byte count is not the point. */
export const formatCodebaseBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
}

const countLabel = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`

interface DirNode {
  dirs: Map<string, DirNode>
  files: ReviewCodebaseFile[]
}

const emptyNode = (): DirNode => ({ dirs: new Map(), files: [] })

const fileCountIn = (node: DirNode): number => {
  let total = node.files.length
  for (const child of node.dirs.values()) total += fileCountIn(child)
  return total
}

/**
 * Build the tree, directories first then files, each alphabetical.
 *
 * Directories before files rather than a single mixed sort, because that is what every
 * file browser does and a reader arrives with that expectation. The ordering is by *name*
 * at each level, not by path, so a directory's children stay under it.
 */
export const buildCodebaseRows = (
  files: readonly ReviewCodebaseFile[],
): CodebaseTreeRow[] => {
  const root = emptyNode()

  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) continue

    let node = root
    for (const segment of segments.slice(0, -1)) {
      const existing = node.dirs.get(segment)
      if (existing) {
        node = existing
        continue
      }
      const created = emptyNode()
      node.dirs.set(segment, created)
      node = created
    }
    node.files.push(file)
  }

  const rows: CodebaseTreeRow[] = []

  const walk = (node: DirNode, depth: number, prefix: string): void => {
    for (const name of [...node.dirs.keys()].sort()) {
      const child = node.dirs.get(name)!
      const path = prefix === '' ? name : `${prefix}/${name}`
      rows.push({
        path,
        name,
        depth,
        kind: 'directory',
        language: null,
        bytes: 0,
        binary: false,
        fileCount: fileCountIn(child),
      })
      walk(child, depth + 1, path)
    }

    for (const file of [...node.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const segments = file.path.split('/')
      rows.push({
        path: file.path,
        name: segments[segments.length - 1] ?? file.path,
        depth,
        kind: 'file',
        language: file.language,
        bytes: file.bytes,
        binary: file.binary,
        fileCount: 0,
      })
    }
  }

  walk(root, 0, '')
  return rows
}

export const CODEBASE_NO_TARGET_MESSAGE =
  'No target is on record and no repository was resolved, so there is no codebase to list.'

export const CODEBASE_NO_TARGET_HOWTO =
  'A file listing comes from recon (§4.1) or from the checkout the screen was pointed ' +
  'at, so it needs one of the two. Run a scan, or open the screen in a repository.'

export const CODEBASE_EMPTY_MESSAGE =
  'recon recorded no files for this target.'

export const CODEBASE_EMPTY_HOWTO =
  'That is a statement about recon, not about the repository: an empty inventory is not ' +
  'a checkout with no files. Re-run recon to rebuild it.'

/** The label on the header, so the source of the rows is never implied. */
export const CODEBASE_UNSCANNED_LABEL = 'not scanned'

/**
 * What the filesystem listing is, said before the rows rather than after them.
 *
 * It has to be a sentence and not a word, because the mistake it prevents is a
 * *reasonable* one: a file tree beside a queue reads as the target of that queue,
 * and here it is not — nothing was ever parsed, so no row in the pane is a file
 * any finding is about.
 */
export const CODEBASE_UNSCANNED_MESSAGE =
  'This is the checkout on disk, not recon’s inventory: nothing here has been scanned, ' +
  'so no finding cites these files.'

export const CODEBASE_UNSCANNED_HOWTO =
  'A scan indexes the target and runs the engines over it. Until then this pane is a ' +
  'file viewer, and the queue beside it is empty because nothing was checked.'

/** The filesystem walk's own cap, reported so a partial listing cannot read as whole. */
export const codebaseTruncatedMessage = (cap: number): string =>
  `The walk stopped at its ${cap}-file cap, so this listing is partial.`

export const CODEBASE_WALK_EMPTY_MESSAGE =
  'the walk found no files in this repository.'

export const CODEBASE_WALK_EMPTY_HOWTO =
  'Directories and binary-less paths are skipped by the same ignore rules recon uses, ' +
  'so an empty walk means the tree holds nothing that would be indexed either.'

const renderRow = (row: CodebaseTreeRow): CodebaseLine => {
  const indent = '  '.repeat(row.depth)

  if (row.kind === 'directory') {
    // A directory is chrome, not content: the researcher is looking for files, and the
    // directories are how the paths are shaped. Colouring them as information keeps
    // them scannable without making every ancestor a headline.
    return { text: `${indent}${row.name}/  (${row.fileCount})`, tone: 'info' }
  }

  const meta = [
    row.language ?? '',
    formatCodebaseBytes(row.bytes),
    row.binary ? 'binary' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' · ')

  return {
    text: meta === '' ? `${indent}${row.name}` : `${indent}${row.name}  ${meta}`,
    // A binary is metadata without a language and is usually not where a C-shaped
    // finding lives; muting it keeps the source files dominant.
    tone: row.binary ? 'muted' : 'normal',
  }
}

export interface CodebaseLines {
  lines: CodebaseLine[]
  /** Files in the target. Null when there is no target at all. */
  fileCount: number | null
  /** Rows dropped by the cap, so a partial listing never reads as a complete one. */
  omitted: number
}

/**
 * The whole pane content.
 *
 * The header names the target and the commit, because a file tree with no provenance is a
 * tree of *some* repository — and a finding is only meaningful against a pinned revision.
 * It is the same fact the pipeline carries in `Target.commitSha`, surfaced where a
 * researcher can see it without opening anything.
 */
export const buildCodebaseLines = (
  codebase: ReviewCodebase | null,
  options: { maxRows?: number } = {},
): CodebaseLines => {
  if (codebase === null) {
    return {
      lines: [
        { text: CODEBASE_NO_TARGET_MESSAGE, tone: 'warning' },
        { text: '', tone: 'muted' },
        { text: CODEBASE_NO_TARGET_HOWTO, tone: 'muted' },
      ],
      fileCount: null,
      omitted: 0,
    }
  }

  const maxRows = options.maxRows ?? MAX_CODEBASE_ROWS
  const bytes = codebase.files.reduce((sum, file) => sum + file.bytes, 0)
  const languages = new Set(
    codebase.files
      .map((file) => file.language)
      .filter((language): language is string => language !== null),
  )

  const scale =
    `${countLabel(codebase.files.length, 'file')} · ${formatCodebaseBytes(bytes)}` +
    (languages.size > 0 ? ` · ${countLabel(languages.size, 'language')}` : '')

  // The header is where the two sources are told apart, and the filesystem one is
  // warned rather than muted: a tree beside a queue reads as the queue's target unless
  // something says otherwise, and `not scanned` is that something.
  const lines: CodebaseLine[] = [
    codebase.source === 'inventory'
      ? { text: `target: ${codebase.location} · ${scale}`, tone: 'muted' }
      : {
          text: `root: ${codebase.location} · ${CODEBASE_UNSCANNED_LABEL} · ${scale}`,
          tone: 'warning',
        },
  ]

  // A commit is only recorded for a target, so there is none to print for a walk: the
  // listing is of a checkout *now*, and naming a revision nobody pinned would make it
  // look reproducible against one.
  if (codebase.source === 'inventory' && codebase.commitSha !== null) {
    lines.push({ text: `commit: ${codebase.commitSha}`, tone: 'muted' })
  }
  lines.push({ text: '', tone: 'muted' })

  if (codebase.source === 'filesystem') {
    lines.push(
      { text: CODEBASE_UNSCANNED_MESSAGE, tone: 'warning' },
      { text: CODEBASE_UNSCANNED_HOWTO, tone: 'muted' },
      { text: '', tone: 'muted' },
    )
  }

  if (codebase.files.length === 0) {
    // Which nothing this is depends on which source it came from: recon indexing
    // nothing and a walk finding nothing are claims about different things, and a
    // shared sentence would make one of them wrong.
    lines.push(
      ...(codebase.source === 'inventory'
        ? [
            { text: CODEBASE_EMPTY_MESSAGE, tone: 'warning' as const },
            { text: '', tone: 'muted' as const },
            { text: CODEBASE_EMPTY_HOWTO, tone: 'muted' as const },
          ]
        : [
            { text: CODEBASE_WALK_EMPTY_MESSAGE, tone: 'warning' as const },
            { text: '', tone: 'muted' as const },
            { text: CODEBASE_WALK_EMPTY_HOWTO, tone: 'muted' as const },
          ]),
    )
    return { lines, fileCount: 0, omitted: 0 }
  }

  const rows = buildCodebaseRows(codebase.files)
  const shown = rows.slice(0, Math.max(0, maxRows))
  for (const row of shown) lines.push(renderRow(row))

  const omitted = rows.length - shown.length
  if (omitted > 0) {
    lines.push(
      { text: '', tone: 'muted' },
      {
        text: `${countLabel(omitted, 'row')} not shown — the listing is capped at ${maxRows}.`,
        tone: 'warning',
      },
    )
  }

  // The walk's own cap, which is a different ceiling from the display cap above: one is
  // how much of the repository was gathered and the other is how much is drawn. Reporting
  // only the second would present a partial walk as a small repository.
  if (codebase.source === 'filesystem' && codebase.truncated) {
    lines.push(
      { text: '', tone: 'muted' },
      { text: codebaseTruncatedMessage(REPO_WALK_MAX_FILES), tone: 'warning' },
    )
  }

  return { lines, fileCount: codebase.files.length, omitted }
}
