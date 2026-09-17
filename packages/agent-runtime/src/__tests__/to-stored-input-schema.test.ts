import { describe, expect, it } from 'bun:test'
import z from 'zod/v4'

import { gravityIndexInputSchema } from '@codebuff/common/types/gravity-index'

import { toStoredInputSchema } from '../run-agent-step'

/**
 * Anything in this tree that JSON cannot carry.
 *
 * The point of the conversion is not "the schema looks different" but "nothing in the stored
 * state is a live object": a function anywhere inside it is what made `cloneSessionState`'s
 * JSON round trip throw in production, and Zod's internals are reachable *through* the schema,
 * not only at its surface.
 */
const containsNonJson = (value: unknown, seen = new Set<unknown>()): boolean => {
  if (typeof value === 'function') return true
  if (typeof value === 'bigint' || typeof value === 'symbol') return true
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)

  const children = Array.isArray(value) ? value : Object.values(value)
  return children.some((child) => containsNonJson(child, seen))
}

describe('toStoredInputSchema', () => {
  it('stores JSON Schema for a Zod schema', () => {
    const stored = toStoredInputSchema(
      z.object({ path: z.string(), content: z.string() }),
    )!

    expect(stored.type).toBe('object')
    expect(Object.keys(stored.properties as object)).toEqual([
      'path',
      'content',
    ])
    expect(stored).toHaveProperty('required')
  })

  it('stores JSON, not the schema object it came from', () => {
    const schema = z.object({
      context: z
        .record(z.string(), z.union([z.string(), z.array(z.unknown())]))
        .optional(),
    })

    const stored = toStoredInputSchema(schema)!

    // The regression pin. `toolDefinitions` held the schema itself
    // (`tool.inputSchema as {}`), and Zod's object graph is reachable and cyclic, so every
    // `JSON.stringify` of the state threw — the snapshot fell back to `cloneDeep` and each
    // checkpoint wrote "[Circular]" over the schema. Nothing in the stored form may be live.
    expect(containsNonJson(schema)).toBe(true)
    expect(containsNonJson(stored)).toBe(false)
    expect(
      JSON.stringify({
        toolDefinitions: { t: { description: 'x', inputSchema: stored } },
      }),
    ).not.toContain('[Circular]')
  })

  it('converts a real tool schema from this repository', () => {
    const stored = toStoredInputSchema(gravityIndexInputSchema)!

    expect(stored.type).toBe('object')
    expect(stored.properties).toHaveProperty('action')
    expect(containsNonJson(stored)).toBe(false)
    // A `$ref` into `$defs` is how Zod represents a nested definition; it has to survive, or
    // the description of the parameters is lost even though the object is now serializable.
    expect(JSON.stringify(stored)).toContain('action')
  })

  it('copies a plain object instead of aliasing it', () => {
    const plain = { type: 'object', properties: { q: { type: 'string' } } }

    const stored = toStoredInputSchema(plain)!

    expect(stored).toEqual(plain)
    // A caller that mutates the stored definition must not reach back into the tool's own
    // schema — the snapshot is taken while the tool is still in use.
    expect(stored).not.toBe(plain)
  })

  it('falls back to the empty object schema for anything that is not one', () => {
    // "Any object" — the same substitution the token counter makes. It describes knowing
    // nothing, which is true, instead of inventing a parameter list.
    const empty = { type: 'object', properties: {} }

    expect(toStoredInputSchema(null)).toEqual(empty)
    expect(toStoredInputSchema(undefined)).toEqual(empty)
    expect(toStoredInputSchema('read_files')).toEqual(empty)
    expect(toStoredInputSchema(['path'])).toEqual(empty)
    expect(toStoredInputSchema(42)).toEqual(empty)
  })

  it('never stores the schema it failed to convert', () => {
    // `safeParse` is the marker that says "this is a schema", and only a real one can be
    // converted. The fallback has to be the empty schema rather than the object it was
    // handed: spreading a schema that Zod refused is how the live object gets back in.
    const unconvertible = { safeParse: () => undefined, def: { recursive: true } }

    const stored = toStoredInputSchema(unconvertible)

    expect(stored).toEqual({ type: 'object', properties: {} })
    expect(stored).not.toHaveProperty('def')
  })
})
