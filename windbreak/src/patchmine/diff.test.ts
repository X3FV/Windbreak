import { describe, expect, test } from 'bun:test'

import {
  addedLines,
  LOG_FORMAT,
  parseCommitPatches,
  parseHunks,
  postImage,
  preImage,
  removedLines,
} from './diff'

/** Build a `git log -p` record the way `LOG_FORMAT` produces one. */
const record = (sha: string, subject: string, patch: string, at = 1_700_000_000): string =>
  `\x1e${sha}\x1f${at}\x1f${subject}\n${patch}\n`

const NULL_CHECK_PATCH = `diff --git a/src/unsafe.c b/src/unsafe.c
index 1234567..89abcde 100644
--- a/src/unsafe.c
+++ b/src/unsafe.c
@@ -10,4 +10,5 @@ int copy(char *dst, const char *src) {
   int n = 0;
-  strcpy(dst, src);
+  if (dst == NULL) return -1;
+  strcpy(dst, src);
   return n;
 }`

describe('the log format', () => {
  test('separates records with characters a commit subject cannot contain', () => {
    // The separator choice is a security decision, not a style one: a subject is
    // attacker-controlled text from the target repository, so a printable
    // separator would let a target forge record boundaries.
    expect(LOG_FORMAT).toContain('%x1e')
    expect(LOG_FORMAT).toContain('%x1f')
  })
})

describe('parseCommitPatches', () => {
  test('parses two commits with their metadata and hunks', () => {
    const stdout =
      record('abc123', 'fix: null check in copy', NULL_CHECK_PATCH) +
      record('def456', 'docs: update README', 'diff --git a/README.md b/README.md\n')

    const commits = parseCommitPatches(stdout)

    expect(commits).toHaveLength(2)
    expect(commits[0]!.sha).toBe('abc123')
    expect(commits[0]!.subject).toBe('fix: null check in copy')
    expect(commits[0]!.committedAt).toBe(1_700_000_000)
    expect(commits[0]!.hunks).toHaveLength(1)
    expect(commits[0]!.hunks[0]!.filePath).toBe('src/unsafe.c')
    expect(commits[1]!.subject).toBe('docs: update README')
  })

  test('keeps a commit that touched nothing, rather than dropping it', () => {
    // A fix commit that only touched a changelog is a fact the coverage counts
    // should reflect; a commit that vanishes is a coverage gap that reads as zero.
    const commits = parseCommitPatches(record('abc123', 'chore: bump version', ''))
    expect(commits).toHaveLength(1)
    expect(commits[0]!.hunks).toEqual([])
  })

  test('strips the b/ prefix from the post-image path', () => {
    const commits = parseCommitPatches(record('abc', 'fix', NULL_CHECK_PATCH))
    expect(commits[0]!.hunks[0]!.filePath).toBe('src/unsafe.c')
  })

  test('drops hunks for a deleted file', () => {
    // `/dev/null` is the post-image of a deletion; there is no current file to
    // mine a sibling from.
    const patch = `diff --git a/gone.c b/gone.c
deleted file mode 100644
--- a/gone.c
+++ /dev/null
@@ -1,2 +0,0 @@
-int a;
-int b;`
    const commits = parseCommitPatches(record('abc', 'remove gone.c', patch))
    expect(commits[0]!.hunks).toEqual([])
  })

  test('returns nothing for empty output', () => {
    expect(parseCommitPatches('')).toEqual([])
  })
})

describe('parseHunks line numbering', () => {
  test('drops a hunk that has no post-image path to attribute it to', () => {
    // Passing only the hunk body is the realistic form of this: a truncated read
    // or a patch fragment with no file header. Inventing a path would attribute
    // candidates to a file that may not exist.
    const bodyOnly = NULL_CHECK_PATCH.split('\n').slice(4).join('\n')
    expect(parseHunks(bodyOnly)).toEqual([])
  })

  test('tracks both sides so a shape can be reported in the pre-image or post-image', () => {
    const hunks = parseHunks(NULL_CHECK_PATCH)
    const lines = hunks[0]!.lines

    const context = lines.find((line) => line.text.includes('int n = 0'))!
    expect(context.oldLine).toBe(10)
    expect(context.newLine).toBe(10)

    const removed = lines.find((line) => line.kind === 'removed')!
    expect(removed.oldLine).toBe(11)
    expect(removed.newLine).toBeNull()

    const added = addedLines(hunks[0]!)[0]!
    expect(added.oldLine).toBeNull()
    expect(added.newLine).toBe(11)
  })

  test('preImage and postImage reconstruct the two sides of the hunk', () => {
    const hunks = parseHunks(NULL_CHECK_PATCH)
    const hunk = hunks[0]!

    expect(preImage(hunk).join('\n')).toContain('strcpy(dst, src);')
    expect(preImage(hunk).join('\n')).not.toContain('== NULL')
    // The post-image has the guard *and* the call it guards.
    expect(postImage(hunk).join('\n')).toContain('== NULL')
    expect(postImage(hunk).join('\n')).toContain('strcpy(dst, src);')
    expect(removedLines(hunk)).toHaveLength(1)
  })
})

describe('diff markers that look like file headers', () => {
  test('an added line beginning `++ ` is content, not a file header', () => {
    // The bug this guards: `+` + `++ x;` is emitted as `+++ x;`, which a naive
    // `startsWith('+++ ')` reads as a post-image header — silently swallowing the
    // very line a detector was looking for and misattributing the file.
    const patch = `diff --git a/src/inc.c b/src/inc.c
--- a/src/inc.c
+++ b/src/inc.c
@@ -1,2 +1,3 @@
 int f(void) {
+++ x;
 }`
    const hunks = parseHunks(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.filePath).toBe('src/inc.c')

    const added = addedLines(hunks[0]!)
    expect(added).toHaveLength(1)
    expect(added[0]!.text).toBe('++ x;')
  })

  test('a removed line beginning `-- ` is content, not a file header', () => {
    const patch = `diff --git a/src/dec.c b/src/dec.c
--- a/src/dec.c
+++ b/src/dec.c
@@ -1,3 +1,2 @@
 int f(void) {
--- y;
 }`
    const hunks = parseHunks(patch)
    const removed = removedLines(hunks[0]!)
    expect(removed).toHaveLength(1)
    expect(removed[0]!.text).toBe('-- y;')
  })
})
