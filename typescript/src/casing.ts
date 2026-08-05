/**
 * Boundary between idiomatic camelCase (what SDK users write) and the API's snake_case wire
 * format. One mechanical transform, no per-field code.
 *
 * Two subtrees are user data and pass through with their keys untouched:
 * - `external_reward` / `externalReward`: opaque owner-defined payload, echoed byte-for-byte
 * - `query`: vote link query parameters, a data map whose keys mean what the voter sent
 */

const OPAQUE_KEYS = new Set(['external_reward', 'externalReward', 'query'])

/**
 * Keys that would reach `Object.prototype` through assignment, or shadow it. Defense in depth:
 * webhook endpoints are public URLs, so if verification is ever misconfigured or bypassed this
 * transform runs on JSON anyone on the internet sent. Such keys are dropped.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const camelToSnakeCache = new Map<string, string>()
const snakeToCamelCache = new Map<string, string>()

// Bounded so an attacker-supplied body cannot grow the memo without limit.
const MAX_CACHED_KEYS = 512

function cached(cache: Map<string, string>, key: string, convert: (key: string) => string): string {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const value = convert(key)
  if (cache.size < MAX_CACHED_KEYS) cache.set(key, value)
  return value
}

export function camelToSnakeKey(key: string): string {
  return cached(camelToSnakeCache, key, (k) => k.replace(/([A-Z])/g, '_$1').toLowerCase())
}

export function snakeToCamelKey(key: string): string {
  return cached(snakeToCamelCache, key, (k) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()))
}

function transformKeys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformKeys(item, convert))
  }
  if (value !== null && typeof value === 'object') {
    // Date and anything else with toJSON serializes the way JSON.stringify would.
    const serializable = value as { toJSON?: () => unknown }
    if (typeof serializable.toJSON === 'function') {
      return serializable.toJSON()
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) continue
      const entry = (value as Record<string, unknown>)[key]
      out[convert(key)] = OPAQUE_KEYS.has(key) ? entry : transformKeys(entry, convert)
    }
    return out
  }
  return value
}

/** Request direction: user camelCase to wire snake_case. */
export function toWire(value: unknown): unknown {
  return transformKeys(value, camelToSnakeKey)
}

/** Response direction: wire snake_case to user camelCase. */
export function fromWire(value: unknown): unknown {
  return transformKeys(value, snakeToCamelKey)
}

/** Recursive key remapping at the type level, mirroring the runtime transform. */
type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S

/** Keys the runtime passes through untouched, so their contents keep their wire shape. */
type OpaqueKey = 'external_reward' | 'externalReward' | 'query'

export type Camelize<T> = T extends readonly (infer Item)[]
  ? Camelize<Item>[]
  : T extends object
    ? { [K in keyof T as CamelCase<K & string>]: K extends OpaqueKey ? T[K] : Camelize<T[K]> }
    : T
