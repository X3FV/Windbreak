/**
 * The stage handoff seam (spec §20.17.3).
 *
 * §20.17 deferred D16's subprocess workers, and §20.17.3 named the one piece of
 * work that had to happen anyway: *"Each stage's options object should separate
 * its serializable request from its injected services … with the DTOs in place,
 * whichever trigger fires first is a `Bun.spawn` and a codec rather than a
 * rewrite."*
 *
 * This module is the generic half of that seam. The per-stage halves live beside
 * their stages, because a stage's request is the stage's business:
 *
 * ```ts
 * export interface TriageRequest { runId: string; candidates: …; enrich?: boolean }
 * export interface TriageServices { db: Database; invoker: ModelInvoker; … }
 * export type RunTriageOptions = TriageRequest & TriageServices
 * ```
 *
 * ## The intersection is the partition, and that is why it is an intersection
 *
 * `RunTriageOptions` is deliberately `TriageRequest & TriageServices` rather
 * than a rewritten interface with the same fields. Two things fall out of it
 * that a rewritten interface would not give:
 *
 * - **`keyof (A & B)` is `keyof A | keyof B`.** Every field of the options object
 *   is in exactly one half *by construction*, so no registry, test, or reviewer
 *   has to keep an "all fields classified" list in sync. There is nothing to
 *   drift.
 * - **Every existing caller compiles unchanged.** An object literal accepting
 *   `db` and `runId` satisfies the intersection exactly as it satisfied the flat
 *   interface, so this seam cost zero call-site churn across the pipeline and
 *   its ~680 tests — which is what made it affordable to do before anything
 *   needed it.
 *
 * ## What is actually enforced, and where
 *
 * Naming two interfaces does not make the split true; someone can put `db` in
 * `TriageRequest` tomorrow and every test still passes. Two checks prevent that,
 * and neither costs runtime code:
 *
 * 1. **`JsonCompatible`** (below, asserted in `handoff.test.ts`) fails the
 *    *typecheck* if a request half is composed of anything JSON cannot carry. A
 *    `Database`, a callback, a class instance — all rejected. This is the check
 *    that catches the mistake at the moment it is made, in the file where it is
 *    made.
 * 2. **`HANDOFFS`** (`./handoffs`) names each stage's two key lists, and its
 *    exhaustiveness is asserted at the type level. Adding a field to a request
 *    or services interface fails compilation until it is placed in one of them.
 *
 * ## What this module is not
 *
 * There is no transport here. `encodeRequest`/`decodeRequest` are a JSON codec
 * and nothing more — no framing, no channel, no process. They exist so that the
 * claim in §20.17.3 is a *fact about this codebase* rather than a prediction:
 * the request half of every orchestrator-driven stage can be written to a pipe
 * and read back, and `handoff.test.ts` demonstrates it on real option objects.
 */

/** A value that survives a JSON round trip. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/**
 * `true` when every part of `T` is something JSON can carry.
 *
 * The object case is the subtle one. `{ [K in keyof T]: JsonCompatible<T[K]> }`
 * is a *union* of the per-field verdicts, so the test is whether `false` appears
 * anywhere in it: all-true collapses to `true` and `false extends true` is
 * false. Written the other way round (`true extends union`) every object with at
 * least one good field would pass and the guard would be worthless.
 *
 * `undefined` is allowed because it is how an optional request field is absent —
 * `JSON.stringify` drops it, which is the behaviour a transport wants.
 */
export type JsonCompatible<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends ReadonlyArray<infer Element>
      ? JsonCompatible<Element>
      : T extends object
        ? false extends { [K in keyof T]: JsonCompatible<T[K]> }[keyof T]
          ? false
          : true
        : false

/**
 * The names of `T`'s fields that JSON cannot carry. Empty (`never`) on a correct
 * request half.
 *
 * `JsonCompatible` answers *whether* a half is serializable; this answers *which
 * field* broke it, which is the difference between a usable error and a red line
 * telling you to go looking. A mapped type rather than a boolean so the answer
 * survives as a type: `NonSerializableKeys<{ db: Database; runId: string }>` is
 * `'db'`, not `false`.
 */
export type NonSerializableKeys<T> = {
  [K in keyof T & string]: JsonCompatible<T[K]> extends true ? never : K
}[keyof T & string]

/**
 * `true` when `T` is a valid request half, or `{ notSerializable: 'db' }` when it
 * is not.
 *
 * The object-shaped failure is deliberate, and it is the same trick `KeysMatch`
 * uses. A `T extends never` constraint reports the offender as a bare type
 * argument, and TypeScript *widens* it — `'db'` and `'db' | 'runId'` both print as
 * `string`, which names nothing. A literal in an anonymous object type's property
 * position is printed verbatim, so this shape is the difference between "a
 * request half is not serializable" and "move `db`".
 */
export type SerializabilityCheck<T> =
  NonSerializableKeys<T> extends never
    ? true
    : { readonly notSerializable: NonSerializableKeys<T> }

/**
 * A stage's declared partition of its options object.
 *
 * `requestKeys` and `serviceKeys` exist for the transport that is not written
 * yet: a worker needs to know which fields to serialize and which to re-inject
 * on the far side, and reading that off a type is not something a running
 * program can do.
 */
export interface Handoff {
  /** The stage's name, for errors and for the registry. */
  readonly stage: string
  readonly requestKeys: readonly string[]
  readonly serviceKeys: readonly string[]
}

/**
 * `true` when `Keys` names exactly the fields of `T` — no omissions, no
 * strangers, checked in both directions.
 *
 * This is what makes the registry load-bearing rather than a comment. A field
 * added to `TriageRequest` and forgotten here resolves to `{ missing: … }`, which
 * is not `true`, so the line that asserts exhaustiveness stops compiling and says
 * which field is unplaced. A key that is not a field at all (a typo, a rename)
 * resolves to `{ unknown: … }`.
 *
 * Both failures are reported as a type rather than a `never`, because
 * `Exclude<A, B> extends never ? true : false` gives "type 'false' is not
 * assignable to type 'true'" — which tells you something is wrong but not what.
 */
export type KeysMatch<T, Keys extends readonly string[]> =
  Exclude<keyof T & string, Keys[number]> extends never
    ? Exclude<Keys[number], keyof T & string> extends never
      ? true
      : { readonly unknown: Exclude<Keys[number], keyof T & string> }
    : { readonly missing: Exclude<keyof T & string, Keys[number]> }

export class MalformedRequestError extends Error {
  override readonly name = 'MalformedRequestError'
}

/**
 * Serialize a stage request for a pipe.
 *
 * Deliberately takes the request half rather than the whole options object: a
 * call that could accidentally serialize `db` would not fail until the far side
 * tried to use it, and by then the mistake is a bug report rather than a
 * typecheck. `JsonCompatible` makes passing the whole object a compile error at
 * most call sites; this signature makes it impossible at all of them.
 */
export const encodeRequest = <Request extends object>(request: Request): string =>
  JSON.stringify(request)

/**
 * Read a stage request back.
 *
 * The payload is untrusted input — it arrived over a pipe — so a failure is a
 * typed error rather than a raw `SyntaxError` out of `JSON.parse`. It does *not*
 * validate shape: schema validation belongs to whoever owns the request type,
 * and a half-check here would be a second, weaker definition of the same thing.
 */
export const decodeRequest = <Request>(payload: string): Request => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new MalformedRequestError(
      `stage request is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedRequestError(
      `stage request must be a JSON object, received ${parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed}`,
    )
  }

  return parsed as Request
}

/**
 * The in-process twin of the codec: split a flat options object along the
 * declared keys.
 *
 * Useful for the case that has nothing to do with pipes — passing only the
 * serializable half to something that must not see the host, such as a cache
 * key or a fingerprint. Absent keys are omitted rather than set to `undefined`
 * so that `JSON.stringify(request)` and `encodeRequest(request)` agree.
 *
 * **Name the halves explicitly at the call site.**
 *
 * ```ts
 * splitStageOptions<TriageRequest, TriageServices>(HANDOFFS.triage, options)
 * ```
 *
 * The registry's `as const` exists so `handoffs.ts` can assert its key lists are
 * exhaustive, and that is precisely what erases the interface the keys came from:
 * an inferred `Request` would silently degrade to `object` and hand back
 * `{ request: object }`, which typechecks and then reads as an error somewhere
 * else. Naming them keeps the halves. It is not a workaround — a transport
 * already knows which stage it is spawning, and stating it is cheaper than the
 * failure mode of a silent `object`.
 */
export const splitStageOptions = <Request extends object, Services extends object>(
  handoff: Handoff,
  options: Request & Services,
): { request: Request; services: Services } => {
  const request: Record<string, unknown> = {}
  const services: Record<string, unknown> = {}

  for (const key of handoff.requestKeys) {
    if (key in options) request[key] = (options as Record<string, unknown>)[key]
  }
  for (const key of handoff.serviceKeys) {
    if (key in options) services[key] = (options as Record<string, unknown>)[key]
  }

  return { request: request as Request, services: services as Services }
}
