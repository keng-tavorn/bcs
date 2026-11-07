import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ManualClock } from '@/lib/clock'
import { makeCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import type { TimerStep } from '@/server/jobs/approval-task-sla'
import { supplierApplicationSlaHandler } from '@/server/jobs/supplier-application-sla'
import { runCommand } from '@/server/services/_pipeline'
import { applicationOfTrigger, applicationOverdue, applicationSlaCommand, applicationSlaStep, planApplicationSla } from '@/server/services/suppliers/application-sla'
import { applicationSignedIn, cancelApplication, inviteSupplier, updateApplication } from '@/server/services/suppliers/applications'
import { portalCtx } from '@/server/portal/session'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S7-07 (BR-SUP ข้อ 12 · ADR-187 · FR-SUP-101 AC5 · GC-SUP-26 GC-SUP-29 GC-SUP-51): the job supplier-application-sla on a
// fake Inngest step and an injected clock. Scene 2 of Demo_Script_P2: invited Friday 9 Oct 2026 10:00 Thai time, half
// filled in (the VAT certificate and the bank book page missing), nothing more → reminded Thursday 15 Oct 10:00 (3
// business days, 13 Oct a holiday), escalated Tuesday 27 Oct 10:00 (10 business days, 23 Oct a holiday too) to the
// inviter and PROCUREMENT at once, EXPIRED Sunday 8 Nov 10:00 (30 days) with an e-mail to the supplier.

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const INVITED = new Date('2026-10-09T03:00:00Z')

let org: DoaOrg

function taxId(): string {
  const digits = Array.from({ length: 12 }, (_, i) => (i === 0 ? 0 : Math.floor(Math.random() * 10)))
  const sum = digits.reduce((s, d, i) => s + d * (13 - i), 0)
  return digits.join('') + String((11 - (sum % 11)) % 10)
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.asst_con!, role: 'PROCUREMENT', grantedAt: INVITED } })
  await prisma.supplierDocumentType.createMany({
    data: [
      { organizationId: org.organizationId, code: 'COMPANY_CERT', nameTh: 'หนังสือรับรองบริษัท', nameEn: 'Company certificate', appliesTo: ['JURISTIC'], required: true, validityDays: 180 },
      { organizationId: org.organizationId, code: 'VAT_CERT', nameTh: 'ภ.พ.20', nameEn: 'VAT registration (Por Por 20)', appliesTo: ['JURISTIC'], required: true },
      { organizationId: org.organizationId, code: 'BANK_BOOK', nameTh: 'หน้าสมุดบัญชี', nameEn: 'Bank book page', appliesTo: ['JURISTIC'], required: true },
    ],
  })
})

const contactCtx = (contact: { id: string; applicationId: string | null; supplierId: string | null }, now: Date): Ctx => portalCtx(org.organizationId, contact, now)
const version = async (id: string) => (await prisma.supplierApplication.findUniqueOrThrow({ where: { id } })).version

/** Invited at `at` by proc_officer; its contact signs in and fills in the address; the company certificate is there */
async function halfFilled(at = INVITED) {
  const r = await inviteSupplier(
    org.ctxOf('proc_officer', at),
    { kind: 'NEW', nameTh: `หจก. บ้านโป่ง ${randomUUID().slice(0, 6)}`, taxId: taxId(), branchCode: '00000', payeeType: 'JURISTIC', contact: { nameTh: 'ผู้ติดต่อ', email: `sla-${randomUUID().slice(0, 8)}@supplier.test` } },
    key(),
  )
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  const contact = await prisma.supplierContact.findUniqueOrThrow({ where: { id: r.data.contactId } })
  await forTenant(org.organizationId).$transaction((tx) => applicationSignedIn(tx, contactCtx(contact, at), contact))
  const u = await updateApplication(contactCtx(contact, at), { applicationId: r.data.applicationId, expectedVersion: await version(r.data.applicationId), fields: { address: '9 ถนนเพชรเกษม บ้านโป่ง ราชบุรี' } }, key())
  if (!u.ok) throw new Error(JSON.stringify(u.error))
  const f = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'cert.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE' } })
  await prisma.supplierDocument.create({ data: { organizationId: org.organizationId, applicationId: r.data.applicationId, documentTypeCode: 'COMPANY_CERT', fileId: f.id, issuedOn: new Date('2026-10-01'), expiresOn: new Date('2027-03-29') } })
  return { applicationId: r.data.applicationId, contact }
}

/** A fake Inngest step on the fake clock: sleepUntil moves the clock; `beforeSleep` acts before a sleep */
function fakeStep(clock: ManualClock, beforeSleep?: (id: string) => Promise<void>) {
  const sleeps: string[] = []
  const step: TimerStep = {
    run: async (_id, fn) => fn(),
    sleepUntil: async (id, until) => {
      sleeps.push(`${id} ${new Date(until).toISOString()}`)
      if (beforeSleep) await beforeSleep(id)
      if (new Date(until).getTime() > clock.now().getTime()) clock.set(new Date(until))
    },
    sleep: async (id, ms) => {
      sleeps.push(`${id} ${ms}`)
      clock.advance(ms)
    },
  }
  return { step, sleeps }
}

const updated = (applicationId: string) => ({ name: 'bcs/supplier_application.updated', data: { organizationId: org.organizationId, aggregateId: applicationId, data: {} } })
const eventsOf = (type: string, aggregateId: string) => prisma.event.findMany({ where: { type, aggregateId }, orderBy: { occurredAt: 'asc' } })

describe('[FR-SUP-101/AC5] an application left half filled in is reminded, escalated and expires (scene 2 · GC-SUP-26)', () => {
  it('reminds 15 Oct 10:00 with the two documents missing and a new link, tells the inviter and PROCUREMENT at once 27 Oct 10:00, expires 8 Nov 10:00', async () => {
    const a = await halfFilled()
    const clock = new ManualClock(INVITED)
    let overdueBeforeExpiry: boolean | null = null
    const { step, sleeps } = fakeStep(clock, async (id) => {
      if (id === 'until-expire') overdueBeforeExpiry = applicationOverdue(await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } }))
    })
    const run = await supplierApplicationSlaHandler(clock)(updated(a.applicationId), step)

    expect(sleeps).toEqual(['until-remind 2026-10-15T03:00:00.000Z', 'until-escalate 2026-10-27T03:00:00.000Z', 'until-expire 2026-11-08T03:00:00.000Z'])
    expect(run).toEqual({ applicationId: a.applicationId, done: ['remind', 'escalate', 'expire'], stopped: null })

    // the reminder: what is missing, by name, and a sign-in link that lives as an invitation does
    const [reminded] = await eventsOf('supplier_application.reminded', a.applicationId)
    expect(reminded!.data).toMatchObject({ missing: ['document:BANK_BOOK', 'document:VAT_CERT'] })
    const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { applicationId: a.applicationId, templateKey: 'supplier.application_reminder' } })
    expect(notice).toMatchObject({ contactId: a.contact.id, supplierId: null })
    expect(notice.data).toMatchObject({ missingTh: ['หน้าสมุดบัญชี', 'ภ.พ.20'], missingEn: ['Bank book page', 'VAT registration (Por Por 20)'], applicationExpiresAt: '2026-11-08T03:00:00.000Z' })
    const link = await prisma.portalInviteLink.findUniqueOrThrow({ where: { id: (reminded!.data as { linkId: string }).linkId } })
    expect(link).toMatchObject({ purpose: 'LOGIN', contactId: a.contact.id, applicationId: a.applicationId })
    expect(link.expiresAt.toISOString()).toBe('2026-10-22T03:00:00.000Z')

    // the escalation: the inviter and every PROCUREMENT member, IMMEDIATE, once; the badge shows until it expires
    const [escalated] = await eventsOf('supplier_application.escalated', a.applicationId)
    expect(new Set((escalated!.data as { notified: string[] }).notified)).toEqual(new Set([org.member.proc_officer, org.member.asst_con]))
    const told = await prisma.notification.findMany({ where: { subjectId: a.applicationId, templateKey: 'supplier.application_escalated' } })
    expect(told.map((n) => n.urgency)).toEqual(['IMMEDIATE', 'IMMEDIATE'])
    expect(new Set(told.map((n) => n.recipientMemberId))).toEqual(new Set([org.member.proc_officer, org.member.asst_con]))
    expect(overdueBeforeExpiry).toBe(true)

    // the expiry: EXPIRED, the links unused stop working, the supplier hears it may ask for a new one
    const app = await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })
    expect(app).toMatchObject({ status: 'EXPIRED' })
    expect(app.remindedAt?.toISOString()).toBe('2026-10-15T03:00:00.000Z')
    expect(app.escalatedAt?.toISOString()).toBe('2026-10-27T03:00:00.000Z')
    expect(applicationOverdue(app)).toBe(false)
    expect(await eventsOf('supplier_application.expired', a.applicationId)).toHaveLength(1)
    expect(await prisma.supplierNotice.count({ where: { applicationId: a.applicationId, templateKey: 'supplier.application_expired', contactId: a.contact.id } })).toBe(1)
    expect(await prisma.portalInviteLink.count({ where: { applicationId: a.applicationId, usedAt: null, revokedAt: null } })).toBe(0)

    // a second run of the same activity repeats nothing (the application is closed)
    expect(await supplierApplicationSlaHandler(new ManualClock('2026-11-09T00:00:00Z'))(updated(a.applicationId), fakeStep(clock).step)).toMatchObject({ done: [], stopped: 'EXPIRED' })
  })

  it('GC-SUP-29 · GC-SUP-51: activity after the escalation reminds again from it but never escalates twice; the older run ends STALE', async () => {
    const a = await halfFilled()
    const clock = new ManualClock(INVITED)
    const later = new Date('2026-10-28T02:00:00Z')
    // the supplier comes back 28 Oct 09:00, after the escalation, before the old run's expiry
    const first = fakeStep(clock, async (id) => {
      if (id !== 'until-expire') return
      const u = await updateApplication(contactCtx(a.contact, later), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), fields: { phone: '032-211-000' } }, key())
      if (!u.ok) throw new Error(JSON.stringify(u.error))
    })
    expect(await supplierApplicationSlaHandler(clock)(updated(a.applicationId), first.step)).toEqual({ applicationId: a.applicationId, done: ['remind', 'escalate'], stopped: 'STALE' })
    expect((await prisma.supplierApplication.findUniqueOrThrow({ where: { id: a.applicationId } })).status).toBe('DRAFT')

    // the run of the new activity: reminded again Monday 2 Nov 09:00, no second escalation, expires 8 Nov as before
    const clock2 = new ManualClock(later)
    const second = fakeStep(clock2)
    const plan = await planApplicationSla(org.organizationId, a.applicationId)
    expect(plan.timers).toEqual([
      { step: 'remind', at: '2026-11-02T02:00:00.000Z' },
      { step: 'expire', at: '2026-11-08T03:00:00.000Z' },
    ])
    expect(await supplierApplicationSlaHandler(clock2)(updated(a.applicationId), second.step)).toMatchObject({ done: ['remind', 'expire'], stopped: null })
    expect(await eventsOf('supplier_application.reminded', a.applicationId)).toHaveLength(2)
    expect(await eventsOf('supplier_application.escalated', a.applicationId)).toHaveLength(1)
  })

  it('a step of an old activity answers STALE; a step before its time NOT_DUE with the time left; a cancelled application CLOSED', async () => {
    const a = await halfFilled()
    expect(await applicationSlaStep(org.organizationId, a.applicationId, 'remind', '2026-10-01T00:00:00.000Z', new Date('2026-10-20T00:00:00Z'))).toMatchObject({ done: false, reason: 'STALE' })
    const noon = new Date('2026-10-15T02:00:00Z')
    expect(await applicationSlaStep(org.organizationId, a.applicationId, 'remind', INVITED.toISOString(), noon)).toMatchObject({ done: false, reason: 'NOT_DUE', notBefore: '2026-10-15T03:00:00.000Z', waitMs: 3_600_000 })
    const c = await cancelApplication(org.ctxOf('proc_officer', noon), { applicationId: a.applicationId, expectedVersion: await version(a.applicationId), reason: 'ผู้ขายไม่สนใจแล้ว' }, key())
    expect(c.ok).toBe(true)
    expect(await applicationSlaStep(org.organizationId, a.applicationId, 'expire', INVITED.toISOString(), new Date('2026-11-09T00:00:00Z'))).toMatchObject({ done: false, reason: 'CLOSED' })
    expect((await planApplicationSla(org.organizationId, a.applicationId)).timers).toEqual([])
  })

  it('only the job runs the command: a member is FORBIDDEN', async () => {
    const a = await halfFilled()
    const r = await runCommand(org.ctxOf('proc_officer', new Date('2026-10-20T00:00:00Z')), applicationSlaCommand, { applicationId: a.applicationId, step: 'remind', lastActivityAt: INVITED.toISOString() }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'SYSTEM_ONLY' } } })
    const portal = makeCtx({ organizationId: org.organizationId, actor: { type: 'SUPPLIER', supplierContactId: a.contact.id, applicationId: a.applicationId }, channel: 'PORTAL', now: new Date('2026-10-20T00:00:00Z') })
    expect(await runCommand(portal, applicationSlaCommand, { applicationId: a.applicationId, step: 'expire', lastActivityAt: INVITED.toISOString() }, key())).toMatchObject({ ok: false })
  })

  it('the triggers: an upload or a sign-in of the application starts a run for it; a registered supplier\'s upload does not', async () => {
    const a = await halfFilled()
    expect(await applicationOfTrigger(org.organizationId, 'bcs/supplier_document.uploaded', { aggregateId: randomUUID(), data: { applicationId: a.applicationId, supplierId: null } })).toBe(a.applicationId)
    expect(await applicationOfTrigger(org.organizationId, 'bcs/supplier_document.uploaded', { aggregateId: randomUUID(), data: { applicationId: null, supplierId: randomUUID() } })).toBeNull()
    expect(await applicationOfTrigger(org.organizationId, 'bcs/portal_session.signed_in', { aggregateId: a.contact.id, data: {} })).toBe(a.applicationId)
    expect(await applicationOfTrigger(org.organizationId, 'bcs/supplier_application.invited', { aggregateId: a.applicationId })).toBe(a.applicationId)
    const ignored = await supplierApplicationSlaHandler(new ManualClock(INVITED))({ name: 'bcs/supplier_document.uploaded', data: { organizationId: org.organizationId, aggregateId: randomUUID(), data: { applicationId: null } } }, fakeStep(new ManualClock(INVITED)).step)
    expect(ignored).toMatchObject({ applicationId: null, done: [] })
  })
})
