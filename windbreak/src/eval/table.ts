/**
 * Shared formatting for §11's text reports.
 *
 * Every eval report has the same two obligations: a figure that was never
 * measured must print as `—` rather than `0` (§18, and the reason `StageMetrics`
 * carries nulls at all), and the tables have to line up so two reports can be
 * compared by eye. One implementation of both, because a second renderer that
 * spelled a missing rate `0.000` would be invisible until someone compared the
 * two reports and believed the wrong one.
 */

export const NIL = '—'

export const rate = (value: number | null, digits = 3): string =>
  value === null ? NIL : value.toFixed(digits)

export const count = (value: number | null): string => (value === null ? NIL : String(value))

/** A left-aligned first column and right-aligned figures, with a header rule. */
export const table = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const line = (values: readonly string[]): string =>
    values
      .map((value, index) =>
        index === 0 ? value.padEnd(widths[index]!) : value.padStart(widths[index]!),
      )
      .join('  ')
      .trimEnd()

  return [line(headers), line(widths.map((width) => '─'.repeat(width))), ...rows.map(line)].join(
    '\n',
  )
}
