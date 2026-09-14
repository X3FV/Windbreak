/**
 * Public client-environment defaults, for running from source.
 *
 * `./env.ts` validates `clientProcessEnv` **at import time** and throws on the
 * first missing `NEXT_PUBLIC_*` value. That is correct for the shipped artifacts
 * because they never run without it: `cli/scripts/build-binary.ts` inlines the
 * builder's `NEXT_PUBLIC_*` values with `--define`, and `sdk/scripts/build.ts`
 * inlines them with bun's `env` option. A **source** run has neither, so
 * `bun run src/index.ts` in either package dies with a zod issue dump before
 * `main` is reached — which is why every WindBreak open item that says "no live
 * run has been scored" also says "run with `--preload ../sdk/test/setup-env.ts`".
 *
 * This module is the missing half: the same public values the shipped binaries
 * carry, as a checked-in table, applied to `process.env` before anything
 * imports `common/env`. §20.19.8 declined to fix this on the grounds that "a
 * correct fix needs the SDK's full required-variable list, and a partial
 * pre-check would produce a worse answer than the dump" — that objection is
 * answered structurally rather than by care:
 *
 *   `CLIENT_ENV_DEFAULTS` is `Record<ClientEnvVar, string>`, and
 *   `ClientEnvVar` is `clientEnvSchema.keyof().options`. Adding a required
 *   `NEXT_PUBLIC_*` to the schema therefore **fails to compile** until it has a
 *   value here — and an extra key fails as an excess property. There is no list
 *   to keep in sync by hand.
 *
 * ## The import that must not be here
 *
 * `env-schema.ts` does not merely validate; it also builds `clientProcessEnv`,
 * a plain object that **copies** the `NEXT_PUBLIC_*` values out of
 * `process.env` the moment the module is evaluated. `env.ts` then validates
 * that copy. So filling `process.env` after `env-schema` has been evaluated
 * changes nothing — which is exactly what a first version of this module did,
 * by importing `clientEnvVars` from it for the key list. The CLI still died on
 * the same dump with `process.env.NEXT_PUBLIC_CB_ENVIRONMENT` visibly set to
 * `'prod'`.
 *
 * The import below is therefore **type-only**, erased at run time, and the key
 * list is derived from the table itself. Anything this module imported at run
 * time that reached `env-schema` would reintroduce the bug, so the rule is
 * absolute: this module has no runtime imports, and it must be evaluated before
 * `env-schema` is.
 *
 * ## Every value here is public by definition
 *
 * `NEXT_PUBLIC_` marks a value the client is *supposed* to hold — it is already
 * compiled into every published binary and every shipped bundle, and this table
 * only makes the source path tell the same story they do. Nothing secret is
 * added by checking these in; treat any change to them as a public change.
 *
 * ## Why `prod` and not `dev`
 *
 * `prod` is not a preference. `CS()` in the CLI derives its config directory
 * from `NEXT_PUBLIC_CB_ENVIRONMENT` — `~/.config/manicode` for `prod`, but
 * `~/.config/manicode-dev` for `dev` — so a `dev` default would look for
 * credentials in a directory that does not exist and turn "run from source"
 * into "log in again". It is also the only environment that exists: there is no
 * local Codebuff backend to point at, and the token a developer already has is
 * a production token.
 */

import type { ClientEnvVar } from './env-schema'

/**
 * The public client environment, as the shipped binaries carry it.
 *
 * Two entries are deliberately empty: `NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY` and
 * `NEXT_PUBLIC_RECAPTCHA_V2_SIZE`. Both are `.optional()`, and both are absent
 * from the values the release build inlines, so `''` here means "no default"
 * and the applier skips them — see `applyClientEnvDefaults`.
 */
export const CLIENT_ENV_DEFAULTS: Record<ClientEnvVar, string> = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'prod',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://www.codebuff.com',
  NEXT_PUBLIC_FREEBUFF_APP_URL: 'https://freebuff.com',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.com',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'phc_tug7g8yc10qNestK14QV8WyKwjfEl6vwzIbJkBdqeHS',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
  NEXT_PUBLIC_GRAVITY_PIXEL_ID: '679a2a98-1a9e-4c6a-a726-25d49cf129eb',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:
    'pk_live_51Q0SA5KrNS6SjmqWMgRE0ar5v6cMvtizkyY3mXjYaZsU6AG9ctpNPKZMVf6xFK2ngqwkt8rHNIQgNiCFSbRdGb9Z00QEo13rfx',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
    'https://billing.stripe.com/p/login/cN22bea8W6Ra2is144',
  // A placeholder in the shipped binary too; the schema only asks that it be
  // present, and nothing in the CLI reads it.
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: 'your google verification id',
  NEXT_PUBLIC_WEB_PORT: '3000',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAACvi5pdE5_cnLWnI',
  NEXT_PUBLIC_RECAPTCHA_V2_SITE_KEY: '',
  NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY: '6Lco9YQtAAAAAGUkMjhV00W2lt0gXesqwnlx0x1O',
  NEXT_PUBLIC_RECAPTCHA_V2_SIZE: '',
  NEXT_PUBLIC_HUMANBEHAVIOR_API_KEY: 'hb_ff84ed1a74788d58c96db3ea84f35454',
}

/**
 * Whether this process is a compiled freebuff binary.
 *
 * Read from `process.env` *literally* — not through `target` — because
 * `cli/scripts/build-binary.ts` defines `process.env.CODEBUFF_IS_BINARY` as the
 * literal `"true"`, so the bundler rewrites this expression to `true` and the
 * check survives minification. `target` is checked as well so the branch is
 * reachable from a test, which cannot set an inlined literal.
 */
export const isCompiledBinary = (target: NodeJS.ProcessEnv): boolean =>
  process.env.CODEBUFF_IS_BINARY === 'true' ||
  target.CODEBUFF_IS_BINARY === 'true'

/**
 * Fill in any `NEXT_PUBLIC_*` value the environment did not supply, and return
 * the names that were filled, in the table's declaration order — so the result
 * is stable, and a caller can report it without sorting.
 *
 * Three rules, each of which exists because the other choice is worse:
 *
 * - **Only missing values are filled.** An operator who exports a value keeps
 *   it, so pointing a run at a staging backend stays a one-line override. A
 *   *bad* value is kept too, and then fails validation on purpose: silently
 *   replacing a typo would hide the typo.
 * - **Empty counts as missing.** `''` fails the very schema these values exist
 *   to satisfy (`z.string().min(1)`, `z.url()`), so treating it as set would
 *   reproduce the failure the table is here to prevent. This matches
 *   `sdk/test/setup-env.ts`, which fills on the same falsy test.
 * - **A compiled binary is left alone.** Its client env was fixed at build
 *   time, and `--define` only rewrites *static* `process.env.X` reads — a
 *   runtime assignment here would make the dynamic reads (`process.env['X']`,
 *   as in `sdk/src/env.ts`'s `getRuntimeAppUrlFromEnv`) disagree with the
 *   inlined ones. So the guard is not conservatism; without it a `dev`-built
 *   binary would route its runtime lookups at production.
 */
export const applyClientEnvDefaults = (
  target: NodeJS.ProcessEnv = process.env,
  defaults: Record<ClientEnvVar, string> = CLIENT_ENV_DEFAULTS,
): ClientEnvVar[] => {
  if (isCompiledBinary(target)) {
    return []
  }

  const filled: ClientEnvVar[] = []

  for (const key of Object.keys(defaults) as ClientEnvVar[]) {
    const value = defaults[key]
    if (!value) {
      // '' is the table's "no default" — an optional variable the release
      // build leaves unset, which must stay unset or `.optional()` would turn
      // into a present-but-invalid value.
      continue
    }
    if (target[key]) {
      continue
    }
    target[key] = value
    filled.push(key)
  }

  return filled
}

/**
 * A fresh environment object holding the defaults, for callers that want to
 * pass values around rather than mutate `process.env`. Mostly a test seam —
 * `clientEnvSchema.safeParse(CLIENT_ENV_DEFAULTS)` cannot pass, because the two
 * empty entries would be present-but-invalid; this is what the schema actually
 * sees.
 */
export const createDefaultClientEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  applyClientEnvDefaults(env)
  return env
}
