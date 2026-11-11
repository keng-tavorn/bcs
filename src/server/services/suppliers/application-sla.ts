import { z } from 'zod'
import type { AppError } from '@/core/result'
import { applicationSla } from '@/core/supplier-onboarding'
import { supplierSettingsOf } from '@/lib/org-settings'
import { systemCtx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import { refusalOf, type StepRefusal } from '../sla/step-result'
import { closeAccess, missingItems, orgCodeOf, toContacts } from './applications'
import { issuePortalLink } from './links'

// The SLA of an application waiting for its supplier (S7-07 · BR-SUP ข้อ 12 · ADR-187 · FR-SUP-101 AC5): from the last
// activity, the job supplier-application-sla sleeps until remindAt and reminds the contact once per quiet spell with what
// is still missing and a new sign-in link; until escalateAt (from the invitation) and tells the inviter and PROCUREMENT at
// once, once per application; until expiresAt and lets the application expire. Every activity (an update, an upload, a
// sign-in, a return, an invitation again) moves lastActivityAt and starts a new run: a step that finds lastActivityAt
// moved answers STALE and its run ends, so only the newest run acts. A submitted, cancelled or expired application
// answers CLOSED. A step not due yet by the latest calendar answers NOT_DUE with the time left (step-result.ts).

const JOB = 'supplier-application-sla'
const WAITING: ReadonlySet<string> = new Set(['INVITED', 'DRAFT', 'RETURNED'])

type Step = 'remind' | 'escalate' | 'expire'

export interface ApplicationSlaPlan {
  readonly applicationId: string | null
  readonly status: string
  /** The activity the plan is for; a step that finds another one answers STALE */
  readonly lastActivityAt: string | null
  /** The timers still to come, in time order (remind before escalate before expire at the same time) */
  readonly timers: readonly { readonly step: Step; readonly at: string }[]
}

interface SlaRow {
  readonly invitedAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
}

/** remindAt and escalateAt by the engine and today's calendar; expiresAt as stored (an invitation again renews it) */
async function timesOf(tx: TenantTx, organizationId: string, app: SlaRow): Promise<{ remindAt: Date; escalateAt: Date; expiresAt: Date }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const sla = applicationSla({ invitedAt: app.invitedAt, lastActivityAt: app.lastActivityAt }, supplierSettingsOf(org.settings), await loadBusinessCalendar(tx, organizationId))
  return { remindAt: sla.remindAt, escalateAt: sla.escalateAt, expiresAt: app.expiresAt }
}

/** Reminded already in this quiet spell: a reminder at or after the last activity */
const remindedSince = (app: { readonly remindedAt: Date | null; readonly lastActivityAt: Date }) => app.remindedAt !== null && app.remindedAt.getTime() >= app.lastActivityAt.getTime()

/** The "ค้างเกินกำหนด" badge of /suppliers/applications: escalated and still waiting for the supplier (BR-SUP ข้อ 12) */
export const applicationOverdue = (app: { readonly status: string; readonly escalatedAt: Date | null }): boolean => app.escalatedAt !== null && WAITING.has(app.status)

const STEP_ORDER: Readonly<Record<Step, number>> = { remind: 0, escalate: 1, expire: 2 }

/** The application an event of the job's triggers is about (an upload of a supplier's own document is not one) */
export async function applicationOfTrigger(organizationId: string, name: string, payload: { readonly aggregateId: string; readonly data?: Readonly<Record<string, unknown>> }): Promise<string | null> {
  if (name.startsWith('bcs/supplier_application.')) return payload.aggregateId
  if (name === 'bcs/supplier_document.uploaded') return typeof payload.data?.applicationId === 'string' ? payload.data.applicationId : null
  if (name === 'bcs/portal_session.signed_in') {
    const contact = await forTenant(organizationId).supplierContact.findUnique({ where: { id: payload.aggregateId }, select: { applicationId: true, supplierId: true } })
    return contact && !contact.supplierId ? contact.applicationId : null
  }
  return null
}

/** The run's plan: what is still to come for the application as it stands now */
export async function planApplicationSla(organizationId: string, applicationId: string | null): Promise<ApplicationSlaPlan> {
  if (!applicationId) return { applicationId, status: 'NOT_FOUND', lastActivityAt: null, timers: [] }
  return forTenant(organizationId).$transaction(async (tx) => {
    const app = await tx.supplierApplication.findUnique({ where: { id: applicationId }, select: { status: true, invitedAt: true, lastActivityAt: true, expiresAt: true, remindedAt: true, escalatedAt: true } })
    if (!app) return { applicationId, status: 'NOT_FOUND', lastActivityAt: null, timers: [] }
    if (!WAITING.has(app.status)) return { applicationId, status: app.status, lastActivityAt: app.lastActivityAt.toISOString(), timers: [] }
    const t = await timesOf(tx, organizationId, app)
    const timers: { step: Step; at: Date }[] = []
    if (!remindedSince(app) && t.remindAt < t.expiresAt) timers.push({ step: 'remind', at: t.remindAt })
    if (!app.escalatedAt && t.escalateAt < t.expiresAt) timers.push({ step: 'escalate', at: t.escalateAt })
    timers.push({ step: 'expire', at: t.expiresAt })
    timers.sort((a, b) => a.at.getTime() - b.at.getTime() || STEP_ORDER[a.step] - STEP_ORDER[b.step])
    return { applicationId, status: app.status, lastActivityAt: app.lastActivityAt.toISOString(), timers: timers.map((x) => ({ step: x.step, at: x.at.toISOString() })) }
  })
}

// ---------- the job's command ----------

type Fail = { readonly ok: false; readonly error: AppError }
const refuse = (code: AppError['code'], reason: string, message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, details: { reason, ...details } } })
const notDue = (at: Date) => refuse('VALIDATION_FAILED', 'NOT_DUE', 'not time yet', { at: at.toISOString() })

/** The words of what is missing, for the e-mail: field names and document type names in both languages */
const FIELD_WORDS: Readonly<Record<string, { th: string; en: string }>> = {
  nameTh: { th: 'ชื่อผู้ขาย', en: 'name' },
  taxId: { th: 'เลขประจำตัวผู้เสียภาษี', en: 'taxpayer id' },
  branchCode: { th: 'รหัสสาขา', en: 'branch code' },
  address: { th: 'ที่อยู่', en: 'address' },
}

async function missingWords(tx: TenantTx, missing: readonly string[]): Promise<{ th: string[]; en: string[] }> {
  const codes = missing.filter((m) => m.startsWith('document:')).map((m) => m.slice('document:'.length))
  const types = codes.length ? await tx.supplierDocumentType.findMany({ where: { code: { in: codes } }, select: { code: true, nameTh: true, nameEn: true } }) : []
  const typeOf = new Map(types.map((t) => [t.code, t]))
  const words = missing.map((m) => {
    if (!m.startsWith('document:')) return FIELD_WORDS[m] ?? { th: m, en: m }
    const t = typeOf.get(m.slice('document:'.length))
    return { th: t?.nameTh ?? m, en: t?.nameEn ?? t?.nameTh ?? m }
  })
  return { th: words.map((w) => w.th), en: words.map((w) => w.en) }
}

const SlaInput = z.strictObject({ applicationId: z.uuid(), step: z.enum(['remind', 'escalate', 'expire']), lastActivityAt: z.iso.datetime({ offset: true }) })

export const applicationSlaCommand = defineCommand({
  name: 'supplierApplication.sla',
  capability: 'system.supplierApplications',
  input: SlaInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ step: Step }>> {
    if (ctx.actor.type !== 'SYSTEM') return refuse('FORBIDDEN', 'SYSTEM_ONLY', 'only the SLA job runs this')
    await lockRowsForUpdate(tx, 'SupplierApplication', ctx.organizationId, [input.applicationId])
    const app = await tx.supplierApplication.findUnique({ where: { id: input.applicationId } })
    if (!app) return refuse('NOT_FOUND', 'NOT_FOUND', 'application not found')
    if (!WAITING.has(app.status)) return refuse('INVALID_STATE_TRANSITION', 'CLOSED', 'the application is not waiting for its supplier', { status: app.status })
    if (app.lastActivityAt.getTime() !== new Date(input.lastActivityAt).getTime()) return refuse('INVALID_STATE_TRANSITION', 'STALE', 'the application moved since the plan: a newer run owns it')
    const t = await timesOf(tx, ctx.organizationId, app)
    const subject = { subjectType: 'SupplierApplication', subjectId: app.id }

    if (input.step === 'remind') {
      if (remindedSince(app)) return refuse('INVALID_STATE_TRANSITION', 'ALREADY', 'reminded already since the last activity')
      if (t.remindAt >= t.expiresAt) return refuse('INVALID_STATE_TRANSITION', 'PAST_EXPIRY', 'the application expires first')
      if (ctx.now < t.remindAt) return notDue(t.remindAt)
      const contact = await tx.supplierContact.findFirst({ where: { applicationId: app.id, status: 'ACTIVE', isPrimary: true }, select: { id: true } })
      if (!contact) return refuse('VALIDATION_FAILED', 'NO_CONTACT', 'the application has no contact to remind')
      // an invitation of a registered supplier has nothing to fill in: it waits for the first sign-in only
      const missing = app.kind === 'NEW' ? await missingItems(tx, app) : []
      const words = await missingWords(tx, missing)
      const link = await issuePortalLink(tx, { organizationId: ctx.organizationId, orgCode: await orgCodeOf(tx, ctx.organizationId), contactId: contact.id, purpose: 'LOGIN', now: ctx.now, applicationId: app.id, emailedForLater: true })
      const notice = await enqueueSupplierNotice(tx, ctx, {
        templateKey: PORTAL_SUPPLIER_TEMPLATES.applicationReminder,
        contactId: contact.id,
        applicationId: app.id,
        ...subject,
        dedupeKey: `${PORTAL_SUPPLIER_TEMPLATES.applicationReminder}:${app.id}:${input.lastActivityAt}`,
        data: { url: link.url, expiresAt: link.expiresAt.toISOString(), applicationExpiresAt: t.expiresAt.toISOString(), missingTh: words.th, missingEn: words.en },
      })
      await tx.supplierApplication.update({ where: { id: app.id }, data: { remindedAt: ctx.now } })
      return {
        ok: true,
        result: { step: 'remind' },
        events: [{ type: 'supplier_application.reminded', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { missing, linkId: link.linkId } }, ...notice.events],
        notifications: notice.notifications,
        outbox: notice.outbox,
      }
    }

    if (input.step === 'escalate') {
      if (app.escalatedAt) return refuse('INVALID_STATE_TRANSITION', 'ALREADY', 'escalated already')
      if (ctx.now < t.escalateAt) return notDue(t.escalateAt)
      const procurement = await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'], orderBy: { memberId: 'asc' } })
      const inviter = app.invitedById ? await tx.member.findFirst({ where: { id: app.invitedById, status: 'ACTIVE' }, select: { id: true } }) : null
      const notified = [...new Set([...(inviter ? [inviter.id] : []), ...procurement.map((p) => p.memberId)])]
      const notifications: NotificationDraft[] = notified.map((memberId) => ({
        recipientMemberId: memberId,
        templateKey: 'supplier.application_escalated',
        // a sole proprietor is never named (BR-NOTI ข้อ 10)
        data: { applicationId: app.id, number: app.number, nameTh: app.payeeType === 'INDIVIDUAL' ? null : app.nameTh, role: memberId === inviter?.id ? 'INVITER' : 'PROCUREMENT' },
        urgency: 'IMMEDIATE',
        dedupeKey: `supplier.application_escalated:${app.id}:${memberId}`,
        ...subject,
      }))
      await tx.supplierApplication.update({ where: { id: app.id }, data: { escalatedAt: ctx.now } })
      return { ok: true, result: { step: 'escalate' }, events: [{ type: 'supplier_application.escalated', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { notified } }], notifications }
    }

    if (ctx.now < t.expiresAt) return notDue(t.expiresAt)
    await tx.supplierApplication.update({ where: { id: app.id }, data: { status: 'EXPIRED', version: { increment: 1 } } })
    const told = await toContacts(tx, ctx, app.id, PORTAL_SUPPLIER_TEMPLATES.applicationExpired, `expired:${app.expiresAt.toISOString()}`, { number: app.number })
    return {
      ok: true,
      result: { step: 'expire' },
      events: [{ type: 'supplier_application.expired', aggregateType: 'SupplierApplication', aggregateId: app.id, data: { number: app.number } }, ...(await closeAccess(tx, ctx, app.id)), ...told.events],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

export type ApplicationSlaStepResult = { readonly done: true; readonly reason?: null; readonly waitMs?: null } | StepRefusal

/** One step of the job; the idempotency key is the step's and the activity's (docs/sub-specs/S7.md "job Inngest ใหม่") */
export async function applicationSlaStep(organizationId: string, applicationId: string, step: Step, lastActivityAt: string, now: Date): Promise<ApplicationSlaStepResult> {
  const r = await runCommand(systemCtx(organizationId, now, JOB), applicationSlaCommand, { applicationId, step, lastActivityAt }, { idempotencyKey: `${JOB}:${step}:${applicationId}:${lastActivityAt}` })
  return r.ok ? { done: true } : refusalOf(r.error, now)
}
