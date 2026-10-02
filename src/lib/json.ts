// JSON helpers. JSON.stringify throws on BigInt, and money is BigInt everywhere (ADR-018), so every value that
// leaves the process (Event.data, Outbox payloads, Inngest events, API bodies, logs) goes through toJsonSafe.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Deep copy with BigInt → decimal string, Date → ISO string, undefined object fields dropped. */
export function toJsonSafe(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : toJsonSafe(v)))
  if (typeof value === 'object') {
    const out: { [key: string]: JsonValue } = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined && typeof v !== 'function') out[k] = toJsonSafe(v)
    }
    return out
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  return null
}

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
