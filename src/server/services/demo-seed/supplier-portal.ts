import { TZDate } from '@date-fns/tz'
import { addBusinessMinutes, businessMinutesBetween } from '@/core/sla'
import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { makeCtx, type Ctx } from '@/server/context'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { dayIn, documentPdf, inYears, seedContactSignedIn, seedRegistryProof, seedSupplierDocuments, type SupplierPortalSheets } from '@/server/seed/supplier-portal'
import type { RunOptions } from '../_pipeline'
import { decideTask } from '../approvals/decide'
import { applicationSlaStep, planApplicationSla } from '../suppliers/application-sla'
import { applicationSignedIn, inviteSupplier, requiredTypes, returnApplication, submitApplication, updateApplication, verifyAndRoute } from '../suppliers/applications'
import { scanFile, uploadSupplierDocument, verifySupplierDocument } from '../suppliers/documents'

// The history of the supplier portal of the phase-1 organization (S7-13): the documents on file (src/server/seed), then
// the applications of sheet Supplier_Applications played with the real commands back in time — invited at 10:00 of the
// business day invitedDaysAgo days back, an approved one decided exactly expectedG7Days business days later (BR-SUP ข้อ 13),
// a waiting one taken through the steps of its SLA that fell due (job supplier-application-sla's own command). Nothing is
// sent for the past (suppressOutbox). A second run adds nothing.

export interface SupplierPortalHistoryReport {
  readonly seeded: boolean
  readonly documents: number
  readonly applications: Readonly<Record<string, number>>
}

export async function seedSupplierPortalHistory(organizationId: string, sheets: SupplierPortalSheets, now: Date): Promise<SupplierPortalHistoryReport> {
  const db = forTenant(organizationId)
  const calendar = await db.$transaction((tx) => loadBusinessCalendar(tx, organizationId))
  const members = new Map((await db.member.findMany({ select: { id: true, employeeCode: true } })).filter((m) => m.employeeCode).map((m) => [m.employeeCode!, m.id]))
  const memberOf = (code: string | null, where: string) => {
    const id = code ? members.get(code) : undefined
    if (!id) throw new Error(`${where}: ไม่มีผู้ใช้ ${code ?? '(ว่าง)'} · แก้ scripts/inputs_p1/p1_suppliers_portal.py`)
    return id
  }
  const documents = await seedSupplierDocuments(organizationId, sheets, now, calendar.timezone, memberOf)
  const applications: Record<string, number> = {}
  const taxIds = sheets.applications.map((a) => a.taxId)
  if ((await db.supplierApplication.count({ where: { taxId: { in: taxIds } } })) === 0) {
    for (const row of sheets.applications) {
      await playApplication(organizationId, row, now, calendar, memberOf)
      applications[row.status] = (applications[row.status] ?? 0) + 1
    }
  }
  return { seeded: documents > 0 || Object.keys(applications).length > 0, documents, applications }
}

// ---------- an application, played with the real commands back in time ----------

type Calendar = Awaited<ReturnType<typeof loadBusinessCalendar>>
type Row = SupplierPortalSheets['applications'][number]

const KEY = 'seed-supplier-application'
const opts = (row: Row, step: string): RunOptions => ({ idempotencyKey: `${KEY}:${row.ref}:${row.taxId}:${step}`, sender: null, suppressOutbox: true })
function must<T>(row: Row, step: string, r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`ชีต Supplier_Applications ${row.ref} ขั้น ${step}: ${JSON.stringify(r.error)}`)
  return r.data
}

/** 10:00 of the business day `daysAgo` calendar days before now (the next business day when that one is not) */
function invitedAt(now: Date, daysAgo: number, calendar: Calendar): Date {
  const day = dayIn(new Date(now.getTime() - daysAgo * MS_PER_DAY), calendar.timezone)
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const [h, min] = calendar.start.split(':').map(Number) as [number, number]
  return addBusinessMinutes(new Date(new TZDate(y, m - 1, d, h, min, calendar.timezone).getTime()), 90, calendar)
}

const DAY_MINUTES = (calendar: Calendar) => {
  const [sh, sm] = calendar.start.split(':').map(Number) as [number, number]
  const [eh, em] = calendar.end.split(':').map(Number) as [number, number]
  return eh * 60 + em - (sh * 60 + sm)
}

async function playApplication(organizationId: string, row: Row, now: Date, calendar: Calendar, memberOf: (code: string | null, where: string) => string): Promise<void> {
  const db = forTenant(organizationId)
  const where = `ชีต Supplier_Applications ${row.ref}`
  const member = (code: string | null, at: Date): Ctx => makeCtx({ organizationId, actor: { type: 'USER', memberId: memberOf(code, where) }, channel: 'WEB', now: at })
  const latest = new Date(now.getTime() - 5 * MS_PER_MINUTE)
  const t0 = new Date(Math.min(invitedAt(now, row.invitedDaysAgo, calendar).getTime(), latest.getTime() - 60 * MS_PER_MINUTE))
  // the span the steps are spread over: to the decision (G-7 of an approved one) or to the last activity
  const span =
    row.status === 'APPROVED'
      ? Math.round((row.expectedG7Days ?? 0) * DAY_MINUTES(calendar))
      : Math.max(30, businessMinutesBetween(t0, new Date(Math.min(invitedAt(now, row.lastActivityDaysAgo ?? row.invitedDaysAgo, calendar).getTime() + 120 * MS_PER_MINUTE, latest.getTime())), calendar))
  const at = (fraction: number) => new Date(Math.min(addBusinessMinutes(t0, Math.round(span * fraction), calendar).getTime(), latest.getTime()))
  const version = async (id: string) => (await db.supplierApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version

  // 1. invited by procurement (duplicate warnings answered: the synthetic names are other companies than the register's)
  const invite = (reasons?: Record<string, string>) =>
    inviteSupplier(
      member(row.invitedBy, t0),
      { kind: 'NEW', nameTh: row.nameTh, taxId: row.taxId, branchCode: row.branchCode, payeeType: row.payeeType, category: row.category, contact: { nameTh: row.contactName, email: row.contactEmail }, inviterPhone: row.inviterPhone, ...(reasons ? { duplicateReasons: reasons } : {}) },
      opts(row, reasons ? 'invite-reasons' : 'invite'),
    )
  let invited = await invite()
  if (!invited.ok && invited.error.details?.reason === 'DUPLICATE_REASON_REQUIRED') invited = await invite({ SAME_TAXID_OTHER_BRANCH: 'ข้อมูลตัวอย่าง: คนละรายกับผู้ขายในทะเบียน', DUPLICATE_NAME: 'ข้อมูลตัวอย่าง: คนละรายกับผู้ขายในทะเบียน', DUPLICATE_EMAIL: 'ข้อมูลตัวอย่าง: อีเมลของผู้ติดต่อคนละคน' })
  const { applicationId, contactId } = must(row, 'invite', invited)
  if (row.status !== 'INVITED') {
    // 2. its contact signs in and accepts the privacy notice (BR-PORTAL ข้อ 08)
    const signedAt = at(row.status === 'EXPIRED' ? 1 : 0.05)
    const contact = await db.supplierContact.findUniqueOrThrow({ where: { id: contactId }, select: { id: true, applicationId: true, supplierId: true } })
    // the contact of the application as a portal request makes it (src/server/portal/session.ts portalCtx)
    const contactCtx = (t: Date): Ctx => makeCtx({ organizationId, actor: { type: 'SUPPLIER', supplierContactId: contact.id, applicationId }, channel: 'PORTAL', now: t })
    await db.$transaction(async (tx) => {
      const events = await applicationSignedIn(tx, contactCtx(signedAt), contact)
      if (events.length) await appendEvents(tx, contactCtx(signedAt), events)
    })
    await seedContactSignedIn(organizationId, contactId, signedAt)
    if (row.status !== 'EXPIRED') {
      // 3. filled in by its contact, or by procurement on its behalf, with the documents it needs (scanned clean)
      const filler = (t: Date) => (row.filledOnBehalf ? member(row.filledOnBehalf, t) : contactCtx(t))
      must(row, 'update', await updateApplication(filler(at(0.1)), { applicationId, expectedVersion: await version(applicationId), fields: { address: `${row.ref} ถนนตัวอย่าง (สมมติ)`, isVatRegistered: row.payeeType === 'JURISTIC', category: row.category, email: row.contactEmail } }, opts(row, 'update')))
      const docs = (await db.$transaction((tx) => requiredTypes(tx, row.payeeType, row.payeeType === 'JURISTIC'))).filter((t) => !row.missingDocs.includes(t))
      const types = new Map((await db.supplierDocumentType.findMany({ select: { code: true, validityDays: true } })).map((t) => [t.code, t.validityDays]))
      const uploadAt = at(row.status === 'DRAFT' ? 1 : 0.15)
      const uploaded: string[] = []
      for (const code of docs) {
        const issuedOn = dayIn(new Date(uploadAt.getTime() - 20 * MS_PER_DAY), calendar.timezone)
        const r = await uploadSupplierDocument(
          filler(uploadAt),
          { applicationId, documentTypeCode: code, issuedOn, expiresOn: types.get(code) ? null : inYears(issuedOn, 3), fileName: `${code.toLowerCase()}-${row.ref.toLowerCase()}.pdf`, bytes: documentPdf(['BCS synthetic application document (S7-13)', `${row.ref} ${code}`]) },
          opts(row, `upload-${code}`),
        )
        const { documentId, fileId } = must(row, `upload ${code}`, r)
        await scanFile(organizationId, fileId, new Date(uploadAt.getTime() + MS_PER_MINUTE))
        uploaded.push(documentId)
      }
      if (row.status !== 'DRAFT') {
        // 4. sent; returned to the supplier, or its documents verified and the application sent on its route
        const submitter = row.filledOnBehalf ? member(row.filledOnBehalf, at(0.4)) : contactCtx(at(0.4))
        must(row, 'submit', await submitApplication(submitter, { applicationId, expectedVersion: await version(applicationId) }, opts(row, 'submit')))
        if (row.status === 'RETURNED') {
          must(row, 'return', await returnApplication(member(row.verifiedBy, at(1)), { applicationId, expectedVersion: await version(applicationId), reason: 'สำเนาเอกสารไม่ชัด โปรดอัปโหลดใหม่' }, opts(row, 'return')))
        } else if (row.status !== 'SUBMITTED') {
          for (const documentId of uploaded) {
            const v = (await db.supplierDocument.findUniqueOrThrow({ where: { id: documentId }, select: { version: true } })).version
            must(row, 'verify', await verifySupplierDocument(member(row.verifiedBy, at(0.6)), { documentId, expectedVersion: v }, opts(row, `verify-${documentId}`)))
          }
          const routeAt = at(row.status === 'PENDING_APPROVAL' ? 1 : 0.7)
          const proof = await seedRegistryProof(organizationId, memberOf(row.routedBy, where), row.ref)
          const routed = must(row, 'route', await verifyAndRoute(member(row.routedBy, routeAt), { applicationId, expectedVersion: await version(applicationId), registryProofFileId: proof }, opts(row, 'route')))
          if (row.status === 'APPROVED') {
            // 5. approved by the holder of SA-01 exactly expectedG7Days business days after the invitation
            const task = await db.approvalTask.findFirstOrThrow({ where: { step: { routeId: routed.routeId }, status: 'OPEN' }, orderBy: { createdAt: 'asc' }, select: { id: true, assignee: { select: { employeeCode: true } } } })
            if (row.expectedApprover && task.assignee.employeeCode !== row.expectedApprover) throw new Error(`${where}: ผู้อนุมัติเป็น ${task.assignee.employeeCode} ไม่ใช่ ${row.expectedApprover} ตามข้อ SA-01`)
            const decidedAt = addBusinessMinutes(t0, span, calendar)
            must(row, 'approve', await decideTask(member(task.assignee.employeeCode, decidedAt), { taskId: task.id, decision: 'APPROVE' }, opts(row, 'approve')))
          }
        }
      }
    }
  }
  // 6. a waiting application goes through the steps of its SLA that fell due (remind, escalate, expire · BR-SUP ข้อ 12)
  for (let guard = 0; guard < 4; guard++) {
    const plan = await planApplicationSla(organizationId, applicationId)
    const due = plan.timers.find((t) => Date.parse(t.at) <= latest.getTime())
    if (!due || !plan.lastActivityAt) break
    const done = await applicationSlaStep(organizationId, applicationId, due.step, plan.lastActivityAt, new Date(Date.parse(due.at) + MS_PER_MINUTE))
    if (!done.done) break
  }
  const after = await db.supplierApplication.findUniqueOrThrow({ where: { id: applicationId }, select: { status: true } })
  if (after.status !== row.status) throw new Error(`${where}: เล่นแล้วได้สถานะ ${after.status} ไม่ใช่ ${row.status}`)
}
