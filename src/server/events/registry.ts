import type { z } from 'zod'

// Event type registry (spec §10.2, §15.3: every event type the code emits has a schema). Types follow
// `<aggregate>.<past_verb>`. Each aggregate defines its events in src/server/events/schemas/<aggregate>.ts,
// imported by src/server/events/schemas.ts.

export interface EventDefinition {
  readonly type: string
  readonly aggregateType: string
  readonly schema: z.ZodType
  readonly schemaVersion: number
  /** Approval decisions must cite the DOA version and rule (INV-DOA-01) */
  readonly requiresDoaRef: boolean
}

const TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const definitions = new Map<string, EventDefinition>()

export function defineEvents(
  aggregateType: string,
  events: Record<string, { schema: z.ZodType; schemaVersion?: number; requiresDoaRef?: boolean }>,
): void {
  for (const [type, def] of Object.entries(events)) {
    if (!TYPE_PATTERN.test(type)) throw new Error(`event type "${type}" must look like <aggregate>.<past_verb>`)
    const existing = definitions.get(type)
    if (existing && existing.aggregateType !== aggregateType) {
      throw new Error(`event type "${type}" is already defined for ${existing.aggregateType}`)
    }
    definitions.set(type, {
      type,
      aggregateType,
      schema: def.schema,
      schemaVersion: def.schemaVersion ?? 1,
      requiresDoaRef: def.requiresDoaRef ?? false,
    })
  }
}

export function getEventDefinition(type: string): EventDefinition | undefined {
  return definitions.get(type)
}

export function registeredEventTypes(): string[] {
  return [...definitions.keys()].sort()
}
