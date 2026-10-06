import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getEventDefinition, registeredEventTypes } from '@/server/events/registry'
import '@/server/events/schemas'
import { auditView, exportAudit, searchAudit, type AuditRowDto } from '@/server/services/audit'
import { maskNationalIds } from '@/server/services/audit/masking'
import { getDownloadUrl } from '@/server/services/files'
import { grantRole } from '@/server/services/members/roles'
import { createSupplier } from '@/server/services/suppliers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// NEW-33 (spec §16.11, BR-AUTH-04, FR-VIS-004 AC1 AC2): the data of supplier.created and supplier.registry_checked holds
// the supplier's tax id, and a Thai individual's tax id is their national id number. The audit search, the audit page
// and the exported file show it masked ("XXXXXXXXX0121", as the supplier register shows it) to every reader of the trail
// who does not see it whole in the register — the AUDITOR, and ORG_ADMIN, to whom the register shows no tax id — and
// whole to a reader granted more (FINANCE besides AUDITOR). A juristic person's and a foreign supplier's tax id stay
// whole; the events keep what was written (append-only). Real Postgres and the local S3 store, never mocked.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

/** Synthetic numbers the registry stub knows (BR-SUP-05): a Thai individual's and a company's */
const PERSON = '1234567890121'
const PERSON_MASKED = 'XXXXXXXXX0121'
const COMPANY = '0999999000012'
/** A foreign supplier's tax id: not a Thai national id number, though it has 13 digits and does not start with 0 */
const ABROAD = '9876543210987'
/** The columns of the audit file (seq … data) */
const AUDIT_FILE_COLUMNS = 12

let org: DoaOrg
const supplier: Record<string, string> = {}
/** A member who reads the trail as AUDITOR and also holds FINANCE, whom the register shows every number whole */
let auditorInFinance: Ctx

const as = (who: string) => org.ctxOf(who, NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const taxIdOf = (r: AuditRowDto) => (r.data as { taxId?: unknown }).taxId

async function download(ctx: Ctx, fileId: string): Promise<Uint8Array> {
  const url = ok(await getDownloadUrl(ctx, { fileId })).url
  return new Uint8Array(await (await fetch(url)).arrayBuffer())
}

/** RFC 4180 rows of a UTF-8 file with a byte order mark */
function csvRows(bytes: Uint8Array): string[][] {
  const text = new TextDecoder().decode(bytes).replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows.filter((r) => r.length > 1)
}

/** Every row of an exported audit file, the header first */
async function fileRows(bytes: Uint8Array, format: 'xlsx' | 'csv'): Promise<string[][]> {
  if (format === 'csv') return csvRows(bytes)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const rows: string[][] = []
  workbook.worksheets[0]!.eachRow({ includeEmpty: true }, (row) => rows.push(Array.from({ length: AUDIT_FILE_COLUMNS }, (_, i) => String(row.getCell(i + 1).value ?? ''))))
  return rows
}

/** The tax ids in the data column of the file's rows about one supplier */
function fileTaxIds(rows: string[][], supplierId: string): unknown[] {
  const [header, ...body] = rows
  const column = (name: string) => header!.indexOf(name)
  return body.filter((r) => r[column('aggregateId')] === supplierId).map((r) => (JSON.parse(r[column('data')]!) as { taxId?: unknown }).taxId)
}

/** An audit file as the export wrote it before files said whether they hold a national id number whole */
async function auditFileOfBefore(): Promise<string> {
  const organizationId = org.organizationId
  const exportJobId = randomUUID()
  const fileId = (await prisma.fileObject.create({ data: { organizationId, storageKey: `org/${organizationId}/exports/${exportJobId}.csv`, fileName: 'audit-before.csv', mimeType: 'text/csv', sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: org.member.auditor! } })).id
  await prisma.exportJob.create({ data: { id: exportJobId, organizationId, kind: 'AUDIT', params: { filter: {}, format: 'csv' }, status: 'COMPLETED', fileId, rowCount: 0, checksum: '0'.repeat(64), requestedById: org.member.auditor!, completedAt: NOW } })
  await prisma.fileLink.create({ data: { organizationId, fileId, subjectType: 'ExportJob', subjectId: exportJobId, kind: 'OTHER' } })
  return fileId
}

/** A field whose name says it holds a person's identity number */
const NATIONAL_ID_NAME = /tax_?id|national_?id|citizen|id_?card|personal_?id|passport/i
/** An array element on a path */
const ITEM = '[]'

/** The paths of the fields of a JSON schema named like a national id number (objects, arrays and unions) */
function nationalIdFields(schema: unknown, path: readonly string[] = []): string[][] {
  if (schema === null || typeof schema !== 'object') return []
  const node = schema as { properties?: Record<string, unknown>; items?: unknown; anyOf?: unknown[]; oneOf?: unknown[]; allOf?: unknown[] }
  const found: string[][] = []
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    if (NATIONAL_ID_NAME.test(name)) found.push([...path, name])
    found.push(...nationalIdFields(child, [...path, name]))
  }
  if (node.items) found.push(...nationalIdFields(node.items, [...path, ITEM]))
  for (const alternative of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) found.push(...nationalIdFields(alternative, path))
  return found
}

/** Event data with `value` at `path` (an array of one element at each ITEM) */
function dataWith(path: readonly string[], value: string): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  return head === ITEM ? [dataWith(rest, value)] : { [head]: dataWith(rest, value) }
}

function valueAt(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((at, key) => (at === null || typeof at !== 'object' ? undefined : key === ITEM ? (at as unknown[])[0] : (at as Record<string, unknown>)[key]), data)
}

beforeAll(async () => {
  org = await createDoaOrg({ doa: false })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
    ],
  })
  // createDoaOrg gives proc_officer PROCUREMENT (supplier.manage), who adds the suppliers through the service
  const create = async (name: string, input: Parameters<typeof createSupplier>[1]) => (supplier[name] = ok(await createSupplier(as('proc_officer'), input, key())).supplierId)
  await create('person', { code: 'S2', nameTh: 'นายทดสอบ ผู้รับจ้าง', taxId: PERSON, isVatRegistered: false, registry: { check: 'LOOKUP' } })
  await create('company', { code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', taxId: COMPANY, registry: { check: 'LOOKUP' } })
  await create('abroad', { code: 'F1', nameTh: 'Overseas Tools Ltd', nameEn: 'Overseas Tools Ltd', taxId: ABROAD, isForeign: true, isVatRegistered: false })
  // a member the organization's admin makes AUDITOR and FINANCE through the service
  const id = (await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: 'ผู้ตรวจสอบที่อยู่ฝ่ายบัญชีด้วย', email: `auditor-finance-${randomUUID()}@test.bcs.local`, status: 'ACTIVE', primaryDepartmentId: org.department.FIN! } })).id
  for (const role of ['AUDITOR', 'FINANCE'] as const) ok(await grantRole(as('admin'), { memberId: id, role }, key()))
  auditorInFinance = { ...as('auditor'), actor: { type: 'USER', memberId: id } }
})

describe('[FR-VIS-004/AC2] NEW-33 · BR-AUTH-04: the AUDITOR searches and exports the events of an individual supplier and sees the national id number masked', () => {
  it('the search and the audit page show the individual’s tax id as the supplier register does; a company’s and a foreign supplier’s stay whole; the events keep what was written', async () => {
    const person = ok(await searchAudit(as('auditor'), { aggregateId: supplier.person! }))
    expect(person.rows.map((r) => r.type).sort()).toEqual(['supplier.created', 'supplier.registry_checked'])
    for (const r of person.rows) expect(taxIdOf(r), r.type).toBe(PERSON_MASKED)
    // the rest of the data reads as written, and the whole number is nowhere in the rows
    expect(person.rows.find((r) => r.type === 'supplier.created')!.data).toMatchObject({ code: 'S2', branchCode: '00000', isForeign: false, via: 'PROCUREMENT' })
    expect(person.rows.find((r) => r.type === 'supplier.registry_checked')!.data).toMatchObject({ branchCode: '00000', outcome: 'FOUND' })
    expect(JSON.stringify(person.rows)).not.toContain(PERSON)
    // the audit page reads the same rows
    const page = ok(await auditView(as('auditor'), { aggregateId: supplier.person! }))
    expect(page.rows.map(taxIdOf)).toEqual([PERSON_MASKED, PERSON_MASKED])
    expect(JSON.stringify(page.rows)).not.toContain(PERSON)
    // a juristic person's tax id is not a national id number, nor is a foreign supplier's: whole
    expect(ok(await searchAudit(as('auditor'), { aggregateId: supplier.company! })).rows.map(taxIdOf)).toEqual([COMPANY, COMPANY])
    expect(ok(await searchAudit(as('auditor'), { aggregateId: supplier.abroad! })).rows.map(taxIdOf)).toEqual([ABROAD])
    // the masking is how the trail reads: the events themselves keep the number as written (append-only)
    const stored = await prisma.event.findMany({ where: { organizationId: org.organizationId, aggregateId: supplier.person! }, select: { data: true } })
    expect(stored.map((e) => (e.data as { taxId: string }).taxId)).toEqual([PERSON, PERSON])
  })

  it('the exported file, in Excel and in CSV, holds the masked number, and its checksum is over the bytes that were written', async () => {
    const filter = { types: ['supplier.created', 'supplier.registry_checked'] }
    for (const format of ['xlsx', 'csv'] as const) {
      const file = ok(await exportAudit(as('auditor'), { filter, format }, key()))
      const bytes = await download(as('auditor'), file.fileId)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      expect(sha256, format).toBe(file.checksum)
      expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: file.fileId }, select: { sha256: true } }), format).toEqual({ sha256 })
      expect(await prisma.event.findFirstOrThrow({ where: { type: 'audit.exported', aggregateId: file.exportJobId } }), format).toMatchObject({ data: { checksum: sha256, rowCount: 5 } })
      const rows = await fileRows(bytes, format)
      expect(rows.slice(1), format).toHaveLength(file.rowCount)
      expect(fileTaxIds(rows, supplier.person!), format).toEqual([PERSON_MASKED, PERSON_MASKED])
      expect(fileTaxIds(rows, supplier.company!), format).toEqual([COMPANY, COMPANY])
      expect(fileTaxIds(rows, supplier.abroad!), format).toEqual([ABROAD])
      // the whole number is in no cell of the file
      expect(rows.flat().some((cell) => cell.includes(PERSON)), format).toBe(false)
    }
  })
})

describe('[FR-VIS-004/AC2] NEW-33 · BR-AUTH-04: every other reader of the trail sees the number as the supplier register shows it to them', () => {
  it('ORG_ADMIN, whom the register shows no tax id, sees it masked; a reader granted more (FINANCE besides AUDITOR) sees it whole in the search and the file; who may read and export the trail is unchanged', async () => {
    expect(ok(await searchAudit(as('admin'), { aggregateId: supplier.person! })).rows.map(taxIdOf)).toEqual([PERSON_MASKED, PERSON_MASKED])
    expect(ok(await auditView(as('admin'), { aggregateId: supplier.person! })).rows.map(taxIdOf)).toEqual([PERSON_MASKED, PERSON_MASKED])
    expect(ok(await searchAudit(auditorInFinance, { aggregateId: supplier.person! })).rows.map(taxIdOf)).toEqual([PERSON, PERSON])
    const file = ok(await exportAudit(auditorInFinance, { filter: { aggregateId: supplier.person! }, format: 'csv' }, key()))
    expect(fileTaxIds(await fileRows(await download(auditorInFinance, file.fileId), 'csv'), supplier.person!)).toEqual([PERSON, PERSON])
    // refusals as before: PROCUREMENT sees the number in the register but does not read the trail; ORG_ADMIN does not export
    for (const who of ['proc_officer', 'req_con']) expect(await searchAudit(as(who), { aggregateId: supplier.person! }), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await exportAudit(as('admin'), { filter: { aggregateId: supplier.person! } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('a person’s number typed into the document box of an export is masked in its audit.exported event for those who see it masked; a document number stays as typed', async () => {
    const typed = '1-2345-67890-12-1'
    const byNumber = ok(await exportAudit(as('auditor'), { filter: { document: typed }, format: 'csv' }, key()))
    expect(byNumber.rowCount).toBe(0)
    const byDocument = ok(await exportAudit(as('auditor'), { filter: { document: 'PR-2569-00001' }, format: 'csv' }, key()))
    const documentOf = async (ctx: Ctx, exportJobId: string) => {
      const rows = ok(await searchAudit(ctx, { aggregateId: exportJobId, types: ['audit.exported'] })).rows
      expect(rows).toHaveLength(1)
      return (rows[0]!.data as { filter: { document?: unknown } }).filter.document
    }
    expect(await documentOf(as('auditor'), byNumber.exportJobId)).toBe(PERSON_MASKED)
    expect(await documentOf(as('admin'), byNumber.exportJobId)).toBe(PERSON_MASKED)
    expect(await documentOf(auditorInFinance, byNumber.exportJobId)).toBe(typed)
    expect(await documentOf(as('auditor'), byDocument.exportJobId)).toBe('PR-2569-00001')
  })
})

describe('[FR-VIS-004/AC2] NEW-33 · BR-AUTH-04: an audit file that holds a national id number whole downloads only for readers who see it whole', () => {
  it('the file of a reader granted more holds the number whole and is refused to the AUDITOR; a file with no number whole downloads for both; a file made before files said what they hold is for readers who see numbers whole', async () => {
    const whole = ok(await exportAudit(auditorInFinance, { filter: { aggregateId: supplier.person! }, format: 'csv' }, key()))
    const masked = ok(await exportAudit(as('auditor'), { filter: { aggregateId: supplier.person! }, format: 'csv' }, key()))
    const company = ok(await exportAudit(auditorInFinance, { filter: { aggregateId: supplier.company! }, format: 'csv' }, key()))
    const params = async (exportJobId: string) => (await prisma.exportJob.findUniqueOrThrow({ where: { id: exportJobId }, select: { params: true } })).params
    expect(await params(whole.exportJobId)).toMatchObject({ wholeNationalIds: true })
    expect(await params(masked.exportJobId)).toMatchObject({ wholeNationalIds: false })
    expect(await params(company.exportJobId)).toMatchObject({ wholeNationalIds: false })
    // the AUDITOR who sees numbers masked is refused the file that holds one whole, though its id is in the trail
    expect(await getDownloadUrl(as('auditor'), { fileId: whole.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(fileTaxIds(await fileRows(await download(auditorInFinance, whole.fileId), 'csv'), supplier.person!)).toEqual([PERSON, PERSON])
    for (const file of [masked, company]) for (const ctx of [as('auditor'), auditorInFinance]) expect(await getDownloadUrl(ctx, { fileId: file.fileId })).toMatchObject({ ok: true })
    // ORG_ADMIN downloads no audit file (audit.export is the AUDITOR's), as before
    expect(await getDownloadUrl(as('admin'), { fileId: masked.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a file made before files said what they hold may hold numbers whole
    const before = await auditFileOfBefore()
    expect(await getDownloadUrl(as('auditor'), { fileId: before })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDownloadUrl(auditorInFinance, { fileId: before })).toMatchObject({ ok: true })
  })
})

describe('[FR-VIS-004/AC2] NEW-33 · BR-AUTH-04: every field of the event catalogue named like a national id number is masked in the trail', () => {
  it('walks the data schema of every registered event type: each such field of a Thai individual reads masked, so a new event cannot carry one past the trail unmasked', () => {
    const fields = registeredEventTypes().flatMap((type) => nationalIdFields(z.toJSONSchema(getEventDefinition(type)!.schema, { unrepresentable: 'any' })).map((path) => ({ type, path })))
    // the walk finds the supplier's tax id where the catalogue keeps it today
    expect(fields).toEqual(expect.arrayContaining([{ type: 'supplier.created', path: ['taxId'] }, { type: 'supplier.registry_checked', path: ['taxId'] }]))
    for (const { type, path } of fields) {
      const data = { isForeign: false, ...(dataWith(path, PERSON) as Record<string, unknown>) }
      expect(valueAt(maskNationalIds(type, data), path), `${type} ${path.join('.')}`).toBe(PERSON_MASKED)
    }
  })
})
