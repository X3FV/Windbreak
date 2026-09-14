import { describe, expect, test } from 'bun:test'

import { classifyManifest, findManifests } from './deps'

describe('classifyManifest', () => {
  test('classifies ecosystem manifests', () => {
    expect(classifyManifest('package.json')).toEqual({
      type: 'npm',
      path: 'package.json',
      ecosystem: 'npm',
    })
    expect(classifyManifest('Cargo.toml')?.ecosystem).toBe('crates.io')
    expect(classifyManifest('go.mod')?.ecosystem).toBe('Go')
    expect(classifyManifest('requirements.txt')?.ecosystem).toBe('PyPI')
  })

  test('classifies C/C++ system linkage files', () => {
    expect(classifyManifest('libssl.pc')?.ecosystem).toBe('pkg-config')
    expect(classifyManifest('vcpkg.json')?.ecosystem).toBe('vcpkg')
    expect(classifyManifest('conanfile.txt')?.ecosystem).toBe('Conan')
  })

  test('leaves build files that are not dependency manifests alone', () => {
    expect(classifyManifest('CMakeLists.txt')).toBeNull()
    expect(classifyManifest('Makefile')).toBeNull()
    expect(classifyManifest('main.c')).toBeNull()
  })
})

describe('findManifests', () => {
  test('finds manifests at any depth and keeps the full path', () => {
    const manifests = findManifests([
      { path: 'package.json' },
      { path: 'sub/app/package.json' },
      { path: 'src/main.c' },
    ])

    expect(manifests).toHaveLength(2)
    expect(manifests.map((entry) => entry.path)).toEqual([
      'package.json',
      'sub/app/package.json',
    ])
  })

  test('sorts by path so a target yields a stable manifest list', () => {
    const manifests = findManifests([
      { path: 'z/Cargo.toml' },
      { path: 'a/go.mod' },
      { path: 'm/requirements.txt' },
    ])

    expect(manifests.map((entry) => entry.path)).toEqual([
      'a/go.mod',
      'm/requirements.txt',
      'z/Cargo.toml',
    ])
  })

  test('matches on the file name, not the directories above it', () => {
    const manifests = findManifests([
      { path: 'package.json/readme.c' },
      { path: 'vendor/package.json' },
    ])

    expect(manifests).toEqual([
      { type: 'npm', path: 'vendor/package.json', ecosystem: 'npm' },
    ])
  })

  test('returns nothing for a target with no manifests', () => {
    expect(findManifests([{ path: 'main.c' }])).toEqual([])
  })
})
