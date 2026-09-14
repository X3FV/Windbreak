import { describe, expect, test } from 'bun:test'

import { applyHunks, contentOfNewFile, parsePatch, PatchError } from './patch'

/**
 * The applier's job is to be *strict*: a patch that does not fit is refused, never
 * nudged into place. That is the opposite of the SDK's built-in editor, which fuzzes
 * over three sources and three levels, and the tests below are mostly about the
 * refusals — because a hunk that silently lands somewhere else changes which code the
 * model then reasons about, and it does so without an error.
 */

const update = (path: string, body: string): string =>
  [`--- a/${path}`, `+++ b/${path}`, body].join('\n')

describe('parsePatch', () => {
  test('reads a unified diff into a file and its hunks', () => {
    const files = parsePatch(
      update('src/parse.c', '@@ -2,3 +2,3 @@\n int f(void) {\n-  strcpy(a, b);\n+  strncpy(a, b, 8);\n }'),
    )

    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('src/parse.c')
    expect(files[0]?.action).toBe('update')
    expect(files[0]?.hunks).toHaveLength(1)
    expect(files[0]?.hunks[0]?.oldStart).toBe(2)
    expect(files[0]?.hunks[0]?.newCount).toBe(3)
  })

  test('a /dev/null pre-image is a creation and a /dev/null post-image a deletion', () => {
    const created = parsePatch(
      ['--- /dev/null', '+++ b/poc/trigger.c', '@@ -0,0 +1,2 @@', '+#include <string.h>', '+int main(void) { return 0; }'].join('\n'),
    )
    expect(created[0]?.action).toBe('create')
    expect(created[0]?.path).toBe('poc/trigger.c')

    const deleted = parsePatch(['--- a/src/old.c', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-gone'].join('\n'))
    expect(deleted[0]?.action).toBe('delete')
    // The path has to come from the pre-image here: the post-image is `/dev/null`.
    expect(deleted[0]?.path).toBe('src/old.c')
  })

  test('a multi-file patch is one section per file, in order', () => {
    const files = parsePatch(
      [
        update('a.c', '@@ -1 +1 @@\n-old\n+new'),
        update('b.c', '@@ -1 +1 @@\n-x\n+y'),
      ].join('\n'),
    )
    expect(files.map((file) => file.path)).toEqual(['a.c', 'b.c'])
  })

  test('the git headers are ignored, and a quoted path is unquoted', () => {
    const files = parsePatch(
      [
        'diff --git a/src/a file.c b/src/a file.c',
        'index 111..222 100644',
        '--- "a/src/a file.c"',
        '+++ "b/src/a file.c"',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n'),
    )
    expect(files[0]?.path).toBe('src/a file.c')
  })

  test("the built-in tool's envelope is accepted too", () => {
    // A model that has used freebuff's own `apply_patch` many times reaches for this
    // shape. Refusing it would cost turns for a difference in punctuation.
    const files = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/parse.c',
        '@@',
        ' int f(void) {',
        '-  strcpy(a, b);',
        '+  strncpy(a, b, 8);',
        ' }',
        '*** End Patch',
      ].join('\n'),
    )

    expect(files[0]?.path).toBe('src/parse.c')
    expect(files[0]?.action).toBe('update')
    // A bare `@@` leaves the numbers unset; that is what makes the hunk *located*.
    expect(files[0]?.hunks[0]?.oldStart).toBeNull()
  })

  test('an added file in the envelope is create, and carries its body', () => {
    const files = parsePatch(
      ['*** Begin Patch', '*** Add File: poc/trigger.c', '+int main(void) { return 0; }', '*** End Patch'].join('\n'),
    )
    expect(files[0]?.action).toBe('create')
    expect(contentOfNewFile(files[0]!)).toBe('int main(void) { return 0; }\n')
  })

  test('an empty patch is refused rather than applied as nothing', () => {
    expect(() => parsePatch('')).toThrow(PatchError)
    expect(() => parsePatch('   \n\n')).toThrow(PatchError)
  })

  test('a hunk before any file header is refused', () => {
    expect(() => parsePatch('@@ -1 +1 @@\n-a\n+b')).toThrow(PatchError)
  })

  test('an update with body lines before any @@ is refused', () => {
    // Silently treating these as additions would apply a patch the model did not write.
    expect(() =>
      parsePatch(update('a.c', '-old\n+new')),
    ).toThrow(PatchError)
  })

  test('a line that is neither a header nor a body line is refused', () => {
    expect(() => parsePatch(update('a.c', '@@ -1 +1 @@\n?what\n+new'))).toThrow(PatchError)
  })
})

describe('applyHunks', () => {
  const hunkOf = (body: string) => parsePatch(update('f.txt', body))[0]!.hunks

  test('an exact hunk is applied at the line it names', () => {
    const original = 'one\ntwo\nthree\n'
    const { content } = applyHunks(original, hunkOf('@@ -2,1 +2,1 @@\n-two\n+TWO'), 'f.txt')
    expect(content).toBe('one\nTWO\nthree\n')
  })

  test('the line number is a hint: a hunk is found by its context when the header drifts', () => {
    // A model commonly counts from a stale read. Searching for the exact block is not
    // fuzz — the block still has to match byte for byte — it is using the context the
    // hunk carries.
    const original = 'one\ntwo\nthree\n'
    const { content } = applyHunks(original, hunkOf('@@ -9,1 +9,1 @@\n-two\n+TWO'), 'f.txt')
    expect(content).toBe('one\nTWO\nthree\n')
  })

  test('a bare @@ is located by its context block', () => {
    const original = 'alpha\nbeta\ngamma\n'
    const hunks = parsePatch(
      ['*** Begin Patch', '*** Update File: f.txt', '@@', ' beta', '-gamma', '+delta', '*** End Patch'].join('\n'),
    )[0]!.hunks

    expect(applyHunks(original, hunks, 'f.txt').content).toBe('alpha\nbeta\ndelta\n')
  })

  test('a hunk whose context is absent is refused, and nothing is returned', () => {
    const original = 'one\ntwo\nthree\n'
    expect(() => applyHunks(original, hunkOf('@@ -2,1 +2,1 @@\n-NOPE\n+X'), 'f.txt')).toThrow(
      PatchError,
    )
  })

  test('the refusal names the file, so a model knows what to re-read', () => {
    expect(() =>
      applyHunks('one\n', hunkOf('@@ -1,1 +1,1 @@\n-NOPE\n+X'), 'src/parse.c'),
    ).toThrow(/src\/parse\.c/)
  })

  test('a file with no final newline keeps not having one', () => {
    // The distinction matters for a patch to a `.sha256`-style file or a generated C
    // header, and losing it would make the copy differ from the target in a way no
    // tool on screen reports.
    const { content } = applyHunks('a\nb', hunkOf('@@ -2,1 +2,1 @@\n-b\n+B'), 'f.txt')
    expect(content).toBe('a\nB')
  })

  test('two hunks apply in order without one consuming the other', () => {
    const original = 'a\nb\nc\nd\ne\n'
    const hunks = hunkOf('@@ -1,1 +1,1 @@\n-a\n+A\n@@ -4,1 +4,1 @@\n-d\n+D')
    expect(applyHunks(original, hunks, 'f.txt').content).toBe('A\nb\nc\nD\ne\n')
  })

  test('a hunk that only adds lines inserts them at the context', () => {
    const original = 'a\nb\n'
    const { content } = applyHunks(original, hunkOf('@@ -2,1 +2,2 @@\n b\n+inserted'), 'f.txt')
    expect(content).toBe('a\nb\ninserted\n')
  })

  test('an empty patch body is a no-op rather than a truncation', () => {
    expect(applyHunks('a\nb\n', [], 'f.txt').content).toBe('a\nb\n')
  })
})
