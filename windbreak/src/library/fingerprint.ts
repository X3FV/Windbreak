/**
 * The fingerprint language (spec §10, §4.8).
 *
 * A fingerprint is a small, closed set of predicates over *call presence* in a
 * site. It is validated strictly, and the validation is not ceremony: a
 * fingerprint with no required call at all is vacuous — it would match every
 * function in the target, which is the cross-target version of the §3 recall
 * failure (§18, "no finding better than a flood of noise").
 *
 * Two rules carry most of the weight:
 *
 * 1. **At least one positive predicate.** Requiring or requiring-any of a call
 *    is what bounds the match. `forbidCalls` alone matches everything that is
 *    *not* a bounded copy, which is most code.
 * 2. **Ordering pairs are strict.** `before === after` is meaningless and is
 *    refused rather than silently satisfied.
 */

import { z } from 'zod'

import { PROGRAM_MODEL_LANGUAGES } from '../recon/languages'

import type { Fingerprint, FingerprintBody } from './types'

/** Language ids the matcher can actually see, i.e. those recon indexes. */
export const FINGERPRINT_LANGUAGES = Object.keys(PROGRAM_MODEL_LANGUAGES)

/** A C identifier or a bare member name. Deliberately strict. */
const SYMBOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const nameList = z.array(z.string().regex(SYMBOL_NAME, 'must be a symbol name')).max(32)

const rawFingerprintSchema = z
  .object({
    scope: z.enum(['function', 'file']),
    cwe: z
      .string()
      .regex(/^CWE-\d{1,5}$/, 'must look like CWE-120')
      .nullable(),
    summary: z.string().min(1).max(240),
    // A sanity bound, not a language list: the program model grew from two
    // languages to eleven, and a cap of 8 made a pattern that targets most of
    // them unexpressible. The superRefine below is what actually checks that
    // each language is one the program model can index.
    languages: z.array(z.string()).min(1).max(16),
    requireCalls: nameList,
    requireAnyCalls: nameList,
    forbidCalls: nameList,
    order: z
      .array(
        z.object({ before: z.string().regex(SYMBOL_NAME), after: z.string().regex(SYMBOL_NAME) }),
      )
      .max(8),
  })
  .strict()

/**
 * Shared predicate checks.
 *
 * Applied to both the model's output schema and the stored fingerprint schema
 * so a fingerprint can never be *stored* that could not have been returned —
 * and vice versa, which matters because the researcher can hand-author one.
 */
const checkPredicates = (
  value: {
    languages: string[]
    requireCalls: string[]
    requireAnyCalls: string[]
    forbidCalls: string[]
    order: Array<{ before: string; after: string }>
  },
  ctx: z.RefinementCtx,
): void => {
  if (value.requireCalls.length === 0 && value.requireAnyCalls.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requireCalls'],
      message:
        'a fingerprint must require at least one call; without a positive predicate it ' +
        'matches every function in the target',
    })
  }

  for (const language of value.languages) {
    if (!FINGERPRINT_LANGUAGES.includes(language)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['languages'],
        message:
          `"${language}" has no program model, so the matcher cannot see it. ` +
          `Registered: ${FINGERPRINT_LANGUAGES.join(', ')}.`,
      })
    }
  }

  const forbidden = new Set(value.forbidCalls)
  for (const name of [...value.requireCalls, ...value.requireAnyCalls]) {
    if (forbidden.has(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['forbidCalls'],
        message: `"${name}" is both required and forbidden, which can never match`,
      })
    }
  }

  value.order.forEach((pair, index) => {
    if (pair.before === pair.after) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order', index],
        message: 'before and after must differ',
      })
    }
  })
}

/** What the synthesis model must return. */
export const fingerprintOutputSchema = rawFingerprintSchema.superRefine(checkPredicates)

/** What is stored, and what the matcher accepts. */
export const fingerprintSchema = rawFingerprintSchema
  .extend({ kind: z.literal('function-shape') })
  .superRefine(checkPredicates)

export class InvalidFingerprintError extends Error {
  constructor(message: string) {
    super(
      `Refusing this fingerprint: ${message}. A pattern that does not validate is ` +
        'dropped, not tuned (spec §4.4.1, §10).',
    )
    this.name = 'InvalidFingerprintError'
  }
}

/** Parse a stored or hand-authored fingerprint, throwing on anything invalid. */
export const parseFingerprint = (input: unknown): Fingerprint => {
  const parsed = fingerprintSchema.safeParse(input)
  if (!parsed.success) {
    throw new InvalidFingerprintError(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    )
  }
  return parsed.data
}

/** Attach the discriminator to a model-produced body. */
export const toFingerprint = (body: FingerprintBody): Fingerprint =>
  parseFingerprint({ ...body, kind: 'function-shape' })

/**
 * A one-line description, used as the candidate message.
 *
 * Written to read like a claim rather than a label, because the researcher sees
 * this string on every hit the pattern produces across every target.
 */
export const describeFingerprint = (fingerprint: Fingerprint): string => {
  const parts: string[] = []

  if (fingerprint.requireCalls.length > 0) {
    parts.push(`calls ${fingerprint.requireCalls.join(' and ')}`)
  }
  if (fingerprint.requireAnyCalls.length > 0) {
    parts.push(
      `calls one of ${fingerprint.requireAnyCalls.join('/')}`,
    )
  }
  if (fingerprint.forbidCalls.length > 0) {
    parts.push(`with none of ${fingerprint.forbidCalls.join('/')} present`)
  }
  for (const pair of fingerprint.order) {
    parts.push(`${pair.before} before ${pair.after}`)
  }

  const body = parts.length > 0 ? parts.join(', ') : 'matches no predicate'
  return fingerprint.cwe ? `${fingerprint.summary} [${fingerprint.cwe}]: ${body}` : `${fingerprint.summary}: ${body}`
}

/** Stable JSON, so a digest does not move when field order moves. */
export const canonicalFingerprintJson = (fingerprint: Fingerprint): string =>
  JSON.stringify([
    fingerprint.kind,
    fingerprint.scope,
    fingerprint.cwe,
    fingerprint.summary,
    [...fingerprint.languages].sort(),
    [...fingerprint.requireCalls].sort(),
    [...fingerprint.requireAnyCalls].sort(),
    [...fingerprint.forbidCalls].sort(),
    fingerprint.order.map((pair) => [pair.before, pair.after]),
  ])
