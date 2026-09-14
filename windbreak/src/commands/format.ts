/** Quote an argv the way a shell would need it, for human-readable output. */
export const formatArgv = (argv: readonly string[]): string =>
  argv
    .map((arg) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`,
    )
    .join(' ')

/** Parse a `--backend` value, rejecting anything that is not a known backend. */
export const parseBackendName = (
  value: string | undefined,
): 'nsjail' | 'bwrap' | undefined => {
  if (value === undefined) return undefined
  if (value === 'nsjail' || value === 'bwrap') return value
  throw new Error(`Unknown sandbox backend "${value}". Expected "nsjail" or "bwrap".`)
}
