// JSON helpers. JSON.stringify throws on BigInt, and money is BigInt everywhere (ADR-018), so every value that
// leaves the process (Event.data, Outbox payloads, Inngest events, API bodies, logs) goes through toJsonSafe.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Deep copy that gives exactly what JSON.parse(JSON.stringify(value)) gives, except that BigInt becomes a
 * decimal string instead of throwing: toJSON() is honoured (Date → ISO string or null, decimal.js and
 * Prisma.Decimal → their decimal string), NaN/±Infinity → null, undefined/function/symbol fields dropped
 * (null inside arrays and at the top level). A cycle throws a TypeError, as JSON.stringify does.
 */
export function toJsonSafe(value: unknown): JsonValue {
  return property(value, new Set()) ?? null
}

/** One property value as JSON.stringify serializes it; undefined = no JSON value (the field is dropped). */
function property(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  if (typeof value === 'object' && value !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON
    // Called once, like JSON.stringify: an object returned by toJSON() is serialized as it is
    if (typeof toJSON === 'function') return serialize(toJSON.call(value), ancestors)
  }
  return serialize(value, ancestors)
}

function serialize(value: unknown, ancestors: Set<object>): JsonValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      return undefined // undefined, function, symbol
  }
  if (value === null) return null
  if (value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt) {
    return serialize(value.valueOf(), ancestors)
  }
  if (ancestors.has(value)) throw new TypeError('toJsonSafe: cyclic structure')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return Array.from(value, (item: unknown) => property(item, ancestors) ?? null)
    const out: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) {
      const json = property(item, ancestors)
      // defineProperty: a "__proto__" key from parsed input stays data instead of replacing the prototype
      if (json !== undefined) Object.defineProperty(out, key, { value: json, enumerable: true, writable: true, configurable: true })
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

type JsonPrimitive = string | number | boolean | null
type Callable = (...args: never[]) => unknown

/**
 * The static type of toJsonSafe(value) for a value of type T, i.e. what a caller really receives after a
 * JSON round trip (CommandLog replay, Event.data, API body): bigint and Date become string, objects with
 * toJSON() become what it returns (Decimal → string).
 */
export type Jsonified<T> = 0 extends 1 & T
  ? JsonValue
  : unknown extends T
    ? JsonValue
    : T extends JsonPrimitive
      ? T
      : T extends bigint
        ? string
        : T extends undefined | symbol | Callable
          ? null
          : T extends { toJSON(): infer J }
            ? Jsonified<J>
            : T extends readonly unknown[]
              ? { -readonly [K in keyof T]: Jsonified<T[K]> }
              : { [K in keyof T]: JsonifiedField<T[K]> }

/** Object fields: undefined and functions are dropped, so they read back as undefined. */
type JsonifiedField<T> = T extends undefined | Callable ? undefined : Jsonified<T>

/** Deterministic serialization (keys sorted) — used for idempotency input hashes. */
export function stableStringify(value: unknown): string {
  const sortKeys = (v: JsonValue): JsonValue => {
    if (Array.isArray(v)) return v.map(sortKeys)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, JsonValue>)[k]!)]))
    }
    return v
  }
  return JSON.stringify(sortKeys(toJsonSafe(value)))
}
