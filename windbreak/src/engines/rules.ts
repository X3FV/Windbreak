import fs from 'fs'
import path from 'path'

/**
 * Locate the committed rule set.
 *
 * Rules ship with WindBreak rather than being fetched, because the sandbox has
 * no route (§6.3) and a scan must be reproducible from the repository alone.
 * They are bound read-only into the sandbox at the same absolute path.
 */
export const DEFAULT_RULES_DIR = path.resolve(import.meta.dir, '../../rules')

export const COMMITTED_RULE_FILES = ['security.yaml'] as const

export const defaultRulePaths = (
  rulesDir: string = DEFAULT_RULES_DIR,
): string[] =>
  COMMITTED_RULE_FILES.map((file) => path.join(rulesDir, file)).filter((file) =>
    fs.existsSync(file),
  )

/** Resolve config-supplied rule paths, refusing ones that do not exist. */
export const resolveRulePaths = (
  configured: readonly string[],
  rulesDir?: string,
): string[] => {
  const paths = [...defaultRulePaths(rulesDir)]

  for (const entry of configured) {
    const resolved = path.resolve(entry)
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configured rule path does not exist: ${resolved}`)
    }
    paths.push(resolved)
  }

  return paths
}
