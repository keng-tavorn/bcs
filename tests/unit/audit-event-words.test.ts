import { describe, expect, it } from 'vitest'
import { getEventDefinition, registeredEventTypes } from '@/server/events/registry'
import '@/server/events/schemas'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-VIS-004 AC1 · spec §9.9 (no English codes in the words people read): the audit page offers every registered event
// type in its type list, grouped by the part before the dot, and names each row's event — and, for an event about no
// document of its own, what it is about (its aggregate). Where no words are written the page falls back to the code
// itself (src/app/(workspace)/audit/_present.ts eventLabel, page.tsx groups), so the list once offered
// "approval_task.overdue" under a group "line". Every type the registry holds, its group and its aggregate must have
// words in Thai and in English: a new event type fails here until it has them.

interface AuditWords {
  readonly events: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly groups: Readonly<Record<string, string>>
  readonly aggregate: Readonly<Record<string, string>>
}

const CATALOGUES: ReadonlyArray<readonly [string, AuditWords]> = [
  ['th', th.audit],
  ['en', en.audit],
]

const types = registeredEventTypes()

/** Words are written for the key (an English word may be spelled like its aggregate's code, as Member is) */
const named = (words: string | undefined) => Boolean(words?.trim())

describe('[FR-VIS-004/AC1] the audit page names every event type, its group and its aggregate in words, never by its code', () => {
  it('reads the registry of every event the code writes', () => {
    // the schemas registered their events: the types the SLA job, the PIN, the LINE link and the daily summary write too
    expect(types.length).toBeGreaterThan(90)
    expect(types).toEqual(expect.arrayContaining(['approval_task.overdue', 'approval_task.escalated', 'auth.pin_set', 'security.pin_locked', 'line.linked', 'notification.digest_sent']))
  })

  it.each(CATALOGUES)('every registered event type, its group and its aggregate have words in %s', (_locale, audit) => {
    const missing = new Set<string>()
    for (const type of types) {
      const [group, verb] = type.split('.') as [string, string]
      if (!named(audit.events[group]?.[verb])) missing.add(`events.${type}`)
      if (!named(audit.groups[group])) missing.add(`groups.${group}`)
      const aggregate = getEventDefinition(type)!.aggregateType
      if (!named(audit.aggregate[aggregate])) missing.add(`aggregate.${aggregate}`)
    }
    expect([...missing]).toEqual([])
  })
})
