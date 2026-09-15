/**
 * Resolving a name to the one definition it names (spec §4.4.3).
 *
 * Two facts about C force a policy here rather than a lookup:
 *
 * 1. A name is not unique. Two translation units may both define
 *    `static void cleanup(int)` — legal C — so a bare-name map would attach one
 *    file's identity to the other file's function.
 * 2. A call site and its definition may sit in different files. A `static` helper
 *    is only visible in its own translation unit, so a same-file match is strong
 *    evidence; a name declared in exactly one file is resolvable even from
 *    elsewhere; and a name declared in several files with no same-file match
 *    cannot be placed without more information than this module has.
 *
 * The policy is therefore: **same-file wins, a single definition resolves, and a
 * genuine ambiguity is dropped rather than guessed at.** Dropping is the
 * precision-holding direction, which is the same direction every other ambiguity in
 * this module takes — see `alias.ts` on why the module resolves toward reporting
 * less.
 *
 * ## Why this is its own module
 *
 * `handlers.ts` had this policy first, for signal registrations. The call graph
 * needs the identical rule for callee names, and a second hand-written copy is a
 * second place to forget: the two would drift the first time one of them learned
 * about `extern`, and the drift would show up as a recall difference between two
 * analyses that both claim to resolve names the same way. So the policy lives here
 * once, and both callers report the *outcome* in their own vocabulary — the
 * messages differ (`registered in` vs `called from`) while the decision does not.
 *
 * What this deliberately does **not** do is resolve by type, namespace, or linkage.
 * A C++ overload set is several definitions of one name, and this resolver sees one
 * entry; a name in a namespace is stored by its qualified text and resolved by it.
 * Both are limits rather than oversights, and each consumer counts what it dropped
 * so the limit is visible rather than silent.
 */

/** Names to the files that define them, as the resolver needs to see the program. */
export interface DefinitionIndex {
  /** Name → the files that define it. A `Set` because one file may define it twice. */
  readonly filesByName: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Index a set of definitions by name.
 *
 * Takes `{ name, filePath }` rather than rows, so the same index serves the
 * program model's `symbols` table and any in-memory candidate list. Duplicate
 * `(name, filePath)` pairs collapse, because a file defining a name twice is still
 * one file that defines it — and counting it twice would turn a resolvable name
 * into a false ambiguity.
 */
export const buildDefinitionIndex = (
  definitions: readonly { name: string; filePath: string }[],
): DefinitionIndex => {
  const filesByName = new Map<string, Set<string>>()

  for (const definition of definitions) {
    const files = filesByName.get(definition.name) ?? new Set<string>()
    files.add(definition.filePath)
    filesByName.set(definition.name, files)
  }

  return { filesByName }
}

/**
 * What a name resolved to.
 *
 * `unresolved` and `ambiguous` are distinct because they are different failures: the
 * first means the program model has no definition at all (a libc function, a macro,
 * a name recon never indexed), and the second means it has several and could not
 * choose. A single "failed" result would make the two indistinguishable in the
 * warning a researcher reads, and only one of them is worth acting on.
 */
export type NameResolution =
  | { kind: 'resolved'; filePath: string }
  | { kind: 'unresolved' }
  | { kind: 'ambiguous'; fileCount: number }

/**
 * Resolve a name, preferring a definition in `preferFile`.
 *
 * `preferFile` is the file the reference was written in — the caller's file for a
 * call site, the registering file for a signal registration. It is a required
 * argument rather than an option because the same-file preference is the whole
 * reason the policy is safe: an optional one would let a caller silently opt out of
 * the only disambiguation available.
 */
export const resolveName = (
  index: DefinitionIndex,
  name: string,
  preferFile: string,
): NameResolution => {
  const files = index.filesByName.get(name)
  if (files === undefined || files.size === 0) return { kind: 'unresolved' }

  // Same-file wins, which is what makes a `static` function resolvable when
  // another translation unit happens to use the same name.
  if (files.has(preferFile)) return { kind: 'resolved', filePath: preferFile }

  if (files.size === 1) return { kind: 'resolved', filePath: [...files][0]! }

  return { kind: 'ambiguous', fileCount: files.size }
}

/**
 * The key a resolved definition is addressed by.
 *
 * File *and* name, because the name alone is the thing this module just refused to
 * trust. `handlers.ts` keeps a compatible key in `types.ts` as `handlerKey`; the
 * two are the same `\u0000`-joined shape on purpose, so a definition key and a
 * handler key can be compared without a translation step.
 */
export const definitionKey = (filePath: string, name: string): string =>
  `${filePath}\u0000${name}`
