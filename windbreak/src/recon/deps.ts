/**
 * Dependency manifest discovery (spec §4.2).
 *
 * Recon only *locates* manifests; it does not parse or query them. The OSV
 * correlation stage consumes this list, and OSV keys off ecosystem + package +
 * version, so the ecosystem is recorded here.
 */

export interface ManifestRef {
  type: string
  /** Path relative to the target root. */
  path: string
  ecosystem: string
}

interface ManifestRule {
  match: (fileName: string) => boolean
  type: string
  ecosystem: string
}

const RULES: ManifestRule[] = [
  { match: (f) => f === 'package.json', type: 'npm', ecosystem: 'npm' },
  { match: (f) => f === 'package-lock.json', type: 'npm-lock', ecosystem: 'npm' },
  { match: (f) => f === 'npm-shrinkwrap.json', type: 'npm-lock', ecosystem: 'npm' },
  { match: (f) => f === 'yarn.lock', type: 'yarn-lock', ecosystem: 'npm' },
  { match: (f) => f === 'pnpm-lock.yaml', type: 'pnpm-lock', ecosystem: 'npm' },
  {
    match: (f) => f === 'requirements.txt' || f.startsWith('requirements-'),
    type: 'pip-requirements',
    ecosystem: 'PyPI',
  },
  { match: (f) => f === 'pyproject.toml', type: 'pyproject', ecosystem: 'PyPI' },
  { match: (f) => f === 'Pipfile' || f === 'Pipfile.lock', type: 'pipfile', ecosystem: 'PyPI' },
  { match: (f) => f === 'setup.py' || f === 'setup.cfg', type: 'setuptools', ecosystem: 'PyPI' },
  { match: (f) => f === 'Cargo.toml', type: 'cargo', ecosystem: 'crates.io' },
  { match: (f) => f === 'Cargo.lock', type: 'cargo-lock', ecosystem: 'crates.io' },
  { match: (f) => f === 'go.mod', type: 'go-mod', ecosystem: 'Go' },
  { match: (f) => f === 'go.sum', type: 'go-sum', ecosystem: 'Go' },
  { match: (f) => f === 'Gemfile' || f === 'Gemfile.lock', type: 'bundler', ecosystem: 'RubyGems' },
  { match: (f) => f.endsWith('.gemspec'), type: 'gemspec', ecosystem: 'RubyGems' },
  { match: (f) => f === 'composer.json' || f === 'composer.lock', type: 'composer', ecosystem: 'Packagist' },
  { match: (f) => f === 'pom.xml', type: 'maven', ecosystem: 'Maven' },
  { match: (f) => f === 'build.gradle' || f === 'build.gradle.kts', type: 'gradle', ecosystem: 'Maven' },
  // System-library linkage for C/C++ projects.
  { match: (f) => f.endsWith('.pc'), type: 'pkg-config', ecosystem: 'pkg-config' },
  { match: (f) => f === 'vcpkg.json', type: 'vcpkg', ecosystem: 'vcpkg' },
  { match: (f) => f === 'conanfile.txt' || f === 'conanfile.py', type: 'conan', ecosystem: 'Conan' },
]

export interface ManifestCandidate {
  path: string
}

export const classifyManifest = (fileName: string): ManifestRef | null => {
  for (const rule of RULES) {
    if (rule.match(fileName)) {
      return { type: rule.type, path: fileName, ecosystem: rule.ecosystem }
    }
  }
  return null
}

/**
 * Find manifests across an inventory.
 *
 * Results are sorted by path so a target's manifest list is stable between
 * runs — which matters because a run's config and metrics are compared across
 * invocations (§11.3).
 */
export const findManifests = (
  files: readonly ManifestCandidate[],
): ManifestRef[] => {
  const manifests: ManifestRef[] = []

  for (const file of files) {
    const fileName = file.path.slice(file.path.lastIndexOf('/') + 1)
    const classified = classifyManifest(fileName)
    if (classified) {
      manifests.push({ ...classified, path: file.path })
    }
  }

  return manifests.sort((a, b) => a.path.localeCompare(b.path))
}
