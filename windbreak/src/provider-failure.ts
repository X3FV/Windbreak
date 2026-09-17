/**
 * Why a model call was refused, when the reason is the *account* rather than the
 * request (spec §18, §20.29.6).
 *
 * Every other model failure windbreak reports is a fact about one call: a role returned
 * no structured value, an answer did not match its schema, a turn ran out of steps.
 * Those are worth a line each and nothing more, because the next call is a different
 * call. A billing or authentication refusal is not that. It is a property of the
 * *caller*, it is true of every call the process will make, and left alone it repeats
 * once per candidate — a hundred identical `warning:` lines in which the one fact that
 * matters is not distinguishable from the hundred.
 *
 * §18's rule is that a failure must not read as a result. This module exists for the
 * narrower version of it: a refusal that will not change must not read as one of a
 * hundred ordinary failures.
 *
 * **Two kinds, because they have different fixes.** `credits` is a balance the operator
 * can top up; `auth` is a credential they have to replace. A single "model call failed"
 * would send a reader looking in the wrong place for half of them.
 *
 * **The classification is textual, and that is a limitation rather than a design.** The
 * SDK's refusal path that returns `output.type === 'error'` carries the provider's
 * message and no status code, so a pattern is all that is left. Where a thrown error is
 * available its status code is read as well (`statusCode`, then `status` — the pair
 * `@codebuff/sdk`'s own `getErrorStatusCode` checks). That helper is reimplemented here
 * rather than imported for the reason `auth.ts` re-states its constants: importing it
 * would load the SDK at module scope, and the CLI's non-model commands must not pay for
 * that.
 */

export type ProviderFailureKind = 'credits' | 'auth'

export interface ProviderFailure {
  kind: ProviderFailureKind
  /** The provider's own words, collapsed, so a reader can see what it actually said. */
  detail: string
}

/** The token `freebuff` itself matches on (`@codebuff/common/constants/freebuff-errors`). */
const CREDITS_PATTERNS: readonly RegExp[] = [
  /\b(?:(?:not enough|insufficient|out of)\s+credits?|(?:add|refill|top up)\s+(?:more\s+)?credits?)\b/i,
  /\bpayment required\b/i,
  /\binsufficient[_-]quota\b/i,
]

/**
 * Authentication and authorisation refusals.
 *
 * `no freebuff credentials found` is windbreak's own `MissingCredentialsError` copy
 * (`client.ts`), included deliberately: a scan with no credentials at all skips its
 * model stages, and that skip deserves the same prominence as a provider refusing one.
 * It is stated with the words around it rather than as a bare `credentials` so a
 * candidate's error text cannot match it by accident.
 */
const AUTH_PATTERNS: readonly RegExp[] = [
  /\bauthentication failed\b/i,
  /\bunauthorized\b/i,
  /\baccess forbidden\b/i,
  /\bnot logged in\b/i,
  /\b(?:invalid|incorrect|missing|expired|revoked)\s+(?:api[-\s]?key|token|credentials?)\b/i,
  /\bno\s+(?:freebuff\s+)?credentials\s+found\b/i,
]

/**
 * The HTTP status a thrown error carries, if any.
 *
 * Both spellings, in this order, because the SDK's own convention is `statusCode` and the
 * AI SDK's `APICallError` uses `status`.
 */
export const statusCodeOf = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined

  for (const key of ['statusCode', 'status'] as const) {
    const value = (error as Record<string, unknown>)[key]
    if (typeof value === 'number') return value
  }

  return undefined
}

/** One line, bounded: provider bodies can be a whole HTML page or a stack trace. */
const collapse = (text: string, max = 240): string => {
  const flattened = text.replace(/\s+/g, ' ').trim()
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened
}

/**
 * Classify one failure message.
 *
 * Order matters: a billing refusal is looked for first, because a provider that says
 * "out of credits" may well also mention the account, and recalling which of the two a
 * reader can act on is exactly the judgement this module is supposed to make once
 * rather than in every caller.
 */
export const classifyProviderFailure = (input: {
  message: string
  statusCode?: number | undefined
}): ProviderFailure | null => {
  const detail = collapse(input.message)
  const haystacks = [input.message, detail]

  const matches = (patterns: readonly RegExp[]): boolean =>
    haystacks.some((text) => patterns.some((pattern) => pattern.test(text)))

  if (input.statusCode === 402 || matches(CREDITS_PATTERNS)) {
    return { kind: 'credits', detail }
  }

  if (
    input.statusCode === 401 ||
    input.statusCode === 403 ||
    matches(AUTH_PATTERNS)
  ) {
    return { kind: 'auth', detail }
  }

  return null
}

/**
 * The first account-level refusal among these messages, if there is one.
 *
 * The list-taking form is what the batch surface needs: a stage reports a count of failed
 * calls and a warning per call, and what the summary has to say is whether the *reason*
 * they failed was the account. Scanning them is a search rather than a second
 * classification, so the two cannot disagree about what a refusal is.
 */
export const findProviderFailure = (
  messages: Iterable<string>,
): ProviderFailure | null => {
  for (const message of messages) {
    const failure = classifyProviderFailure({ message })
    if (failure) return failure
  }

  return null
}

/** A two-or-three word name for the refusal, for chrome that has one row to spend. */
export const providerFailureLabel = (failure: ProviderFailure): string =>
  failure.kind === 'credits' ? 'out of credits' : 'not authenticated'

/**
 * What the operator does about it, as an imperative sentence.
 *
 * Separate from the full description because the two surfaces have different amounts of
 * room — a pane's banner is a few rows above an input, a summary is a paragraph after the
 * run — and one copy reaching both is the only way the two cannot end up advising
 * different things.
 */
export const providerFailureFix = (failure: ProviderFailure): string =>
  failure.kind === 'credits'
    ? 'Add credits at https://www.codebuff.com/usage.'
    : 'Log in again with `freebuff`, or set CODEBUFF_API_KEY.'

/**
 * The sentence a surface shows in place of, or above, whatever it was going to say.
 *
 * Both kinds say three things and in this order: what was refused, what the provider
 * said, and what the operator does next. The credits sentence adds the reason this
 * failure is surprising — that Freebuff itself is answering while its own tool is
 * refused — because that is the question it raises, and answering it from the codebase's
 * own constants beats leaving a researcher to conclude the tool is broken.
 */
export const describeProviderFailure = (failure: ProviderFailure): string => {
  if (failure.kind === 'credits') {
    return (
      `the model provider refused this call for billing: ${failure.detail} Every ` +
      'model call from here is refused the same way. ' +
      `${providerFailureFix(failure)} Windbreak runs its own agents rather than ` +
      "Freebuff's free-tier ones, so a scan or a question is always metered."
    )
  }

  return (
    `the model provider refused this call for authentication: ${failure.detail} ` +
    `${providerFailureFix(failure)} Then retry.`
  )
}
