import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { collectInventory, IGNORED_DIRECTORIES } from './inventory'

let root: string

const write = (relativePath: string, contents: string | Buffer): void => {
  const absolutePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, contents)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'windbreak-inv-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('collectInventory', () => {
  test('walks nested directories and records relative paths', () => {
    write('src/main.c', 'int main(void){return 0;}')
    write('src/util/helper.h', '#pragma once')
    write('README.md', '# hi')

    const inventory = collectInventory(root)
    const paths = inventory.files.map((file) => file.path).sort()

    expect(paths).toEqual(['README.md', 'src/main.c', 'src/util/helper.h'])
  })

  test('records size, language, and total bytes', () => {
    write('src/main.c', 'abcde')

    const inventory = collectInventory(root)
    const file = inventory.files.find((entry) => entry.path === 'src/main.c')

    expect(file?.bytes).toBe(5)
    expect(file?.language).toBe('c')
    expect(inventory.totalBytes).toBe(5)
  })

  test('skips ignored directories without descending into them', () => {
    write('src/main.c', 'x')
    write('node_modules/pkg/index.js', 'x')
    write('.git/HEAD', 'ref: refs/heads/main')

    const inventory = collectInventory(root)

    expect(inventory.files.map((file) => file.path)).toEqual(['src/main.c'])
    expect(inventory.ignoredDirectories).toBe(2)
    expect(IGNORED_DIRECTORIES.has('node_modules')).toBe(true)
  })

  test('does not ignore vendor directories, which are real targets', () => {
    write('vendor/lib/thing.c', 'x')
    write('third_party/other.c', 'x')

    const paths = collectInventory(root).files.map((file) => file.path).sort()

    expect(paths).toEqual(['third_party/other.c', 'vendor/lib/thing.c'])
  })

  test('marks binary files and strips their language', () => {
    // Not under `build/`, which the walk skips as a build-output directory.
    write('artifacts/out.o', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    write('src/main.c', 'int main(void){return 0;}')

    const inventory = collectInventory(root)
    const binary = inventory.files.filter((file) => file.binary)

    expect(binary).toHaveLength(2)
    expect(binary.every((file) => file.language === null)).toBe(true)
    expect(inventory.binaryFiles).toBe(2)
  })

  test('detects a binary by NUL bytes even with a text extension', () => {
    write('tables.c', Buffer.from([0x61, 0x00, 0x62]))

    const inventory = collectInventory(root)
    const file = inventory.files.find((entry) => entry.path === 'tables.c')

    expect(file?.binary).toBe(true)
  })

  test('truncates at the file cap and says so', () => {
    for (let index = 0; index < 12; index += 1) {
      write(`src/file${index}.c`, 'x')
    }

    const inventory = collectInventory(root, { maxFiles: 5 })

    expect(inventory.files).toHaveLength(5)
    expect(inventory.truncated).toBe(true)
    expect(inventory.warnings.join(' ')).toMatch(/cap/)
  })

  test('stops descending past the depth cap', () => {
    write('a/b/c/d/e/deep.c', 'x')
    write('shallow.c', 'x')

    const inventory = collectInventory(root, { maxDepth: 2 })

    expect(inventory.files.map((file) => file.path)).toEqual(['shallow.c'])
  })

  test('an empty directory yields an empty inventory rather than throwing', () => {
    const inventory = collectInventory(root)

    expect(inventory.files).toEqual([])
    expect(inventory.truncated).toBe(false)
  })
})
