import { describe, expect, test } from 'bun:test'

import {
  dedupeDependencies,
  normalizePyPiName,
  packageNameFromNodeModulesKey,
  parseManifest,
} from './dependencies'

describe('parseManifest', () => {
  test('parses an npm lockfile v2/v3 packages map', () => {
    const content = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/left-pad': { version: '1.3.0' },
        'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
      },
    })

    const result = parseManifest({
      path: 'package-lock.json',
      type: 'npm-lock',
      content,
    })

    expect(result.reason).toBeUndefined()
    expect(result.dependencies.map((d) => `${d.name}@${d.version}`)).toEqual([
      'left-pad@1.3.0',
      '@scope/b@2.0.0',
    ])
    expect(result.dependencies.every((d) => d.ecosystem === 'npm')).toBe(true)
    expect(result.dependencies.every((d) => d.queryable)).toBe(true)
  })

  test('parses a lockfile v1 nested tree', () => {
    const content = JSON.stringify({
      dependencies: {
        a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } },
      },
    })

    const result = parseManifest({
      path: 'package-lock.json',
      type: 'npm-lock',
      content,
    })

    expect(result.dependencies.map((d) => d.name)).toEqual(['a', 'b'])
  })

  test('records an unpinned requirement as unqueryable rather than guessing', () => {
    const result = parseManifest({
      path: 'requirements.txt',
      type: 'pip-requirements',
      content: 'requests>=2.0\nDjango==4.2.1\n# comment\n-r other.txt\n',
    })

    const [requests, django] = result.dependencies
    expect(requests).toMatchObject({
      name: 'requests',
      exact: false,
      queryable: true,
    })
    expect(requests!.version).toBe('2.0')
    expect(django).toMatchObject({ name: 'django', version: '4.2.1', exact: true })
  })

  test('parses go.mod single and block require statements', () => {
    const content = [
      'module example.com/app',
      'go 1.22',
      'require github.com/pkg/errors v0.9.1',
      'require (',
      '\tgithub.com/stretchr/testify v1.8.4 // indirect',
      ')',
    ].join('\n')

    const result = parseManifest({ path: 'go.mod', type: 'go-mod', content })

    expect(result.dependencies.map((d) => `${d.name}@${d.version}`)).toEqual([
      'github.com/pkg/errors@v0.9.1',
      'github.com/stretchr/testify@v1.8.4',
    ])
  })

  test('parses Cargo.lock packages', () => {
    const content = [
      '[[package]]',
      'name = "serde"',
      'version = "1.0.197"',
      '',
      '[[package]]',
      'name = "regex"',
      'version = "1.10.0"',
    ].join('\n')

    const result = parseManifest({ path: 'Cargo.lock', type: 'cargo-lock', content })

    expect(result.dependencies).toHaveLength(2)
    expect(result.dependencies[0]).toMatchObject({
      ecosystem: 'crates.io',
      name: 'serde',
      version: '1.0.197',
      queryable: true,
    })
  })

  test('refuses a range-pinned manifest with a reason instead of a wrong version', () => {
    const result = parseManifest({
      path: 'package.json',
      type: 'npm',
      content: JSON.stringify({ dependencies: { lodash: '^4.17.0' } }),
    })

    expect(result.dependencies).toEqual([])
    expect(result.reason).toContain('exact versions')
  })

  test('reports pkg-config as recorded-but-unqueryable', () => {
    const result = parseManifest({
      path: 'openssl.pc',
      type: 'pkg-config',
      content: 'Name: OpenSSL\nVersion: 3.0.2\n',
    })

    expect(result.dependencies).toEqual([
      {
        ecosystem: 'pkg-config',
        name: 'OpenSSL',
        version: '3.0.2',
        exact: true,
        manifestPath: 'openssl.pc',
        queryable: false,
        reason: expect.stringContaining('not an OSV ecosystem'),
      },
    ])
  })

  test('surfaces invalid JSON as a reason, not a throw', () => {
    const result = parseManifest({
      path: 'composer.lock',
      type: 'composer',
      content: '{ not json',
    })

    expect(result.dependencies).toEqual([])
    expect(result.reason).toBe('not valid JSON')
  })

  test('treats an unlocked Gemfile as a range manifest', () => {
    const result = parseManifest({
      path: 'Gemfile',
      type: 'bundler',
      content: "gem 'rails', '~> 6.1'",
    })

    expect(result.dependencies).toEqual([])
    expect(result.reason).toContain('exact versions')
  })

  test('parses Gemfile.lock spec lines', () => {
    const content = [
      'GEM',
      '  remote: https://rubygems.org/',
      '  specs:',
      '    rails (6.1.0)',
      '      actionpack (= 6.1.0)',
      '',
      'PLATFORMS',
      '  ruby',
    ].join('\n')

    const result = parseManifest({ path: 'Gemfile.lock', type: 'bundler', content })

    expect(result.dependencies).toEqual([
      {
        ecosystem: 'RubyGems',
        name: 'rails',
        version: '6.1.0',
        exact: true,
        manifestPath: 'Gemfile.lock',
        queryable: true,
      },
    ])
  })

  test('flags a Maven property reference as unpinned', () => {
    const result = parseManifest({
      path: 'pom.xml',
      type: 'maven',
      content: [
        '<dependency>',
        '<groupId>org.apache.logging.log4j</groupId>',
        '<artifactId>log4j-core</artifactId>',
        '<version>${log4j.version}</version>',
        '</dependency>',
      ].join('\n'),
    })

    expect(result.dependencies[0]).toMatchObject({
      ecosystem: 'Maven',
      name: 'org.apache.logging.log4j:log4j-core',
      version: 'unpinned',
      exact: false,
      queryable: true,
    })
  })
})

describe('helpers', () => {
  test('normalizes PyPI names the way the index does', () => {
    expect(normalizePyPiName('Flask_SQLAlchemy')).toBe('flask-sqlalchemy')
    expect(normalizePyPiName('  zope.interface ')).toBe('zope-interface')
  })

  test('extracts the package from a nested node_modules key', () => {
    expect(packageNameFromNodeModulesKey('node_modules/a/node_modules/@b/c')).toBe(
      '@b/c',
    )
    expect(packageNameFromNodeModulesKey('node_modules/a')).toBe('a')
  })

  test('dedupes across manifests on ecosystem + name + version', () => {
    const dep = (manifestPath: string, version = '1.0.0') => ({
      ecosystem: 'npm',
      name: 'left-pad',
      version,
      exact: true,
      manifestPath,
      queryable: true,
    })

    const unique = dedupeDependencies([dep('a/package-lock.json'), dep('b/package-lock.json'), dep('c/package-lock.json', '2.0.0')])

    expect(unique).toHaveLength(2)
    expect(unique[0]!.manifestPath).toBe('a/package-lock.json')
  })
})
