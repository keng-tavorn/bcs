import { jsonSchema, zodSchema, type Schema } from 'ai'
import type { z } from 'zod'

// The structured output as it travels to the API (S13-13). The Messages API compiles the output schema and refuses one
// with more than 16 parameters of a union type (`["string","null"]` counts as one), which the Document Agent's reading
// passes (17). So every nullable text field travels as a plain string where "" means none or not shown, and the answer
// turns "" back into null at exactly those fields before the Zod schema of the purpose checks it. Other unions (a
// nullable yes/no) travel as they are. The prompts say the same (QUOTATION_READ@2 and the others of S13-13).

type Json = Record<string, unknown>

/** How to bring one node of an answer back: a text that may be null, an object, an array, or as it is */
type Restore = { readonly kind: 'text' } | { readonly kind: 'object'; readonly props: ReadonlyMap<string, Restore> } | { readonly kind: 'array'; readonly items: Restore } | null

const NONE_NOTE = 'An empty string "" means none or not shown.'

// Free text only: a nullable enum or const keeps its null ("" would be no member of it)
const isNullableText = (node: Json) =>
  Array.isArray(node.type) && node.type.length === 2 && node.type.includes('string') && node.type.includes('null') && node.enum === undefined && node.const === undefined

function toWire(node: Json): { wire: Json; restore: Restore } {
  if (isNullableText(node)) {
    const description = typeof node.description === 'string' ? `${node.description} ${NONE_NOTE}` : NONE_NOTE
    return { wire: { ...node, type: 'string', description }, restore: { kind: 'text' } }
  }
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    const props = new Map<string, Restore>()
    const wireProps: Json = {}
    for (const [key, child] of Object.entries(node.properties as Record<string, Json>)) {
      const r = toWire(child)
      wireProps[key] = r.wire
      props.set(key, r.restore)
    }
    return { wire: { ...node, properties: wireProps }, restore: { kind: 'object', props } }
  }
  if (node.type === 'array' && node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
    const r = toWire(node.items as Json)
    return { wire: { ...node, items: r.wire }, restore: { kind: 'array', items: r.restore } }
  }
  return { wire: node, restore: null }
}

function restoreNulls(value: unknown, plan: Restore): unknown {
  if (plan === null) return value
  if (plan.kind === 'text') return value === '' ? null : value
  if (plan.kind === 'array') return Array.isArray(value) ? value.map((v) => restoreNulls(v, plan.items)) : value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreNulls(v, plan.props.get(k) ?? null)]))
}

/** The JSON schema the API receives for a Zod schema, and the function that turns its answer back */
export async function wireOf(schema: z.ZodType): Promise<{ readonly wire: Json; readonly restore: (value: unknown) => unknown }> {
  const { wire, restore } = toWire((await zodSchema(schema).jsonSchema) as Json)
  return { wire, restore: (value) => restoreNulls(value, restore) }
}

/** Parameters of a union type in a JSON schema, as the API counts them (a type list or anyOf) */
export function unionParameters(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0
  const n = node as Json
  const own = (Array.isArray(n.type) && n.type.length > 1) || Array.isArray(n.anyOf) ? 1 : 0
  const children = [
    ...(n.properties && typeof n.properties === 'object' ? Object.values(n.properties) : []),
    ...(n.items ? [n.items] : []),
    ...(Array.isArray(n.anyOf) ? n.anyOf : []),
  ]
  return own + children.reduce<number>((sum, c) => sum + unionParameters(c), 0)
}

// The schemas are a few module constants: each converts once
const cache = new WeakMap<z.ZodType, Schema<unknown>>()

/** The AI SDK schema of a request: the wire schema to send, and the Zod schema to check what came back */
export async function wireSchema<T>(schema: z.ZodType<T>): Promise<Schema<T>> {
  const hit = cache.get(schema)
  if (hit) return hit as Schema<T>
  const built = await buildWireSchema(schema)
  cache.set(schema, built as Schema<unknown>)
  return built
}

async function buildWireSchema<T>(schema: z.ZodType<T>): Promise<Schema<T>> {
  const { wire, restore } = await wireOf(schema)
  return jsonSchema<T>(wire, {
    validate: (value) => {
      const parsed = schema.safeParse(restore(value))
      return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error }
    },
  })
}
