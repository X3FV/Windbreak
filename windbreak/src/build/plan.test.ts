import { describe, expect, test } from 'bun:test'

import { detectBuildSystem } from './detect'
import { createBuildPlan } from './plan'

const planFor = (
  entries: string[],
  overrides: Partial<Parameters<typeof createBuildPlan>[0]> = {},
) =>
  createBuildPlan({
    detection: detectBuildSystem(entries),
    checkoutDir: '/work/checkout',
    buildDir: '/work/scratch/build',
    sourceDir: '/work/checkout',
    sourceMode: 'read-only',
    compile: false,
    ...overrides,
  })

describe('createBuildPlan', () => {
  test('CMake configures with compile commands exported and does not compile by default', () => {
    const plan = planFor(['CMakeLists.txt'])

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.command).toContain('-DCMAKE_EXPORT_COMPILE_COMMANDS=ON')
    expect(plan.compileCommandsPath).toBe(
      '/work/scratch/build/cmake/compile_commands.json',
    )
    expect(plan.warnings).toEqual([])
  })

  test('CMake adds a build step only when compiling is requested', () => {
    const plan = planFor(['CMakeLists.txt'], { compile: true, jobs: 8 })

    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[1]?.command).toEqual([
      'cmake',
      '--build',
      '/work/scratch/build/cmake',
      '-j',
      '8',
    ])
  })

  test('Meson sets up out-of-source', () => {
    const plan = planFor(['meson.build'])

    expect(plan.steps[0]?.command).toEqual([
      'meson',
      'setup',
      '/work/scratch/build/meson',
      '/work/checkout',
    ])
  })

  test('autotools warns that without --compile there is no compilation database', () => {
    const plan = planFor(['configure.ac'])

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.command).toEqual(['/work/checkout/configure'])
    expect(plan.warnings.join(' ')).toMatch(/best-effort/)
  })

  test('autotools instruments make with bear when compiling', () => {
    const plan = planFor(['configure'], { compile: true })

    expect(plan.steps.at(-1)?.command).toEqual([
      'bear',
      '--',
      'make',
      '-j',
      '4',
    ])
  })

  test('plain Make runs in the copied source tree, not a separate build dir', () => {
    const plan = planFor(['Makefile'], {
      compile: true,
      sourceDir: '/work/scratch/src',
      sourceMode: 'copy',
    })

    expect(plan.sourceMode).toBe('copy')
    expect(plan.steps[0]?.cwd).toBe('/work/scratch/src')
    expect(plan.compileCommandsPath).toBe(
      '/work/scratch/src/compile_commands.json',
    )
  })

  test('an unknown build system produces a warning and no steps', () => {
    const plan = planFor(['README.md'])

    expect(plan.steps).toEqual([])
    expect(plan.warnings.join(' ')).toMatch(/No recognised build system/)
  })

  test('non-C ecosystems are reported as best-effort rather than silently skipped', () => {
    const plan = planFor(['Cargo.toml'])

    expect(plan.steps).toEqual([])
    expect(plan.warnings.join(' ')).toMatch(/cargo has no supported path/)
  })

  test('carries the caller-chosen source mode through to the plan', () => {
    expect(planFor(['CMakeLists.txt']).sourceMode).toBe('read-only')
    expect(
      planFor(['Makefile'], { sourceDir: '/work/scratch/src', sourceMode: 'copy' })
        .sourceMode,
    ).toBe('copy')
  })
})
