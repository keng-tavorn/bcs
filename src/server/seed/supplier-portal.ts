import { TZDate } from '@date-fns/tz'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { normalizeScope } from '@/core/supplier-docs'
import { putObject } from '@/integrations/storage'
import { MS_PER_DAY } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { InputWorkbook } from './workbook'

// The supplier portal of the phase-1 organization (S7-13 · docs/sub-specs/S7.md "การอ่านชีตของไฟล์ระยะ 1"): the four
// sheets of S7, the document types and contacts of the base (no file), and the documents on file written as they stand
// (a one-page synthetic PDF each, scanned CLEAN) with the history, when the bucket answers. The applications are played
// with the real commands by src/server/services/demo-seed/supplier-portal.ts, which takes from here only what a command
// does not write (the privacy notice the contact accepted, the registry page procurement keeps). The demo workbook has
// none of these sheets; a second run adds nothing.

const yesNo = z.enum(['Y', 'N']).transform((v) => v === 'Y')
const text = z.string().trim().min(1)
const optional = z.string().trim().nullable()
const whole = z.coerce.number().int().min(0)
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const list = z
  .string()
  .nullable()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []))
const payees = list.pipe(z.array(z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'])))

const ContactRow = z.object({ supplierCode: text, nameTh: text, email: text.toLowerCase(), phone: optional, roleLabel: optional, isPrimary: yesNo, locale: z.enum(['th', 'en']), portalEnabled: yesNo })
const TypeRow = z.object({
  code: text,
  nameTh: text,
  nameEn: text,
  appliesTo: payees,
  required: yesNo,
  validityDays: z.coerce.number().int().positive().nullable(),
  reminderDaysBefore: whole,
  sensitive: yesNo,
  aiReadable: yesNo,
  aiReadablePayeeTypes: payees,
  singleInstance: yesNo,
  linkedRiskQuestionCodes: list,
  sortOrder: whole,
})
const DocumentRow = z.object({
  supplierCode: text,
  docType: text,
  docNumber: optional,
  issuer: optional,
  scope: optional,
  issuedDaysAgo: whole.nullable(),
  expiresDaysAhead: whole.nullable(),
  issuedOn: isoDay.nullable(),
  expiresOn: isoDay.nullable(),
  status: z.enum(['PENDING', 'VERIFIED', 'EXPIRED', 'SUPERSEDED']),
  verifiedBy: optional,
})
const ApplicationRow = z.object({
  ref: text,
  kind: z.literal('NEW'),
  nameTh: text,
  taxId: z.string().regex(/^\d{13}$/),
  branchCode: z.string().regex(/^\d{5}$/),
  payeeType: z.enum(['JURISTIC', 'INDIVIDUAL']),
  category: optional,
  contactName: text,
  contactEmail: text.toLowerCase(),
  inviterPhone: optional,
  invitedBy: text,
  routedBy: optional,
  verifiedBy: optional,
  invitedDaysAgo: whole,
  lastActivityDaysAgo: whole.nullable(),
  status: z.enum(['INVITED', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'EXPIRED']),
  filledOnBehalf: optional,
  missingDocs: list,
  expectedApprover: optional,
  expectedG7Days: z.coerce.number().positive().nullable(),
})

export interface SupplierPortalSheets {
  readonly types: z.infer<typeof TypeRow>[]
  readonly contacts: z.infer<typeof ContactRow>[]
  readonly documents: z.infer<typeof DocumentRow>[]
  readonly applications: z.infer<typeof ApplicationRow>[]
}

function rows<T>(workbook: InputWorkbook, sheet: string, schema: z.ZodType<T>): T[] {
  if (!workbook.hasSheet(sheet)) return []
  return workbook.table(sheet).map(({ row, values }) => {
    const parsed = schema.safeParse(values)
    if (!parsed.success) throw new Error(`ชีต ${sheet} แถว ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')} · แก้ scripts/inputs_p1/p1_suppliers_portal.py แล้วสร้างไฟล์ใหม่`)
    return parsed.data
  })
}

/** The four sheets of S7, or null when the workbook has none (the demo workbook) */
export function parseSupplierPortal(workbook: InputWorkbook): SupplierPortalSheets | null {
  if (!workbook.hasSheet('Supplier_Contacts')) return null
  return {
    types: rows(workbook, 'Supplier_Document_Types', TypeRow),
    contacts: rows(workbook, 'Supplier_Contacts', ContactRow),
    documents: rows(workbook, 'Supplier_Documents', DocumentRow),
    applications: rows(workbook, 'Supplier_Applications', ApplicationRow),
  }
}

// ---------- the base: document types and contacts ----------

export async function seedSupplierPortalBase(organizationId: string, sheets: SupplierPortalSheets, now: Date): Promise<{ types: number; contacts: number }> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    const haveTypes = new Set((await tx.supplierDocumentType.findMany({ select: { code: true } })).map((t) => t.code))
    let types = 0
    for (const t of sheets.types) {
      if (haveTypes.has(t.code)) continue
      const created = await tx.supplierDocumentType.create({
        data: {
          organizationId,
          code: t.code,
          nameTh: t.nameTh,
          nameEn: t.nameEn,
          appliesTo: t.appliesTo,
          required: t.required,
          validityDays: t.validityDays,
          reminderDaysBefore: t.reminderDaysBefore,
          sensitive: t.sensitive,
          aiReadable: t.aiReadable,
          aiReadablePayeeTypes: t.aiReadablePayeeTypes,
          singleInstance: t.singleInstance,
          linkedRiskQuestionCodes: t.linkedRiskQuestionCodes,
          sortOrder: t.sortOrder,
        },
      })
      events.push({ type: 'supplier_document_type.updated', aggregateType: 'SupplierDocumentType', aggregateId: created.id, data: { code: t.code, created: true, active: true, changed: [] } })
      types++
    }
    const suppliers = new Map((await tx.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
    const haveEmails = new Set((await tx.supplierContact.findMany({ select: { email: true } })).map((c) => c.email))
    const fresh = sheets.contacts.filter((c) => !haveEmails.has(c.email))
    const created = fresh.map((c) => {
      const supplierId = suppliers.get(c.supplierCode)
      if (!supplierId) throw new Error(`ชีต Supplier_Contacts: ไม่มีผู้ขาย ${c.supplierCode} · แก้ scripts/inputs_p1/p1_suppliers_portal.py`)
      return { id: newId(), organizationId, supplierId, nameTh: c.nameTh, email: c.email, phone: c.phone, roleLabel: c.roleLabel, isPrimary: c.isPrimary, locale: c.locale, portalEnabled: c.portalEnabled }
    })
    if (created.length) await tx.supplierContact.createMany({ data: created })
    for (const c of created) events.push({ type: 'supplier_contact.created', aggregateType: 'SupplierContact', aggregateId: c.id, data: { supplierId: c.supplierId, applicationId: null, isPrimary: c.isPrimary, portalEnabled: c.portalEnabled } })
    // a supplier with a contact who may sign in is a supplier of the portal
    const enabled = [...new Set(sheets.contacts.filter((c) => c.portalEnabled).map((c) => suppliers.get(c.supplierCode)).filter((id): id is string => Boolean(id)))]
    if (enabled.length) await tx.supplier.updateMany({ where: { id: { in: enabled }, portalEnabled: false }, data: { portalEnabled: true } })
    if (events.length) await appendEvents(tx, ctx, events)
    return { types, contacts: created.length }
  })
}

// ---------- the history: documents on file and the applications ----------

/** A one-page PDF with a few ASCII lines: the file of a synthetic supplier document */
export function documentPdf(lines: readonly string[]): Uint8Array {
  const body = lines.map((l, i) => `BT /F1 12 Tf 72 ${760 - i * 18} Td (${l.replace(/[^\x20-\x7e]/g, ' ').replace(/[()\\]/g, ' ')}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The calendar day of an instant in Asia/Bangkok, as YYYY-MM-DD */
export function dayIn(at: Date, timezone: string): string {
  const local = new TZDate(at.getTime(), timezone)
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
const asDate = (day: string) => new Date(`${day}T00:00:00Z`)
/** The same day some years on (a card or a certificate that carries its own expiry) */
export const inYears = (day: string, years: number) => `${Number(day.slice(0, 4)) + years}${day.slice(4)}`

/** The documents on file of sheet Supplier_Documents (none when the organization has one already); how many were written */
export async function seedSupplierDocuments(organizationId: string, sheets: SupplierPortalSheets, now: Date, timezone: string, memberOf: (code: string | null, where: string) => string): Promise<number> {
  if ((await forTenant(organizationId).supplierDocument.count({ where: { supplierId: { not: null } } })) > 0) return 0
  const db = forTenant(organizationId)
  const ctx = systemCtx(organizationId, now, 'seed')
  const today = dayIn(now, timezone)
  const suppliers = new Map((await db.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
  const types = new Map((await db.supplierDocumentType.findMany({ select: { code: true, validityDays: true, singleInstance: true } })).map((t) => [t.code, t]))
  const primary = new Map((await db.supplierContact.findMany({ where: { isPrimary: true, supplierId: { not: null } }, select: { id: true, supplierId: true } })).map((c) => [c.supplierId!, c.id]))
  // the current copy of a type is written before the older one it superseded, which points at it
  const order = [...sheets.documents].sort((a, b) => Number(a.status === 'SUPERSEDED') - Number(b.status === 'SUPERSEDED'))
  const current = new Map<string, string>()
  let written = 0
  for (let i = 0; i < order.length; i += 50) {
    const chunk = order.slice(i, i + 50)
    const prepared = await Promise.all(
      chunk.map(async (d) => {
        const supplierId = suppliers.get(d.supplierCode)
        const type = types.get(d.docType)
        if (!supplierId || !type) throw new Error(`ชีต Supplier_Documents: ไม่มีผู้ขาย ${d.supplierCode} หรือประเภท ${d.docType}`)
        const issuedOn = d.issuedOn ?? addDays(today, -(d.issuedDaysAgo ?? 0))
        const expiresOn = type.validityDays ? addDays(issuedOn, type.validityDays - 1) : (d.expiresOn ?? addDays(today, d.expiresDaysAhead ?? 0))
        const fileId = newId()
        const bytes = documentPdf(['BCS synthetic supplier document (S7-13)', `Supplier ${d.supplierCode}`, `Type ${d.docType}${d.scope ? ` - ${d.scope}` : ''}`, `Issued ${issuedOn} - expires ${expiresOn}`])
        const storageKey = `${organizationId}/supplier-documents/${fileId}.pdf`
        await putObject(storageKey, bytes, 'application/pdf')
        return { d, supplierId, type, issuedOn, expiresOn, fileId, bytes, storageKey }
      }),
    )
    await db.$transaction(async (tx) => {
      const events: EventDraft[] = []
      for (const p of prepared) {
        const { d } = p
        await tx.fileObject.create({ data: { id: p.fileId, organizationId, storageKey: p.storageKey, fileName: `${d.docType.toLowerCase()}-${d.supplierCode.toLowerCase()}.pdf`, mimeType: 'application/pdf', sizeBytes: p.bytes.length, sha256: sha256(p.bytes), status: 'AVAILABLE', uploadedById: null, scanStatus: 'CLEAN' } })
        const id = newId()
        const verified = d.status !== 'PENDING'
        const verifiedAt = new Date(Math.min(Date.parse(`${p.issuedOn}T03:00:00Z`) + MS_PER_DAY, now.getTime() - MS_PER_DAY))
        const scopeKey = p.type.singleInstance ? '' : normalizeScope(d.scope)
        const key = `${p.supplierId}|${d.docType}|${scopeKey}`
        await tx.supplierDocument.create({
          data: {
            id,
            organizationId,
            supplierId: p.supplierId,
            documentTypeCode: d.docType,
            fileId: p.fileId,
            docNumber: d.docNumber,
            issuer: d.issuer,
            scope: d.scope,
            scopeKey,
            issuedOn: asDate(p.issuedOn),
            expiresOn: asDate(p.expiresOn),
            status: d.status,
            uploadedByContactId: d.status === 'PENDING' ? (primary.get(p.supplierId) ?? null) : null,
            verifiedById: verified ? memberOf(d.verifiedBy, `ชีต Supplier_Documents ${d.supplierCode} ${d.docType}`) : null,
            verifiedAt: verified ? verifiedAt : null,
            expiredAt: d.status === 'EXPIRED' ? new Date(Date.parse(`${addDays(p.expiresOn, 1)}T00:00:00Z`)) : null,
            supersededById: d.status === 'SUPERSEDED' ? (current.get(key) ?? null) : null,
          },
        })
        if (d.status !== 'SUPERSEDED') current.set(key, id)
        const owner = { supplierId: p.supplierId, applicationId: null }
        events.push({ type: 'supplier_document.uploaded', aggregateType: 'SupplierDocument', aggregateId: id, data: { ...owner, documentTypeCode: d.docType, fileId: p.fileId, by: d.status === 'PENDING' ? 'CONTACT' : 'MEMBER' } })
        if (verified) events.push({ type: 'supplier_document.verified', aggregateType: 'SupplierDocument', aggregateId: id, data: { ...owner, documentTypeCode: d.docType, expiresOn: p.expiresOn, supersedes: [] } })
        if (d.status === 'EXPIRED') events.push({ type: 'supplier_document.expired', aggregateType: 'SupplierDocument', aggregateId: id, data: { ...owner, documentTypeCode: d.docType, expiresOn: p.expiresOn } })
        written++
      }
      await appendEvents(tx, ctx, events)
    })
  }
  return written
}


/** What the contact did when it first signed in, besides the application's own event: the privacy notice accepted (BR-PORTAL ข้อ 08) */
export async function seedContactSignedIn(organizationId: string, contactId: string, at: Date): Promise<void> {
  await forTenant(organizationId).supplierContact.update({ where: { id: contactId }, data: { firstSignedInAt: at, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION, privacyNoticeAcceptedAt: at } })
}

/** A copy of the registry's page procurement keeps when the registry does not know a synthetic tax id (BR-SUP ข้อ 11) */
export async function seedRegistryProof(organizationId: string, memberId: string, ref: string): Promise<string> {
  const id = newId()
  const bytes = documentPdf(['BCS synthetic registry page (S7-13)', ref])
  const storageKey = `${organizationId}/registry-proofs/${id}.pdf`
  await putObject(storageKey, bytes, 'application/pdf')
  await forTenant(organizationId).fileObject.create({ data: { id, organizationId, storageKey, fileName: `registry-${ref.toLowerCase()}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: sha256(bytes), status: 'AVAILABLE', uploadedById: memberId, scanStatus: 'NOT_REQUIRED' } })
  return id
}
