/**
 * The investigator's mediated workspace (spec §20.29).
 *
 * An investigator is the one model in this system that is allowed to look at the
 * target — the verdict roles have `toolNames: ['set_output']` and nothing else,
 * and that fence is what makes §5.2's disagreement measure two *independent*
 * answers rather than who read more (§20.29.3). So the design question here is
 * not whether to trust the model. It is what authority the model can reach, and
 * this module is the only place that answers it.
 *
 * Two kinds of access, and they are enforced differently because the honest
 * enforcements are different:
 *
 * - **Reads** are confined in this process: a path is resolved, symlinks and all,
 *   and refused unless it lands inside the target root. The sandbox has nothing
 *   to add for a read on its own — its read-only bind protects a process we are
 *   not running — while the confinement check is a pure function that can be
 *   tested exhaustively, which is what a security boundary needs.
 * - **Execution** always goes through `runInSandbox`, with the target bound
 *   read-only and a scratch `HOME`, exactly as the build step (§20.6) and the
 *   engines stage (§20.9) already do. This is the part that cannot be done
 *   in-process: a command is arbitrary, so its authority has to be the sandbox's
 *   and not ours.
 *
 * Searches are execution, not reading: `rg` is a command, so it runs in the
 * sandbox with the target bound read-only rather than being reimplemented here.
 *
 * ## The third root (§20.30)
 *
 * A workspace may also carry a **working copy** — a writable copy of the target
 * that §20.30's engineer agent edits. It changes nothing about the target's
 * confinement: the target stays the read-only root every read is checked
 * against, and the copy gets its *own* containment check against its *own* root,
 * because the two are different promises. A read that escapes the copy is refused
 * for the copy's reason and a read that escapes the target for the target's, so a
 * refusal never has to be read as "somewhere in your checkout".
 *
 * Writes are host-side `fs`, like reads, and for the same reason: they are
 * path-confined by a check that can be tested exhaustively, and a write needs no
 * outside authority. The sandbox is what a *command* needs, which is why the
 * copy gets its own `runInCopy` with the copy as the working directory.
 */

import fs from 'fs'
import path from 'path'

import { runInSandbox } from '../sandbox/run'

import { applyHunks, contentOfNewFile, parsePatch } from './patch'

import type { WorkingCopy } from './copy'
import type { ParsedPatchFile, PatchAction } from './patch'
import type { DetectOptions } from '../sandbox/backends'
import type {
  BindMount,
  SandboxBackendName,
  SandboxRunResult,
} from '../sandbox/types'

/**
 * The default an investigator run gets, and why each number is not a policy knob
 * a model can talk its way out of (§20.29.6).
 *
 * The wall clock is the one that matters: an interactive command is still
 * `timeLimitSeconds`, and a model in a chat loop can ask for another one, so the
 * ceiling is enforced per command and not per conversation.
 */
export const INVESTIGATOR_LIMITS = {
  /** Per command. A compile of a real target is slower than a grep, so it is not 30s. */
  timeLimitSeconds: 120,
  memoryLimitMiB: 2048,
  cpuLimitSeconds: 120,
} as const

export class OutsideTargetError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(
      `"${requested}" resolves outside the target (${root}); the investigator may ` +
        'only read files that belong to the checkout it was pointed at.',
    )
    this.name = 'OutsideTargetError'
  }
}

/**
 * Resolve a model-supplied path against the target root, refusing anything that
 * lands outside it.
 *
 * The check is on the **real** path, which is the whole point: a symlink inside
 * the checkout pointing at `/etc/shadow` is a path that reads as inside the
 * checkout and is not, and `path.resolve` alone cannot see that. `realpathSync`
 * can, but it fails on a file that does not exist — and a nonexistent path is a
 * normal thing for a model to ask about, so the failure is handled by resolving
 * the deepest existing ancestor instead of by letting the guard throw for the
 * wrong reason.
 *
 * Absolute paths are accepted only if they are inside the root; everything else
 * is joined to the root first. A model that asks for `/etc/passwd` gets a
 * refusal rather than a silently reinterpreted relative path, because quietly
 * turning one into the other would make an escape attempt look like a hit.
 */
export const resolveInTarget = (
  root: string,
  candidate: string,
  realpath: (input: string) => string = fs.realpathSync,
  exists: (input: string) => boolean = fs.existsSync,
): string => {
  const resolvedRoot = realpath(root)
  const joined = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(resolvedRoot, candidate)

  const real = realpathIfExists(joined, realpath, exists)

  const rootWithSep = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : resolvedRoot + path.sep

  if (real !== resolvedRoot && !real.startsWith(rootWithSep)) {
    throw new OutsideTargetError(candidate, resolvedRoot)
  }

  return real
}

/**
 * `realpath` for a path that may not exist.
 *
 * Walks up to the deepest ancestor that does exist, resolves that, and re-attaches
 * the remainder. The remainder is therefore *not* verified against symlinks — a
 * path that does not exist cannot contain one — which is why the result is only
 * ever used for containment and for a read that will fail on its own if the path
 * is not there.
 */
const realpathIfExists = (
  target: string,
  realpath: (input: string) => string,
  exists: (input: string) => boolean,
): string => {
  if (exists(target)) return realpath(target)

  const segments: string[] = []
  let current = target

  while (true) {
    const parent = path.dirname(current)
    if (parent === current) {
      // Reached the root without finding anything that exists, which cannot
      // happen for an absolute path — `/` exists. Returning the input keeps the
      // guard total rather than throwing where the caller cannot act on it.
      return target
    }
    segments.unshift(path.basename(current))
    current = parent
    if (exists(current)) {
      return path.join(realpath(current), ...segments)
    }
  }
}

/**
 * An edit that was refused for a reason the model can act on.
 *
 * A separate class from `OutsideTargetError` because the two refusals mean
 * different things: one says "that path is not yours to touch", the other says "that
 * edit does not fit the file". The tool layer reports both without a stack trace,
 * and a reader can tell which boundary was reached.
 */
export class CopyEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CopyEditError'
  }
}

/** What one write did, for the transcript (§20.30.1). */
export interface CopyWriteResult {
  /** Path relative to the copy root, as the model named it. */
  path: string
  action: PatchAction
  bytes: number
  /** Lines added and removed; zero for a whole-file write. */
  inserted: number
  removed: number
}

export interface InvestigatorWorkspaceOptions {
  /** The checkout the investigator may read, as an absolute path. */
  targetDir: string
  /** Writable scratch, per run. Never the target. */
  scratchDir: string
  /**
   * The writable copy of the target, when one has been materialised (§20.30).
   *
   * Optional and not created here: materialising it is `investigate/copy.ts`'s job
   * and it is deliberately lazy, so a read-only investigator never pays for a copy
   * it will not use.
   */
  copy?: WorkingCopy | null
  /** Pin a sandbox backend instead of using the preference order. */
  preferred?: SandboxBackendName
  detect?: DetectOptions
  timeLimitSeconds?: number
}

export interface InvestigatorWorkspace {
  /** The resolved target root, after `realpath`. */
  readonly root: string
  /**
   * The per-command wall clock this workspace enforces.
   *
   * Exposed so the tool layer can clamp a model's request against it. The ceiling
   * has to live above the tool for §20.29.6's reason — a chat has no natural time
   * limit, so the number cannot be one the model argues its way past — and it is
   * read from here rather than from `INVESTIGATOR_LIMITS` so that a caller which
   * tightened it at construction is the one that gets obeyed.
   */
  readonly timeLimitSeconds: number
  /** Resolve a model-supplied path, or throw `OutsideTargetError`. */
  resolve(candidate: string): string
  /** Confined read. Returns null when the path does not exist. */
  readFile(candidate: string): string | null
  /**
   * Confined directory listing: base names, sorted.
   *
   * `symlink` is reported rather than followed. `Dirent.isDirectory()` is false
   * for a link to a directory, so without this a symlinked source directory would
   * look like a file — and *following* it would list what `readFile` refuses when
   * the link leaves the target. Naming the link is the honest middle: the model
   * learns the entry is a link and finds out what happens when it reads through.
   */
  readdir(candidate: string): Array<{
    name: string
    directory: boolean
    symlink: boolean
  }>
  /** Raw bytes, for the tools that need size before they decide. */
  statFile(candidate: string): { size: number; directory: boolean } | null
  /** Run a command in the sandbox, with the target bound read-only. */
  run(
    command: string[],
    options?: { timeLimitSeconds?: number },
  ): Promise<SandboxRunResult>

  // ---- the working copy (§20.30) ------------------------------------------

  /** The copy this workspace edits, or null when none was materialised. */
  readonly copy: WorkingCopy | null
  /** Resolve a path against the *copy* root, or throw `OutsideTargetError`. */
  resolveInCopy(candidate: string): string
  /** Confined read of the copy. Null when the path does not exist there. */
  readCopyFile(candidate: string): string | null
  /** Confined copy listing, same shape as `readdir`. */
  readdirCopy(candidate: string): Array<{
    name: string
    directory: boolean
    symlink: boolean
  }>
  /** Create or replace a file in the copy. */
  writeCopyFile(candidate: string, content: string): CopyWriteResult
  /**
   * Replace an exact string in a copy file.
   *
   * Refuses a string that is absent, and — unless `replaceAll` — a string that
   * appears more than once. "Replace the first of the three matches" is not an edit
   * a model can reason about, so it is a refusal rather than a guess.
   */
  replaceInCopy(
    candidate: string,
    find: string,
    replacement: string,
    options?: { replaceAll?: boolean },
  ): CopyWriteResult
  /**
   * Apply a unified diff to the copy.
   *
   * All-or-nothing: every file the patch names is read and patched in memory
   * first, and only then is anything written. A half-applied multi-file patch
   * would leave the copy in a state that is neither the original nor the model's
   * intent, and the model's next step would reason about it.
   */
  applyPatchInCopy(patch: string): CopyWriteResult[]
  /**
   * Run a command in the sandbox with the **copy** as the working directory.
   *
   * The target is still bound read-only, so a command can read the evidence; the
   * copy and the scratch are the only writable mounts. This is what makes the
   * research loop possible — build the patched tree, run it, compare.
   */
  runInCopy(
    command: string[],
    options?: { timeLimitSeconds?: number },
  ): Promise<SandboxRunResult>
}

/**
 * Build the workspace the investigator's tools are implemented against.
 *
 * The policy is deliberately the engines stage's shape rather than a new one: the
 * target is a read-only bind, the only writable mount is per-run scratch, the
 * host environment is not inherited, and `HOME` points into the scratch so a tool
 * that wants to write a cache writes it somewhere that cannot reach anything.
 */
export const createInvestigatorWorkspace = async (
  options: InvestigatorWorkspaceOptions,
): Promise<InvestigatorWorkspace> => {
  const root = fs.realpathSync(options.targetDir)
  const scratchDir = path.resolve(options.scratchDir)
  const timeLimitSeconds =
    options.timeLimitSeconds ?? INVESTIGATOR_LIMITS.timeLimitSeconds

  const home = path.join(scratchDir, 'home')
  const tmp = path.join(scratchDir, 'tmp')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })

  // Imported lazily, matching the engines stage: the pure confinement helpers
  // above are then testable without pulling the sandbox policy in.
  const { createSandboxPolicy } = await import('../sandbox/policy')

  const copy = options.copy ?? null
  const copyRoot = copy ? fs.realpathSync(copy.root) : null

  const readOnlyBinds: BindMount[] = [{ source: root, dest: root }]

  // The copy lives under scratch today, so its bind is usually redundant. It is
  // listed anyway rather than assumed: a copy that was pointed somewhere else would
  // otherwise be silently read-only, and a model would discover that as a build
  // failing for no stated reason.
  const writableBinds: BindMount[] = [
    { source: scratchDir, dest: scratchDir },
    ...(copyRoot && !copyRoot.startsWith(scratchDir + path.sep)
      ? [{ source: copyRoot, dest: copyRoot }]
      : []),
  ]

  const sandboxRun = async (
    command: string[],
    cwd: string,
    overrides: { timeLimitSeconds?: number } = {},
  ): Promise<SandboxRunResult> =>
    runInSandbox(
      {
        policy: createSandboxPolicy({
          readOnlyBinds,
          writableBinds,
          workingDirectory: cwd,
          timeLimitSeconds,
          environment: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: home,
            TMPDIR: tmp,
            XDG_CACHE_HOME: path.join(home, '.cache'),
            // Keeps `rg` from writing a config anywhere and from colouring output
            // with escape codes the model would have to read around.
            RIPGREP_CONFIG_PATH: '',
            NO_COLOR: '1',
          },
          hostname: 'windbreak-investigator',
        }),
        command,
        workingDirectory: cwd,
        timeLimitSeconds: overrides.timeLimitSeconds ?? timeLimitSeconds,
      },
      {
        ...(options.preferred ? { preferred: options.preferred } : {}),
        ...(options.detect ? { detect: options.detect } : {}),
      },
    )

  const run = (command: string[], overrides: { timeLimitSeconds?: number } = {}) =>
    sandboxRun(command, root, overrides)

  const runInCopy = async (
    command: string[],
    overrides: { timeLimitSeconds?: number } = {},
  ): Promise<SandboxRunResult> => {
    if (copyRoot === null) {
      throw new CopyEditError(
        'there is no working copy, so there is nothing to run against. A copy is made ' +
          'the first time the engineer runs; ask the engineer first.',
      )
    }
    return sandboxRun(command, copyRoot, overrides)
  }

  const resolve = (candidate: string): string => resolveInTarget(root, candidate)

  /**
   * Resolve against the copy root, and report a refusal as the copy's.
   *
   * The error is rewritten rather than reused because the default wording says
   * "inside the target", which would send a model looking at the evidence for a path
   * it tried to write in the copy. Same boundary, different sentence.
   */
  const resolveInCopy = (candidate: string): string => {
    if (copyRoot === null) {
      throw new CopyEditError(
        'there is no working copy in this run, so no path in it can be resolved.',
      )
    }
    try {
      return resolveInTarget(copyRoot, candidate)
    } catch (error) {
      if (error instanceof OutsideTargetError) {
        throw new CopyEditError(
          `"${candidate}" resolves outside the working copy (${copyRoot}); only files ` +
            'inside the copy may be edited. The target itself is never writable.',
        )
      }
      throw error
    }
  }

  /** Read a copy file, or throw if there is no copy. Null when the path is absent. */
  const readCopyFile = (candidate: string): string | null => {
    const resolved = resolveInCopy(candidate)
    if (!fs.existsSync(resolved)) return null
    if (fs.statSync(resolved).isDirectory()) return null
    return fs.readFileSync(resolved, 'utf8')
  }

  const countOccurrences = (haystack: string, needle: string): number => {
    if (needle.length === 0) return 0
    let count = 0
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      count += 1
      index = haystack.indexOf(needle, index + needle.length)
    }
    return count
  }

  const relative = (resolved: string): string =>
    copyRoot && resolved.startsWith(copyRoot + path.sep)
      ? resolved.slice(copyRoot.length + 1)
      : resolved

  return {
    root,
    timeLimitSeconds,
    copy,
    resolve,
    resolveInCopy,
    runInCopy,

    readFile: (candidate) => {
      const resolved = resolve(candidate)
      if (!fs.existsSync(resolved)) return null
      if (fs.statSync(resolved).isDirectory()) return null
      return fs.readFileSync(resolved, 'utf8')
    },

    readdir: (candidate) => {
      const resolved = resolve(candidate)
      if (!fs.existsSync(resolved)) return []
      if (!fs.statSync(resolved).isDirectory()) return []

      return fs
        .readdirSync(resolved, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    statFile: (candidate) => {
      const resolved = resolve(candidate)
      if (!fs.existsSync(resolved)) return null
      const stat = fs.statSync(resolved)
      return { size: stat.size, directory: stat.isDirectory() }
    },

    readdirCopy: (candidate) => {
      const resolved = resolveInCopy(candidate)
      if (!fs.existsSync(resolved)) return []
      if (!fs.statSync(resolved).isDirectory()) return []

      return fs
        .readdirSync(resolved, { withFileTypes: true })
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    readCopyFile,

    writeCopyFile: (candidate, content) => {
      const resolved = resolveInCopy(candidate)
      const existed = fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()

      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        throw new CopyEditError(`"${candidate}" is a directory, so it cannot be written as a file.`)
      }

      // `realpathIfExists` already resolved the deepest existing ancestor, so this
      // creates *inside* the copy even when several parent directories are new.
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      fs.writeFileSync(resolved, content, 'utf8')

      return {
        path: relative(resolved),
        action: existed ? 'update' : 'create',
        bytes: Buffer.byteLength(content, 'utf8'),
        inserted: 0,
        removed: 0,
      }
    },

    replaceInCopy: (candidate, find, replacement, replaceOptions = {}) => {
      const resolved = resolveInCopy(candidate)
      const original = readCopyFile(candidate)

      if (original === null) {
        throw new CopyEditError(
          `there is no file at "${candidate}" in the working copy, so there is nothing to ` +
            'replace. Use write_copy_file to create it.',
        )
      }

      const found = countOccurrences(original, find)
      if (found === 0) {
        throw new CopyEditError(
          `the text to replace was not found in ${candidate}. Nothing was written; re-read ` +
            'the file and replace against what it actually contains.',
        )
      }

      const replaceAll = replaceOptions.replaceAll === true
      if (found > 1 && !replaceAll) {
        throw new CopyEditError(
          `the text to replace appears ${found} times in ${candidate}, so which one you ` +
            'mean is ambiguous. Include more surrounding context, or pass replaceAll to ' +
            'change every occurrence. Nothing was written.',
        )
      }

      const next = replaceAll
        ? original.split(find).join(replacement)
        : original.replace(find, replacement)

      fs.writeFileSync(resolved, next, 'utf8')

      return {
        path: relative(resolved),
        action: 'update',
        bytes: Buffer.byteLength(next, 'utf8'),
        inserted: 0,
        removed: 0,
      }
    },

    applyPatchInCopy: (patch) => {
      const files = parsePatch(patch)

      // Phase 1: read and compute, writing nothing. A refusal here leaves the copy
      // exactly as it was — see the interface's note on all-or-nothing.
      const planned: Array<{ file: ParsedPatchFile; resolved: string; content: string | null }> =
        []

      for (const file of files) {
        const resolved = resolveInCopy(file.path)

        if (file.action === 'delete') {
          if (!fs.existsSync(resolved)) {
            throw new CopyEditError(
              `the patch deletes ${file.path}, which does not exist in the working copy. ` +
                'Nothing was written.',
            )
          }
          planned.push({ file, resolved, content: null })
          continue
        }

        if (file.action === 'create') {
          if (fs.existsSync(resolved)) {
            throw new CopyEditError(
              `the patch creates ${file.path}, which already exists in the working copy. ` +
                'Use an update hunk instead. Nothing was written.',
            )
          }
          planned.push({ file, resolved, content: contentOfNewFile(file) })
          continue
        }

        const original = readCopyFile(file.path)
        if (original === null) {
          throw new CopyEditError(
            `the patch updates ${file.path}, which does not exist in the working copy. ` +
              'Nothing was written.',
          )
        }

        planned.push({
          file,
          resolved,
          content: applyHunks(original, file.hunks, file.path).content,
        })
      }

      // Phase 2: commit. Nothing above this line touched the disk.
      const results: CopyWriteResult[] = []

      for (const item of planned) {
        if (item.file.action === 'delete') {
          fs.rmSync(item.resolved, { force: true })
          results.push({
            path: relative(item.resolved),
            action: 'delete',
            bytes: 0,
            inserted: 0,
            removed: 0,
          })
          continue
        }

        // Re-checked here, not only in phase 1, because a create must not clobber a
        // file that a *previous* file in the same patch created.
        if (item.file.action === 'create' && fs.existsSync(item.resolved)) {
          throw new CopyEditError(
            `the patch creates ${item.file.path}, which another hunk in the same patch ` +
              'already created. Nothing further was written.',
          )
        }

        fs.mkdirSync(path.dirname(item.resolved), { recursive: true })
        fs.writeFileSync(item.resolved, item.content ?? '', 'utf8')

        const counts = item.file.hunks.reduce(
          (total, hunk) => ({
            inserted: total.inserted + hunk.lines.filter((line) => line.startsWith('+')).length,
            removed: total.removed + hunk.lines.filter((line) => line.startsWith('-')).length,
          }),
          { inserted: 0, removed: 0 },
        )

        results.push({
          path: relative(item.resolved),
          action: item.file.action,
          bytes: Buffer.byteLength(item.content ?? '', 'utf8'),
          ...counts,
        })
      }

      return results
    },

    run,
  }
}

/** The two binaries a search can run on, in preference order. */
export type SearchBinary = 'rg' | 'grep'

/**
 * Pick a search binary that can actually run inside the sandbox.
 *
 * `grep` is the safe default and `rg` is the preference, which is the opposite of
 * the usual order for a reason: `/usr` is a runtime read-only bind (§6.2), so
 * `/usr/bin/grep` is guaranteed to be there, while `rg` is commonly installed via
 * a package manager onto `$PATH` — and `$PATH` for a sandboxed process is not the
 * host's. Found the hard way: the first version of this called `rg`
 * unconditionally, and the sandbox answered `exit 127` with empty stdout, which is
 * what a model reads as "no matches".
 */
export const findSearchBinary = (
  which: (name: string) => string | null = (name) => Bun.which(name),
): SearchBinary | null => {
  if (which('rg')) return 'rg'
  if (which('grep')) return 'grep'
  return null
}

export type SearchOutcome =
  | {
      ok: true
      binary: SearchBinary
      /** `0` matched, `1` did not. `1` is a result, not a failure — §18. */
      exitCode: number
      stdout: string
      stderr: string
    }
  | { ok: false; reason: string }

/**
 * Search the target, in the sandbox.
 *
 * A command rather than a traversal, because search is where a model's arguments
 * multiply — a pattern, a glob, a directory — and running it means the sandbox's
 * read-only bind is what constrains them, instead of every argument being
 * something this module has to get right.
 *
 * The failure that matters is a search binary that is not there. `exit 127` with
 * no output is indistinguishable from "nothing matched" to a reader, and a false
 * negative that looks like a clean result is the exact substitution §18 exists to
 * prevent — so it is reported as a failure with a reason the model can act on.
 */
export const runSearch = async (
  workspace: InvestigatorWorkspace,
  input: { pattern: string; path?: string; glob?: string },
  options: {
    binary?: SearchBinary
    which?: (name: string) => string | null
    /**
     * Which root to search. Defaults to the target, so every existing caller — and
     * §20.29's fence that a search is about the *evidence* — is unchanged.
     */
    root?: 'target' | 'copy'
  } = {},
): Promise<SearchOutcome> => {
  const rootKind = options.root ?? 'target'
  const searchBase = rootKind === 'copy' ? workspace.copy?.root : workspace.root

  if (searchBase === undefined || searchBase === null) {
    return {
      ok: false,
      reason: 'there is no working copy, so there is nothing to search in it.',
    }
  }

  const runCommand = (argv: string[]) =>
    rootKind === 'copy' ? workspace.runInCopy(argv) : workspace.run(argv)
  const binary = options.binary ?? findSearchBinary(options.which)
  if (!binary) {
    return {
      ok: false,
      reason:
        'no search binary is available: neither `rg` nor `grep` is on the PATH ' +
        'this sandbox runs with. Searching is not possible in this environment; ' +
        'reading files directly still is.',
    }
  }

  const searchRoot = input.path
    ? rootKind === 'copy'
      ? workspace.resolveInCopy(input.path)
      : workspace.resolve(input.path)
    : searchBase

  const argv =
    binary === 'rg'
      ? [
          'rg',
          '--line-number',
          '--no-heading',
          '--color=never',
          '--max-count',
          '200',
          ...(input.glob ? ['--glob', input.glob] : []),
          '--',
          input.pattern,
          searchRoot,
        ]
      : [
          'grep',
          // `-E`, because the tool description promises an *extended* regular
          // expression and GNU grep reads a basic one by default — where `(` is
          // literal and `\(` is a group. Found by a test whose pattern was
          // `strcpy\(`: under `rg` it matches a literal paren, and under plain
          // `grep` it is an unterminated group that matches nothing. The same
          // pattern has to mean the same thing on both binaries, or a model's
          // result depends on which one happens to be installed.
          '--extended-regexp',
          '--recursive',
          '--line-number',
          // A binary file match is noise a model cannot use, and `grep`'s default
          // for one is a line that says so.
          '--binary-files=without-match',
          '--max-count',
          '200',
          ...(input.glob ? ['--include', input.glob] : []),
          '--',
          input.pattern,
          searchRoot,
        ]

  const result = await runCommand(argv)

  const missing = result.exitCode === 127 || result.exitCode === 126
  if (missing) {
    return {
      ok: false,
      reason:
        `the sandbox could not run \`${binary}\` (exit ${result.exitCode})` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : '.') +
        ' This is a missing binary, not an empty result.',
    }
  }

  return {
    ok: true,
    binary,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
