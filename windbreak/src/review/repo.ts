/**
 * Which repository is on screen, and its files when nothing has been scanned
 * (spec §20.31).
 *
 * The screen's answer to "what am I looking at" used to come from one place: the
 * state database. `codebase()` read the target of the run that owned the selected
 * candidate, and a checkout nobody had scanned had no target, no listing, and no
 * root the models could read. §20.31 makes the *directory* an answer of its own,
 * which is the whole of this module:
 *
 * - `resolveRepoRoot` answers "which repository is this", walking up to the git
 *   root so the answer does not depend on which subdirectory the researcher
 *   happened to be in.
 * - `readRepoCodebase` turns that root into rows the pane can draw, *labelled as
 *   a filesystem listing* rather than as recon's inventory.
 *
 * ## Why the label is not decoration
 *
 * §20.30 chose the inventory over a directory walk on purpose: a walk lists files
 * no stage ever parsed, so a pane built from one promises coverage that does not
 * exist — and the point of showing the codebase beside a finding is that the two
 * are about the same set of files. That reason still holds, and it is not
 * answered by walking anyway; it is answered by saying which of the two claims
 * the pane is making. An inventory and a walk are different facts, and the third
 * state this module introduces is named on screen rather than folded into the
 * other two — which is §18's rule applied to a file list.
 *
 * ## The walk itself is recon's
 *
 * `collectInventory` is reused rather than reimplemented, which is what keeps the
 * ignore list, the binary sniffing, the depth bound and the file cap *the same
 * rules* in both sources. A second walker would be a second answer to "what is a
 * source file", and the two would drift.
 */

import fs from 'fs'
import path from 'path'

import { collectInventory, DEFAULT_MAX_FILES } from '../recon/inventory'

import type { ReviewFilesystemCodebase } from './types'

/**
 * The directory that is the repository, from wherever the caller is standing.
 *
 * The git root, because that is what "the repository at this path" means to
 * everyone who says it: running the screen from `src/` must not make the codebase
 * pane list only `src/`. `.git` is checked as a *file* as well as a directory
 * because that is what a worktree and a submodule have — the marker is the
 * presence of the path, not its type.
 *
 * No `.git` anywhere above means the starting directory is the answer, which is
 * the right one for a vendored tarball or an exported source tree: §20.21 already
 * records that both history miners degrade to nothing on exactly those targets,
 * and treating "no repository" as "no codebase" would be the same mistake in the
 * pane.
 */
export const resolveRepoRoot = (
  dir: string,
  deps: {
    exists?: (candidate: string) => boolean
    realpath?: (candidate: string) => string
  } = {},
): string => {
  const exists = deps.exists ?? fs.existsSync
  const realpath = deps.realpath ?? fs.realpathSync

  const start = path.resolve(dir)
  let current = start

  while (true) {
    if (exists(path.join(current, '.git'))) return resolvedOr(current, realpath)

    const parent = path.dirname(current)
    // `dirname /` is `/`; that is the stop condition. The answer is the starting
    // directory and **not** `/`: a vendored tree under `~/projects/thing` has no `.git`
    // anywhere above it, and walking all the way up would list the entire filesystem
    // in a pane that was pointed at one checkout.
    if (parent === current) return resolvedOr(start, realpath)
    current = parent
  }
}

/**
 * `realpath`, for a directory that may not exist.
 *
 * The screen is opened with a working directory that exists, but a caller can
 * point it anywhere, and a resolution that threw would turn "that path is not
 * there" into a crash before the queue is drawn. Returning the input keeps this
 * total; the walk that follows reports a directory it cannot read as a warning.
 */
const resolvedOr = (candidate: string, realpath: (input: string) => string): string => {
  try {
    return realpath(candidate)
  } catch {
    return candidate
  }
}

/** Rows the fallback walk will gather before it stops. `collectInventory`'s cap. */
export const REPO_WALK_MAX_FILES = DEFAULT_MAX_FILES

/**
 * The repository as a file listing, for a checkout nothing has scanned.
 *
 * Synchronous and bounded, with the same cap recon's own inventory uses, so the
 * two sources cannot disagree about how much of a repository is "all of it".
 * `truncated` is reported rather than dropped: a partial listing that reads as a
 * complete one is the failure the pane's 500-row cap already guards against one
 * level down.
 */
export const readRepoCodebase = (
  root: string,
  options: { maxFiles?: number } = {},
): ReviewFilesystemCodebase => {
  const inventory = collectInventory(root, {
    maxFiles: options.maxFiles ?? REPO_WALK_MAX_FILES,
  })

  return {
    source: 'filesystem',
    location: inventory.root,
    // Nothing was pinned, so there is nothing to name. Null is the honest value:
    // a guessed revision would make a finding look reproducible against a commit
    // no stage recorded.
    commitSha: null,
    truncated: inventory.truncated,
    files: inventory.files.map((file) => ({
      path: file.path,
      language: file.language,
      bytes: file.bytes,
      binary: file.binary,
    })),
  }
}
