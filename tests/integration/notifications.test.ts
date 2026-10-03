import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { defineEvents } from '@/server/events/registry'
import { createNotifications, type NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome } from '@/server/services/_pipeline'
import { createMember, createOrg } from '../support/factory'

// Notifications are written in the command's transaction (spec §4.7). dedupeKey is unique per organization
// so a retried job does not notify twice (rule 4, FR-NOTI-001 AC2) — a duplicate is skipped, never an error.

defineEvents('NotifyProbe', {
  'notify_probe.touched': { schema: z.object({ label: z.string() }) },
})

/** Resolves for everyone once n callers have arrived: both transactions are open before either inserts. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  return async () => {
    arrived++
    if (arrived >= n) release()
    await all
  }
}

let arrive: () => Promise<void> = async () => {}

const touch = defineCommand({
  name: 'test.notify_touch',
  capability: 'test.notify_touch',
  input: z.object({ memberId: z.uuid(), recipientId: z.uuid(), dedupeKey: z.string(), label: z.string() }),
  async execute(tx, input): Promise<CommandOutcome<{ label: string }>> {
    // Each command changes its own aggregate, so the two share no row lock
    await tx.member.update({ where: { id: input.memberId }, data: { displayNameEn: input.label } })
    await arrive()
    return {
      ok: true,
      result: { label: input.label },
      events: [{ type: 'notify_probe.touched', aggregateType: 'NotifyProbe', aggregateId: input.memberId, data: { label: input.label } }],
      notifications: [{ recipientMemberId: input.recipientId, templateKey: 'test.touched', data: { label: input.label }, urgency: 'IMMEDIATE', dedupeKey: input.dedupeKey }],
    }
  },
})

const NOW = new Date('2026-10-05T03:00:00Z')

function queuedFor(organizationId: string) {
  return prisma.outbox.findMany({ where: { organizationId, eventName: 'bcs/notification.requested' } })
}

describe('[FR-NOTI-001/AC2] dedupeKey skips a duplicate notification instead of failing the command', () => {
  it('lets two commands that notify with the same dedupeKey at the same time both commit; one notification is written and queued', async () => {
    const org = await createOrg()
    const recipient = await createMember(org.id, 'ผู้รับ')
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'SYSTEM' }, channel: 'SYSTEM', now: NOW })
    for (let trial = 0; trial < 5; trial++) {
      const [m1, m2] = [await createMember(org.id), await createMember(org.id)]
      const dedupeKey = `request:${randomUUID()}:approved`
      arrive = barrier(2)
      const results = await Promise.all([
        runCommand(ctx, touch, { memberId: m1.id, recipientId: recipient.id, dedupeKey, label: `A-${trial}` }, { idempotencyKey: randomUUID(), sender: null }),
        runCommand(ctx, touch, { memberId: m2.id, recipientId: recipient.id, dedupeKey, label: `B-${trial}` }, { idempotencyKey: randomUUID(), sender: null }),
      ])
      expect(results).toEqual([
        { ok: true, data: { label: `A-${trial}` } },
        { ok: true, data: { label: `B-${trial}` } },
      ])
      // Both business changes committed
      expect((await prisma.member.findUniqueOrThrow({ where: { id: m1.id } })).displayNameEn).toBe(`A-${trial}`)
      expect((await prisma.member.findUniqueOrThrow({ where: { id: m2.id } })).displayNameEn).toBe(`B-${trial}`)
      const rows = await prisma.notification.findMany({ where: { organizationId: org.id, dedupeKey } })
      expect(rows).toHaveLength(1)
      const queued = (await queuedFor(org.id)).filter((q) => (q.payload as { notificationId: string }).notificationId === rows[0]!.id)
      expect(queued).toHaveLength(1)
    }
    arrive = async () => {}
  })

  it('queues only the IMMEDIATE notifications actually inserted, and one per dedupeKey within a batch', async () => {
    const org = await createOrg()
    const recipient = await createMember(org.id)
    const draft = (dedupeKey: string, urgency: NotificationDraft['urgency']): NotificationDraft => ({
      recipientMemberId: recipient.id,
      templateKey: 'test.touched',
      data: {},
      urgency,
      dedupeKey,
    })
    const db = forTenant(org.id)
    const first = await db.$transaction((tx) => createNotifications(tx, org.id, [draft('old', 'IMMEDIATE')]))
    expect(first).toHaveLength(1)
    const drafts = await db.$transaction((tx) =>
      createNotifications(tx, org.id, [draft('old', 'IMMEDIATE'), draft('new', 'IMMEDIATE'), draft('new', 'IMMEDIATE'), draft('digest', 'DIGEST')]),
    )
    const rows = await prisma.notification.findMany({ where: { organizationId: org.id } })
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(['digest', 'new', 'old'])
    const fresh = rows.find((r) => r.dedupeKey === 'new')!
    expect(drafts).toEqual([{ eventName: 'bcs/notification.requested', payload: { notificationId: fresh.id, organizationId: org.id } }])
  })
})
