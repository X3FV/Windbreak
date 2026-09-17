/**
 * What a fix commit actually changed (spec §11.1).
 *
 * A corpus of vulnerable/patched pairs is only as good as the claim that each
 * pair's two halves differ *in a way that a detector could have caught*. A commit
 * that fixes a CVE almost always includes incidental edits the fix is not about:
 * reformatting the function, correcting a comment, adding an attribution line.
 * A pair built from the whole function would then record a *comment* as the
 * difference, and every such pair is a bug seeded that no rule could ever fire
 * on — indistinguishable, in the recall figure, from a rule that missed a real
 * defect.
 *
 * That is the §11.2 failure in miniature: ground truth that encodes the
 * author's assumption rather than a fact about the code. So the builder asks a
 * narrower question than "did the function change" — it asks **did any code
 * change** — and drops the pair when only prose did.
 *
 * Answering that needs a real lexer rather than a regex, because a `//` inside a
 * string literal is not a comment and a `/*` inside one is not a comment either.
 * Stripping on the regex would delete the tail of a line like
 * `fprintf(stderr, "http://example")` and could make two halves compare equal
 * when the fix had in fact changed the URL — a dropped pair, which is the safe
 * direction, but a silent one.
 */

const IDENTIFIER = /[A-Za-z0-9_.]/
/**
 * Split a comment-free fragment into tokens.
 *
 * Collapsing whitespace *runs* is not enough to decide whether code changed: a
 * reformat that adds a space — `{return` to `{ return` — survives collapsing, so
 * the pair looks like a real fix and is seeded as a bug. Comparing token streams
 * answers the actual question, and it is the reason this is a lexer rather than
 * two regular expressions: `unsigned int` and `unsignedint` must stay different,
 * while `strcpy (a)` and `strcpy(a)` must not.
 */
const tokenize = (source: string): string[] => {
  const tokens: string[] = []
  let index = 0

  while (index < source.length) {
    const char = source[index]!

    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (char === '"' || char === "'") {
      const quote = char
      let token = char
      index += 1
      while (index < source.length) {
        const current = source[index]!
        if (current === '\\') {
          token += current + (source[index + 1] ?? '')
          index += 2
          continue
        }
        token += current
        index += 1
        if (current === quote) break
      }
      tokens.push(token)
      continue
    }

    if (IDENTIFIER.test(char)) {
      let token = ''
      while (index < source.length && IDENTIFIER.test(source[index]!)) {
        token += source[index]
        index += 1
      }
      tokens.push(token)
      continue
    }

    tokens.push(char)
    index += 1
  }

  return tokens
}

/**
 * Comment- and layout-insensitive view of a source fragment.
 *
 * Two fragments with the same signature differ only in how they are written, not
 * in what they do — which is exactly the condition under which a pair is not a
 * fix and must not enter the corpus.
 */
export const codeSignature = (source: string): string => tokenize(stripComments(source)).join(' ')

/**
 * Remove comments while preserving everything inside string and character
 * literals.
 *
 * Escapes are honoured in both literals, because a literal ending in `\"` does
 * not close and treating it as closed would put the lexer back in code state
 * mid-string — after which a `//` inside the rest of the string would be read as
 * a comment and truncated.
 */
export const stripComments = (source: string): string => {
  const out: string[] = []
  let index = 0
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' = 'code'

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment'
        index += 2
        continue
      }
      if (char === '/' && next === '*') {
        state = 'block-comment'
        index += 2
        continue
      }
      if (char === '"') state = 'string'
      else if (char === "'") state = 'char'
      out.push(char)
      index += 1
      continue
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code'
        out.push(char)
      }
      // A backslash at end of line splices the next line into this comment, so
      // the comment does not end there.
      else if (char === '\\' && next === '\n') index += 1
      index += 1
      continue
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 2
        // A space, not nothing: `int x/*c*/y;` must not become `int xy;`.
        out.push(' ')
        continue
      }
      index += 1
      continue
    }

    // string or char literal
    if (char === '\\') {
      out.push(char)
      if (next !== undefined) out.push(next)
      index += 2
      continue
    }
    if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) {
      state = 'code'
    }
    out.push(char)
    index += 1
  }

  return out.join('')
}

/**
 * True when the two halves differ only in comments and whitespace.
 *
 * The builder drops such a pair. Whitespace has to be normalized as well as
 * comments, because a fix may only re-indent the code it did not change, and the
 * pair would otherwise carry a difference that means nothing.
 */
export const onlyCommentsChanged = (vulnerable: string, patched: string): boolean =>
  codeSignature(vulnerable) === codeSignature(patched)
