import { describe, expect, test } from 'bun:test'

import { detectBuildSystem } from './detect'

describe('detectBuildSystem', () => {
  test('detects CMake and knows it emits a compilation database from configure alone', () => {
    const detection = detectBuildSystem(['CMakeLists.txt', 'src', 'README.md'])

    expect(detection.system).toBe('cmake')
    expect(detection.evidence).toEqual(['CMakeLists.txt'])
    expect(detection.compileCommands).toBe('native')
    expect(detection.obtainableWithoutCompiling).toBe(true)
    expect(detection.writesInSource).toBe(false)
  })

  test('detects Meson the same way', () => {
    const detection = detectBuildSystem(['meson.build', 'src'])

    expect(detection.system).toBe('meson')
    expect(detection.obtainableWithoutCompiling).toBe(true)
  })

  test('detects autotools, which needs a real instrumented build', () => {
    const detection = detectBuildSystem(['configure.ac', 'Makefile.am', 'src'])

    expect(detection.system).toBe('autotools')
    expect(detection.compileCommands).toBe('bear')
    expect(detection.obtainableWithoutCompiling).toBe(false)
  })

  test('treats plain Make as writing into the source tree', () => {
    const detection = detectBuildSystem(['Makefile', 'main.c'])

    expect(detection.system).toBe('make')
    expect(detection.writesInSource).toBe(true)
    expect(detection.obtainableWithoutCompiling).toBe(false)
  })

  test('prefers the most specific marker: CMake over a trailing Makefile', () => {
    const detection = detectBuildSystem(['CMakeLists.txt', 'Makefile'])

    expect(detection.system).toBe('cmake')
  })

  test('prefers autotools over a generated Makefile.in', () => {
    const detection = detectBuildSystem(['configure', 'Makefile'])

    expect(detection.system).toBe('autotools')
  })

  test('ignores a generated configure when nothing else marks autotools', () => {
    const detection = detectBuildSystem(['configure'])

    expect(detection.system).toBe('autotools')
  })

  test('detects the non-C ecosystems so they can be marked best-effort', () => {
    expect(detectBuildSystem(['Cargo.toml']).ecosystem).toBe('rust')
    expect(detectBuildSystem(['package.json']).ecosystem).toBe('node')
    expect(detectBuildSystem(['MODULE.bazel']).system).toBe('bazel')
  })

  test('reports unknown with no evidence when nothing matches', () => {
    const detection = detectBuildSystem(['README.md', 'src'])

    expect(detection.system).toBe('unknown')
    expect(detection.evidence).toEqual([])
    expect(detection.compileCommands).toBe('none')
    expect(detection.writesInSource).toBe(false)
  })

  test('is case sensitive about markers', () => {
    expect(detectBuildSystem(['cmakelists.txt']).system).toBe('unknown')
  })
})
