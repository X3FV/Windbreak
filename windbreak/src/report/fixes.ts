/**
 * Minimal-fix suggestions (spec §13.2 "Suggested fix: <minimal change>").
 *
 * These are pattern-based and deliberately blunt. Reporting makes no model call
 * (§13 / §8.1), and §4.6's reasoning applies here too: a confident-sounding
 * suggestion that the reporter cannot actually justify is worse than an honest
 * "review this call site". Every entry below names the class it belongs to, so a
 * researcher can see whether it applies rather than treating it as advice about
 * their specific code.
 */

export interface ClassifyFixInput {
  cwe: string | null
  patternId: string | null
  snippet: string | null
}

/** Keyed by CWE; matched on the numeric prefix so `CWE-120` covers variations. */
const FIX_BY_CWE: Record<string, string> = {
  'CWE-120':
    'Bound the copy to the destination size: use a length-limited copy ' +
    '(`strncpy`/`snprintf`/`memcpy_s`) with an explicit limit derived from ' +
    '`sizeof(dst)`, and always NUL-terminate the result.',
  'CWE-121':
    'Bound the copy to the stack buffer size and NUL-terminate it; if the ' +
    'input can exceed the buffer, reject or truncate it explicitly.',
  'CWE-122':
    'Size the heap allocation from the input length (checked for overflow) ' +
    'before copying, rather than from a fixed constant.',
  'CWE-125':
    'Check the index or offset against the buffer length before reading, and ' +
    'reject out-of-range values at the boundary where they enter.',
  'CWE-787':
    'Check the write offset against the destination capacity before writing.',
  'CWE-190':
    'Perform the arithmetic in a width that cannot overflow, or check the ' +
    'operands before multiplying/adding.',
  'CWE-476':
    'Check the pointer (allocation result or lookup) for NULL before ' +
    'dereferencing it, and handle the failure path.',
  'CWE-416':
    'Restructure the lifetime so the object is not freed before its last use, ' +
    'or take a reference that keeps it alive.',
  'CWE-415':
    'Set the pointer to NULL after freeing it, or centralise ownership so it is ' +
    'freed exactly once.',
  'CWE-134':
    'Pass the string as a format argument (`printf("%s", s)`) instead of using ' +
    'it as the format itself.',
  'CWE-78':
    'Avoid the shell: pass an argument vector (`execve`/`subprocess` list form) ' +
    'rather than building a command string.',
}

const cweKey = (cwe: string | null): string | null => {
  if (!cwe) return null
  const match = /CWE-(\d+)/i.exec(cwe)
  return match ? `CWE-${match[1]}` : null
}

/**
 * Suggest a minimal fix for a candidate's class.
 *
 * Returns a class-specific change when one is known, and otherwise says so
 * explicitly — it does not invent a fix for an unfamiliar pattern.
 */
export const suggestedFixFor = (input: ClassifyFixInput): string => {
  const key = cweKey(input.cwe)
  if (key && FIX_BY_CWE[key]) return FIX_BY_CWE[key]!

  for (const [cwe, fix] of Object.entries(FIX_BY_CWE)) {
    if (input.patternId && input.patternId.toLowerCase().includes(cwe.toLowerCase())) {
      return fix
    }
  }

  const klass = input.cwe ?? input.patternId ?? 'this class'
  return (
    `No pattern-based fix is known for ${klass}. Review the call site and the ` +
    'data that reaches it, and confirm the bounds, lifetime, or locking ' +
    'invariant that the surrounding code assumes.'
  )
}
