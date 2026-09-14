/**
 * The writable working copy of the target (spec §20.30, slice 2).
 *
 * §20.30 splits the run into three roots and only two of them are writable. This
 * module materialises the middle one:
 *
 * | root | mode | what it is |
 * |---|---|---|
 * | the target | read-only bind | the evidence; what a finding cites |
 * | the working copy | writable | a copy a model may patch, edit and rebuild |
 * | scratch | writable | harnesses and probes (§20.29, already in place) |
 *
 * ## Why a copy instead of a `git worktree`
 *
 * §20.30's first draft named `git worktree` as the cheap way to make the copy,
 * since it shares an object store instead of duplicating it. It is rejected here
 * for the section's own reason: **`git worktree add` writes into the target's
 * `.git`** — it registers the worktree under `.git/worktrees/<name>` and drops a
 * `.git` pointer file in the copy. The target is evidence, and "the evidence was
 * not modified" has to survive an auditor running `find . -newer` over the
 * checkout, so a strategy that edits the evidence's *metadata* is still a
 * strategy that edited the evidence. Cheaper is not cheaper if it costs the one
 * property the whole design is arranged around.
 *
 * What is left is a filtered recursive copy: read the target, write only inside
 * scratch. It costs O(tree) rather than O(1), and it needs no repository at all —
 * a vendored tarball or a shallow clone gets the same working copy a full checkout
 * does. That matters because §20.21 already records that the two history miners
 * degrade to nothing on exactly those targets, and the editing loop must not
 * inherit that limit.
 *
 * ## The filter is recon's list, not a second one
 *
 * The skipped directories are `IGNORED_DIRECTORIES` from `recon/inventory.ts`.
 * That is deliberate rather than convenient: the copy should hold the files recon
 * indexed and then some, never fewer, or a model would be editing a tree that is
 * missing the file a finding is about. One list is what keeps those two from
 * drifting apart.
 *
 * ## Where the copy lives, and why the walk is written out
 *
 * The copy is created under the run's scratch directory, which is inside
 * `<target>/.windbreak/`. So the sandbox sees the target bound read-only and a
 * *subtree* of it bound writable. That is not a novel arrangement to worry about:
 * §20.6's build step already binds scratch writable inside a read-only checkout
 * (and §20.29's investigator scratch already does), and both are exercised live.
 * Both argv builders emit read-only binds before writable ones, and a later mount
 * over a nested path is what makes the subtree writable.
 *
 * The copy is made by an **explicit walk** rather than by `fs.cpSync`, and the reason
 * is that nesting: `cpSync` refuses outright to copy a tree into a subdirectory of
 * itself ("cannot copy X to a subdirectory of self"), *before* the filter is ever
 * consulted — so it cannot express this layout at all, whatever the filter says. The
 * walk also makes the two things this module has to get right explicit rather than
 * delegated: a symlink is recreated as a link and never followed outward, and a
 * regular file keeps its mode, which a build script needs.
 *
 * Nothing here runs a target program or reads target configuration. Copying bytes
 * cannot execute anything, which is why the *writer* is safe to do on the host; the
 * head of `recon/git.ts` is the record of what happens when it is not.
 */

import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'

import { IGNORED_DIRECTORIES } from '../recon/inventory'

/** The copy's directory name under scratch. Stable, so a reader can find it. */
export const WORKING_COPY_DIRECTORY = 'working-copy'

/** WindBreak's own bookkeeping directory, which is never part of the copy. */
export const WINDBREAK_DIRECTORY = '.windbreak'

/**
 * A copy of the target a model may write to.
 *
 * `id` exists so a recorded turn can say **which copy** a write landed in
 * (§20.30.1). A path alone would not do: the copy is recreated per screen session,
 * so the same path can be two different trees at two different times, and a
 * transcript that named only the path would attribute an edit to the wrong one.
 */
export interface WorkingCopy {
  id: string
  /** The copy's root, absolute. The only root a write may land in. */
  root: string
  /** The checkout it was made from, after `realpath`. Read, never written. */
  targetDir: string
  /** The revision the target was pinned to, when recon recorded one. */
  baseCommit: string | null
  strategy: WorkingCopyStrategy
  /** Files copied, and their total size, so the screen can say what the copy is. */
  files: number
  bytes: number
  /** ISO timestamp, so "which copy" has a time as well as a path. */
  createdAt: string
  /**
   * Directory names skipped, unique and sorted.
   *
   * Reported rather than silent, for the same reason the listing's row cap is: a
   * copy that is missing `dist/` must not read as a copy of a tree that had no
   * `dist/`.
   */
  excluded: string[]
}

/**
 * Only one strategy today, named as a union so a row that carries a second one
 * later cannot be read as this one (the rule `RecordedInvestigatorMode` follows).
 */
export type WorkingCopyStrategy = 'filtered-copy'

export class WorkingCopyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkingCopyError'
  }
}

export interface CreateWorkingCopyOptions {
  targetDir: string
  /** The copy is created inside this directory. Never inside the target's tree. */
  scratchDir: string
  commitSha?: string | null
  /** Injected for tests. */
  now?: () => number
}

/**
 * The copy's identity.
 *
 * Derived from the root, the pinned revision and the creation time rather than
 * random, so a transcript that records one is reproducible from its own fields —
 * the same property `investigatorTurnId` has, and for the same reason: a reader
 * should be able to tell two copies apart without a lookup.
 */
export const workingCopyId = (input: {
  root: string
  baseCommit: string | null
  createdAt: string
}): string =>
  `wcopy_${createHash('sha256')
    .update(`${input.root}:${input.baseCommit ?? '-'}:${input.createdAt}`)
    .digest('hex')
    .slice(0, 20)}`

const isExcludedName = (name: string): boolean =>
  IGNORED_DIRECTORIES.has(name) || name === WINDBREAK_DIRECTORY

/**
 * Materialise the working copy.
 *
 * Synchronous, because `fs.cpSync` is and because a caller that is about to run a
 * turn has nothing to do while it waits. An existing copy at the same path is
 * **removed and re-made**: a copy that has drifted from the target is exactly the
 * substitution §18 exists to prevent, so the tree a turn starts from is always
 * the target as it is now, and any earlier edits are gone. The transcript is what
 * records those, not the copy.
 */
export const createWorkingCopy = (
  options: CreateWorkingCopyOptions,
): WorkingCopy => {
  const targetDir = fs.realpathSync(options.targetDir)
  const scratchDir = path.resolve(options.scratchDir)
  const root = path.join(scratchDir, WORKING_COPY_DIRECTORY)

  // The catastrophic mistakes, refused before any rm: a root that *is* the target
  // or an ancestor of it would delete the evidence out from under the run.
  if (targetDir === root || targetDir.startsWith(root + path.sep)) {
    throw new WorkingCopyError(
      `refusing to make a working copy at ${root}: it contains the target (${targetDir}). ` +
        'The copy must be created somewhere the target does not live.',
    )
  }

  const source = fs.statSync(targetDir)
  if (!source.isDirectory()) {
    throw new WorkingCopyError(
      `the target at ${targetDir} is not a directory, so no working copy can be made.`,
    )
  }

  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  fs.mkdirSync(root, { recursive: true })

  let files = 0
  let bytes = 0
  const excluded = new Set<string>()

  /**
   * Copy one directory, depth first.
   *
   * `entry.isSymbolicLink()` is checked before `entry.isDirectory()` because a dirent
   * for a link to a directory reports `isDirectory() === false` on most platforms and
   * `true` on some — reading order into it is how a `walk` either follows a link out of
   * the checkout or silently flattens it into a file.
   */
  const copyTree = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true })

    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name)
      const destination = path.join(to, entry.name)

      if (entry.isSymbolicLink()) {
        // Recreated as a link, never followed. A link that leaves the checkout still
        // leaves it in the copy, which is the workspace's containment check's business
        // and not a reason to drop the entry.
        fs.symlinkSync(fs.readlinkSync(source), destination)
        continue
      }

      if (entry.isDirectory()) {
        if (isExcludedName(entry.name)) {
          excluded.add(entry.name)
          continue
        }

        // Never descend into a directory that contains the copy's own root. The
        // excluded list normally covers this — the copy lives under `.windbreak` — but
        // a caller that put the copy anywhere else inside the target would otherwise
        // have the walk copy the copy it is writing, forever. A guard rather than an
        // assumption, because the failure is a filled disk rather than an error.
        if (root === source || root.startsWith(source + path.sep)) {
          excluded.add(entry.name)
          continue
        }

        copyTree(source, destination)
        continue
      }

      // Sockets, FIFOs and device nodes are not files a model can read, and opening a
      // FIFO to copy it would block the screen.
      if (!entry.isFile()) continue

      fs.copyFileSync(source, destination)
      // `copyFileSync` copies contents, not permissions. A build script that arrived
      // without its executable bit would fail for a reason nothing on screen explains.
      fs.chmodSync(destination, fs.statSync(source).mode)

      files += 1
      bytes += fs.statSync(source).size
    }
  }

  copyTree(targetDir, root)

  const createdAt = new Date((options.now ?? Date.now)()).toISOString()
  const baseCommit = options.commitSha ?? null

  return {
    id: workingCopyId({ root, baseCommit, createdAt }),
    root,
    targetDir,
    baseCommit,
    strategy: 'filtered-copy',
    files,
    bytes,
    createdAt,
    excluded: [...excluded].sort(),
  }
}

/** A copy read back from a stored row, which may not be one this version knows. */
export type RecordedWorkingCopyStrategy = WorkingCopyStrategy | 'unknown'

export const toRecordedStrategy = (value: string): RecordedWorkingCopyStrategy =>
  value === 'filtered-copy' ? 'filtered-copy' : 'unknown'
