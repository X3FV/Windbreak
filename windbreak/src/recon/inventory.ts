import fs from 'fs'
import path from 'path'

import { detectLanguage } from './languages'

/**
 * Directories never worth walking.
 *
 * Deliberately does **not** include `vendor/`, `third_party/`, or `extern/`:
 * spec D9 needs vendor-customised forks to be first-class targets, and those
 * directories are frequently where the interesting code is. Cost is handled by
 * the file cap instead.
 */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.cache',
  '.gradle',
])

export const BINARY_EXTENSIONS = new Set([
  '.o',
  '.a',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.obj',
  '.class',
  '.jar',
  '.pyc',
  '.wasm',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.bz2',
  '.xz',
  '.zst',
  '.tar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.wav',
  '.ogg',
  '.sqlite',
  '.db',
  '.pack',
  '.idx',
])

export const DEFAULT_MAX_FILES = 50_000
export const DEFAULT_MAX_DEPTH = 40
const SNIFF_BYTES = 1024

export interface FileEntry {
  /** Path relative to the inventory root, using forward slashes. */
  path: string
  absolutePath: string
  bytes: number
  language: string | null
  binary: boolean
}

export interface Inventory {
  root: string
  files: FileEntry[]
  totalBytes: number
  ignoredDirectories: number
  binaryFiles: number
  /** True when the walk stopped early at `maxFiles`. */
  truncated: boolean
  warnings: string[]
}

export interface CollectInventoryOptions {
  maxFiles?: number
  maxDepth?: number
  ignoreDirectories?: Set<string>
  /** Injected for tests. */
  readdir?: (dir: string) => fs.Dirent[]
  isBinaryFile?: (absolutePath: string, extension: string) => boolean
}

/**
 * A NUL byte in the first kilobyte is the standard heuristic for "not text".
 * Only applied to extensions we do not already recognise, so the common case
 * costs no extra read.
 */
export const looksBinary = (absolutePath: string): boolean => {
  let fd: number | null = null
  try {
    fd = fs.openSync(absolutePath, 'r')
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const read = fs.readSync(fd, buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, read).includes(0)
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing useful to do; the inventory result is unaffected.
      }
    }
  }
}

/**
 * Walk a checkout into a bounded, classified file list.
 *
 * Symlinked directories are not followed: a symlink loop would otherwise hang
 * the walk, and a symlink out of the checkout is not part of the target.
 */
export const collectInventory = (
  root: string,
  options: CollectInventoryOptions = {},
): Inventory => {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const ignoreDirectories = options.ignoreDirectories ?? IGNORED_DIRECTORIES
  const readdir =
    options.readdir ??
    ((dir: string) => fs.readdirSync(dir, { withFileTypes: true }))
  const isBinaryFile =
    options.isBinaryFile ??
    ((absolutePath: string, extension: string) =>
      BINARY_EXTENSIONS.has(extension) || looksBinary(absolutePath))

  const files: FileEntry[] = []
  const warnings: string[] = []
  let totalBytes = 0
  let ignoredDirectories_ = 0
  let binaryFiles = 0
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return

    let entries: fs.Dirent[]
    try {
      entries = readdir(dir)
    } catch {
      warnings.push(`Could not read directory: ${dir}`)
      return
    }

    for (const entry of entries) {
      if (truncated) return

      const absolutePath = path.join(dir, entry.name)

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (ignoreDirectories.has(entry.name)) {
          ignoredDirectories_ += 1
          continue
        }
        walk(absolutePath, depth + 1)
        continue
      }

      if (!entry.isFile()) continue

      if (files.length >= maxFiles) {
        truncated = true
        warnings.push(
          `Inventory stopped at the ${maxFiles}-file cap; results are partial.`,
        )
        return
      }

      let size = 0
      try {
        size = fs.statSync(absolutePath).size
      } catch {
        warnings.push(`Could not stat file: ${absolutePath}`)
        continue
      }

      const language = detectLanguage(entry.name)
      const binary = isBinaryFile(absolutePath, path.extname(entry.name).toLowerCase())
      if (binary) binaryFiles += 1

      files.push({
        path: path.relative(root, absolutePath).split(path.sep).join('/'),
        absolutePath,
        bytes: size,
        language: binary ? null : language,
        binary,
      })
      totalBytes += size
    }
  }

  walk(root, 0)

  return {
    root,
    files,
    totalBytes,
    ignoredDirectories: ignoredDirectories_,
    binaryFiles,
    truncated,
    warnings,
  }
}
