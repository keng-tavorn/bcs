import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkSupplier, createSupplierFromScreen, updateSupplierFromScreen } from '@/app/(workspace)/suppliers/commands'
import { setRegistryProvider } from '@/integrations/registry'
import { prisma } from '@/server/db/client'
import { getDownloadUrl } from '@/server/services/files'
import { createSupplier, updateSupplier } from '@/server/services/suppliers'
import { checkNewSupplier, getNewSupplierContext, getSupplierForScreen, listSuppliersForScreen } from '@/server/services/suppliers/view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-02 and S4-15 as the screens read them (spec §9.1 /suppliers, §2.4 supplier.view, FR-SUP-001): every member sees the
// name and basic details; PROCUREMENT, FINANCE and AUDITOR everything, an individual's tax id masked for a reader who sees
// it only as AUDITOR (BR-AUTH-04) — and not found by its hidden digits; the new-supplier check fills from the registries
// (stub) and names a supplier already in the register; registries that cannot be reached let a person confirm with proof
// (BR-SUP-03); a proof downloads only for those who see the register in full; a supplier's tax id and branch change only
// with the registries checked again or a person's proof, and never from the edit forms of the screens. Real Postgres,
// never mocked.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const ids: Record<string, string> = {}
let proofId: string
let individualProofId: string

const as = (who: string) => org.ctxOf(who, NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const proofFile = async () =>
  (await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'หนังสือรับรอง.pdf', mimeType: 'application/pdf', sizeBytes: 2048, status: 'AVAILABLE', uploadedById: org.member.proc_officer! } })).id

beforeAll(async () => {
  org = await createDoaOrg({ doa: false })
  // §2.4 supplier.view in full: FINANCE and AUDITOR besides PROCUREMENT (createDoaOrg gives proc_officer PROCUREMENT)
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
    ],
  })
  const create = async (name: string, input: Parameters<typeof createSupplier>[1]) => (ids[name] = ok(await createSupplier(as('proc_officer'), input, key())).supplierId)
  await create('juristic', { code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', taxId: '0999999000012', expressVendorCode: 'V0001', email: 's1@supplier.test', category: 'วัสดุก่อสร้าง', registry: { check: 'LOOKUP' } })
  await create('individual', { code: 'S2', nameTh: 'นายทดสอบ ผู้รับจ้าง', taxId: '1234567890121', isVatRegistered: false, registry: { check: 'LOOKUP' } })
  proofId = await proofFile()
  await create('manual', { code: 'S3', nameTh: 'บริษัท กรอกเอง จำกัด', taxId: '0999999000080', registry: { check: 'MANUAL', proofFileId: proofId } })
  individualProofId = await proofFile()
  await create('individualManual', { code: 'S4', nameTh: 'นางทดสอบ ช่างไม้', taxId: '1099999000027', isVatRegistered: false, registry: { check: 'MANUAL', proofFileId: individualProofId } })
  await create('foreign', { code: 'F1', nameTh: 'Overseas Tools Ltd', nameEn: 'Overseas Tools Ltd', isForeign: true, isVatRegistered: false })
  await create('closed', { code: 'S9', nameTh: 'บริษัท เลิกใช้ทดสอบ จำกัด', taxId: '0999999000039', expressVendorCode: 'V0009', registry: { check: 'LOOKUP' } })
  ok(await updateSupplier(as('proc_officer'), { supplierId: ids.closed!, expectedVersion: 0, status: 'INACTIVE' }, key()))
})

describe('[S4-02] the register as /suppliers reads it (supplier.view)', () => {
  it('PROCUREMENT and FINANCE see every field: the tax id, the Express vendor code and how the identity was checked', async () => {
    for (const who of ['proc_officer', 'fin_officer']) {
      const list = ok(await listSuppliersForScreen(as(who), {}))
      expect(list).toMatchObject({ level: 'FULL', total: 6, matched: 6 })
      expect(list.canManage).toBe(who === 'proc_officer')
      // Active ones first, then the ones no longer used
      expect(list.rows.at(-1)).toMatchObject({ code: 'S9', status: 'INACTIVE' })
      expect(list.rows.find((r) => r.code === 'S1')).toMatchObject({ isVatRegistered: true, category: 'วัสดุก่อสร้าง', full: { taxId: '0999999000012', taxIdMasked: false, expressVendorCode: 'V0001', registrySource: 'STUB' } })
      expect(list.rows.find((r) => r.code === 'S3')?.full).toMatchObject({ registrySource: 'MANUAL', expressVendorCode: null })
      expect(list.rows.find((r) => r.code === 'F1')).toMatchObject({ isForeign: true, full: { taxId: null, registrySource: null } })
    }
  })

  it('searches by name, code or tax id (with or without dashes), and filters by status and a missing Express code', async () => {
    const codes = async (filter: Parameters<typeof listSuppliersForScreen>[1]) => ok(await listSuppliersForScreen(as('proc_officer'), filter)).rows.map((r) => r.code)
    expect(await codes({ q: 'วัสดุก่อสร้าง' })).toEqual(['S1'])
    expect(await codes({ q: 's3' })).toEqual(['S3'])
    expect(await codes({ q: '0-9999-99000-01-2' })).toEqual(['S1'])
    expect(await codes({ q: '1234567890121' })).toEqual(['S2'])
    expect(await codes({ q: 'overseas' })).toEqual(['F1'])
    expect(await codes({ status: 'INACTIVE' })).toEqual(['S9'])
    expect((await codes({ missingExpressCode: true })).sort()).toEqual(['F1', 'S2', 'S3', 'S4'])
    expect(await codes({ status: 'NOT_A_STATUS', q: 'S9' })).toEqual(['S9'])
    const none = ok(await listSuppliersForScreen(as('proc_officer'), { q: 'ไม่มีผู้ขายชื่อนี้' }))
    expect(none).toMatchObject({ rows: [], total: 6, matched: 0 })
  })

  it('a member without those roles sees the name and basic details only, and cannot search by tax id or filter by Express code', async () => {
    const list = ok(await listSuppliersForScreen(as('req_con'), {}))
    expect(list).toMatchObject({ level: 'BASIC', canManage: false, total: 6 })
    expect(list.rows.every((r) => r.full === null)).toBe(true)
    expect(Object.keys(list.rows[0]!).sort()).toEqual(['branchCode', 'category', 'code', 'full', 'id', 'isForeign', 'isVatRegistered', 'nameEn', 'nameTh', 'status'])
    expect(ok(await listSuppliersForScreen(as('req_con'), { q: '0999999000012' })).rows).toEqual([])
    expect(ok(await listSuppliersForScreen(as('req_con'), { missingExpressCode: true })).matched).toBe(6)
    const one = ok(await getSupplierForScreen(as('req_con'), ids.juristic!))
    expect(one).toMatchObject({ level: 'BASIC', canManage: false, full: null, supplier: { code: 'S1', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' } })
  })

  it('BR-AUTH-04: an AUDITOR sees an individual supplier’s tax id masked and not its proof; a company’s in full', async () => {
    const list = ok(await listSuppliersForScreen(as('auditor'), {}))
    expect(list.level).toBe('FULL')
    expect(list.rows.find((r) => r.code === 'S2')?.full).toMatchObject({ taxId: 'XXXXXXXXX0121', taxIdMasked: true })
    expect(list.rows.find((r) => r.code === 'S1')?.full).toMatchObject({ taxId: '0999999000012', taxIdMasked: false })
    const individual = ok(await getSupplierForScreen(as('auditor'), ids.individualManual!))
    expect(individual.full).toMatchObject({ taxId: 'XXXXXXXXX0027', taxIdMasked: true, individual: true, proofs: [] })
    expect(ok(await getSupplierForScreen(as('fin_officer'), ids.individualManual!)).full).toMatchObject({ taxId: '1099999000027', taxIdMasked: false, proofs: [{ fileId: individualProofId }] })
  })

  it('BR-AUTH-04: an AUDITOR’s search never finds an individual by part of the number (the hidden digits), only by the whole number; a company by any part', async () => {
    const codes = async (who: string, q: string) => ok(await listSuppliersForScreen(as(who), { q })).rows.map((r) => r.code)
    const searched = ok(await listSuppliersForScreen(as('auditor'), { q: '90121' }))
    expect(searched).toMatchObject({ taxIdMatch: 'WHOLE_FOR_INDIVIDUALS', rows: [], matched: 0 })
    // S2 is 1234567890121 and S4 1099999000027: no part of them, with or without dashes, finds them
    for (const q of ['0121', '67890', '1-2345-67890-12', '234567890121', '123456789012', '0027', '109999900002', '99999000027']) {
      expect(ok(await listSuppliersForScreen(as('auditor'), { q })), q).toMatchObject({ rows: [], matched: 0 })
    }
    // The whole number, as written on a document: the reader typed it, and it still shows masked
    for (const q of ['1234567890121', '1-2345-67890-12-1', '1 2345 67890 12 1']) {
      const rows = ok(await listSuppliersForScreen(as('auditor'), { q })).rows
      expect(rows.map((r) => r.code), q).toEqual(['S2'])
      expect(rows[0]!.full).toMatchObject({ taxId: 'XXXXXXXXX0121', taxIdMasked: true })
    }
    // A company's number, which this reader sees in full, is found by any part of it
    expect(await codes('auditor', '99000012')).toEqual(['S1'])
    expect(await codes('auditor', '0-9999-99000-08')).toEqual(['S3'])
    // Readers who see every number in full find an individual by any part
    expect(ok(await listSuppliersForScreen(as('fin_officer'), { q: '90121' }))).toMatchObject({ taxIdMatch: 'ANY_PART', rows: [{ code: 'S2' }], matched: 1 })
    expect(await codes('proc_officer', '0027')).toEqual(['S4'])
    // A member who sees the basic details only does not search tax ids at all
    expect(ok(await listSuppliersForScreen(as('req_con'), { q: '1234567890121' }))).toMatchObject({ taxIdMatch: null, rows: [], matched: 0 })
  })

  it('one supplier keeps what the registries said (BR-SUP-01): sources, the juristic status, an individual checked at RD only', async () => {
    const company = ok(await getSupplierForScreen(as('proc_officer'), ids.juristic!))
    expect(company).toMatchObject({ level: 'FULL', canManage: true, supplier: { version: 0 } })
    expect(company.full).toMatchObject({
      individual: false,
      email: 's1@supplier.test',
      registry: { source: 'STUB', checkedAt: NOW.toISOString(), juristicStatus: 'ยังดำเนินกิจการอยู่', recorded: { mode: 'stub', rd: 'FOUND', dbd: 'FOUND', nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด', vatRegistered: true } },
    })
    const person = ok(await getSupplierForScreen(as('proc_officer'), ids.individual!))
    expect(person.full).toMatchObject({ individual: true, registry: { recorded: { rd: 'FOUND', dbd: 'SKIPPED', juristicStatus: null } } })
    const manual = ok(await getSupplierForScreen(as('proc_officer'), ids.manual!))
    expect(manual.full).toMatchObject({ registry: { source: 'MANUAL', recorded: { rd: 'UNAVAILABLE', dbd: 'UNAVAILABLE' } }, proofs: [{ fileId: proofId, fileName: 'หนังสือรับรอง.pdf', sizeBytes: 2048 }] })
    expect(await getSupplierForScreen(as('proc_officer'), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getSupplierForScreen(as('proc_officer'), 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('a deactivated member may not read the register at all', async () => {
    const gone = (await prisma.member.create({ data: { organizationId: org.organizationId, displayNameTh: 'ผู้ใช้ที่ออกแล้ว', email: `gone-${randomUUID()}@test.bcs.local`, status: 'DEACTIVATED', primaryDepartmentId: org.department.CON! } })).id
    const ctx = { ...as('req_con'), actor: { type: 'USER' as const, memberId: gone } }
    expect(await listSuppliersForScreen(ctx, {})).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getSupplierForScreen(ctx, ids.juristic!)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-SUP-001/AC2] a proof attached by a person downloads only for those who see the register in full', () => {
  it('PROCUREMENT, FINANCE and AUDITOR open a company’s proof; a requester may not; an individual’s proof is not for a reader who sees it masked', async () => {
    for (const who of ['proc_officer', 'fin_officer', 'auditor']) expect(await getDownloadUrl(as(who), { fileId: proofId })).toMatchObject({ ok: true })
    expect(await getDownloadUrl(as('req_con'), { fileId: proofId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDownloadUrl(as('fin_officer'), { fileId: individualProofId })).toMatchObject({ ok: true })
    expect(await getDownloadUrl(as('auditor'), { fileId: individualProofId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-SUP-001/AC1] the new-supplier screen: the registries fill the form, and a supplier already in the register is named', () => {
  it('fills a company that is not in the register yet, from both registries (stub)', async () => {
    const check = ok(await checkNewSupplier(as('proc_officer'), { taxId: '0-9999-99000-09-8', branchCode: '00000' }))
    expect(check).toEqual({
      proposal: { taxId: '0999999000098', branchCode: '00000', outcome: 'FOUND', sources: ['STUB'], nameTh: 'บริษัท เครื่องมือช่างทดสอบ จำกัด', address: expect.stringContaining('กรุงเทพมหานคร'), isVatRegistered: true, juristicStatus: 'ยังดำเนินกิจการอยู่', individual: false },
      existing: null,
    })
  })

  it('names the supplier that already has the tax id and branch; another branch is a new supplier', async () => {
    expect(ok(await checkNewSupplier(as('proc_officer'), { taxId: '0999999000012', branchCode: '00000' }))).toMatchObject({ proposal: { outcome: 'FOUND' }, existing: { id: ids.juristic, code: 'S1' } })
    expect(ok(await checkNewSupplier(as('proc_officer'), { taxId: '0999999000012', branchCode: '00001' })).existing).toBeNull()
  })

  it('only PROCUREMENT checks or opens the form (supplier.manage); a wrong check digit is refused', async () => {
    expect(await checkNewSupplier(as('fin_officer'), { taxId: '0999999000098' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await checkNewSupplier(as('req_con'), { taxId: '0999999000098' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await checkNewSupplier(as('proc_officer'), { taxId: '0999999000099' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TAX_ID_INVALID' } } })
    expect(ok(await getNewSupplierContext(as('proc_officer')))).toEqual({ suggestedCode: 'S10', registryMode: 'stub' })
    expect(await getNewSupplierContext(as('auditor'))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

// The blocks below add suppliers of their own (codes without a trailing number, so the suggested code stays S10); they
// run after the reads above, whose counts they would otherwise change.

describe('[FR-SUP-001/AC2] registries that cannot be reached do not block: the check says so and a person confirms with proof (BR-SUP-03)', () => {
  afterEach(() => setRegistryProvider(null))

  it('a registry that fails answers UNAVAILABLE, so the screen offers the proof; the save records the person’s confirmation', async () => {
    setRegistryProvider({
      mode: 'live',
      lookup: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    })
    expect(ok(await checkNewSupplier(as('proc_officer'), { taxId: '0999999000144', branchCode: '00000' }))).toEqual({
      proposal: { taxId: '0999999000144', branchCode: '00000', outcome: 'UNAVAILABLE', sources: [], nameTh: null, address: null, isVatRegistered: null, juristicStatus: null, individual: false },
      existing: null,
    })
    // BR-SUP-02: DBD is not asked about an individual even then
    expect(ok(await checkNewSupplier(as('proc_officer'), { taxId: '1234567890121', branchCode: '00077' })).proposal).toMatchObject({ outcome: 'UNAVAILABLE', individual: true })
    // Through the screen's own command as well
    expect(await checkSupplier(as('proc_officer'), { taxId: '0999999000144', branchCode: '00000' })).toMatchObject({ ok: true, check: { proposal: { outcome: 'UNAVAILABLE' } } })
    expect(await createSupplier(as('proc_officer'), { code: 'DOWN-LOOKUP', nameTh: 'บริษัท บริการล่ม จำกัด', taxId: '0999999000144', registry: { check: 'LOOKUP' } }, key())).toMatchObject({
      ok: false,
      error: { details: { reason: 'REGISTRY_PROOF_REQUIRED', outcome: 'UNAVAILABLE' } },
    })
    const fileId = await proofFile()
    const created = ok(await createSupplier(as('proc_officer'), { code: 'DOWN-PROOF', nameTh: 'บริษัท บริการล่ม จำกัด', taxId: '0999999000144', registry: { check: 'MANUAL', proofFileId: fileId } }, key()))
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: created.supplierId } })).toMatchObject({
      registrySource: 'MANUAL',
      registryData: { mode: 'live', rd: { status: 'UNAVAILABLE' }, dbd: { status: 'UNAVAILABLE' } },
    })
    expect(await prisma.fileLink.findFirstOrThrow({ where: { subjectType: 'Supplier', subjectId: created.supplierId } })).toMatchObject({ kind: 'REGISTRY_PROOF', fileId })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: created.supplierId, type: 'supplier.registry_checked' } })).toMatchObject({ data: { outcome: 'UNAVAILABLE', sources: ['MANUAL'] } })
  })

  it('any other failure is not passed off as the registries: the screen gets a reference to report', async () => {
    // A provider whose answer cannot be read: a fault of the system, not a registry that is down
    setRegistryProvider({ mode: 'stub', lookup: async () => ({}) as never })
    const ctx = as('proc_officer')
    expect(await checkNewSupplier(ctx, { taxId: '0999999000152', branchCode: '00000' })).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'unexpected error', details: { requestId: ctx.requestId } } })
    expect(await checkSupplier(ctx, { taxId: '0999999000152', branchCode: '00000' })).toEqual({ ok: false, code: 'INTERNAL', requestId: ctx.requestId })
  })
})

describe('[S4-02] a supplier’s tax id and branch change only with the registries checked again or a person’s proof (BR-SUP-01 to BR-SUP-03)', () => {
  it('refuses a new tax id or branch without a check, or with a lookup that finds nothing; accepts proof or a lookup that finds it', async () => {
    const supplierId = ok(await createSupplier(as('proc_officer'), { code: 'ID-CHANGE', nameTh: 'บริษัท ขนส่งทดสอบ จำกัด', taxId: '0999999000101', registry: { check: 'LOOKUP' } }, key())).supplierId
    const row = () => prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: '0999999000136' }, key())).toMatchObject({ ok: false, error: { details: { field: 'registry', reason: 'REGISTRY_CHECK_REQUIRED' } } })
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, branchCode: '00001' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_CHECK_REQUIRED' } } })
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: '0999999000136', registry: { check: 'LOOKUP' } }, key())).toMatchObject({
      ok: false,
      error: { details: { reason: 'REGISTRY_PROOF_REQUIRED', outcome: 'NOT_FOUND' } },
    })
    // Proof uploaded by someone else is not this user's proof
    const othersProof = (await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ของคนอื่น.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })).id
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: '0999999000136', registry: { check: 'MANUAL', proofFileId: othersProof } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    // A check goes with a new identity only
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, nameTh: 'ชื่อใหม่', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_NOT_NEEDED' } } })
    expect(await row()).toMatchObject({ taxId: '0999999000101', branchCode: '00000', registrySource: 'STUB', version: 0 })

    const fileId = await proofFile()
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: '0-9999-99000-13-6', registry: { check: 'MANUAL', proofFileId: fileId } }, key())).toMatchObject({ ok: true, data: { version: 1 } })
    expect(await row()).toMatchObject({ taxId: '0999999000136', registrySource: 'MANUAL', registryCheckedAt: NOW, registryData: { rd: { status: 'NOT_FOUND' } }, version: 1 })
    expect(await prisma.fileLink.findFirstOrThrow({ where: { subjectType: 'Supplier', subjectId: supplierId } })).toMatchObject({ kind: 'REGISTRY_PROOF', fileId })
    const events = await prisma.event.findMany({ where: { aggregateId: supplierId, type: { in: ['supplier.updated', 'supplier.registry_checked'] } }, orderBy: { seq: 'asc' } })
    // The check when it was added, then the change with its own check; the refusals above wrote nothing
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['supplier.registry_checked', { taxId: '0999999000101', branchCode: '00000', sources: ['STUB'], outcome: 'FOUND' }],
      ['supplier.updated', { code: 'ID-CHANGE', changed: ['taxId'] }],
      ['supplier.registry_checked', { taxId: '0999999000136', branchCode: '00000', sources: ['MANUAL'], outcome: 'NOT_FOUND' }],
    ])

    // Back to a number the registries know: the lookup is enough, and what they said is kept again
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 1, taxId: '0999999000101', branchCode: '00002', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: true, data: { version: 2 } })
    expect(await row()).toMatchObject({ taxId: '0999999000101', branchCode: '00002', registrySource: 'STUB', registryStatus: 'ยังดำเนินกิจการอยู่', version: 2 })
  })

  it('a foreign supplier’s own number changes without the Thai registries', async () => {
    const supplierId = ok(await createSupplier(as('proc_officer'), { code: 'ID-FOREIGN', nameTh: 'Overseas Parts Ltd', isForeign: true, isVatRegistered: false }, key())).supplierId
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: 'GB-123', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_NOT_NEEDED' } } })
    expect(await updateSupplier(as('proc_officer'), { supplierId, expectedVersion: 0, taxId: 'GB-123' }, key())).toMatchObject({ ok: true, data: { version: 1 } })
  })
})

describe('[S4-02] the supplier screens’ commands read nothing they have not parsed, and their edits never touch the identity (BR-AUTH-05)', () => {
  it('an edit that names the tax id, the branch or a registry check is refused whole, and changes nothing', async () => {
    const supplierId = ok(await createSupplier(as('proc_officer'), { code: 'SCREEN-EDIT', nameTh: 'สำนักงานบัญชีทดสอบ จำกัด', taxId: '0999999000063', registry: { check: 'LOOKUP' } }, key())).supplierId
    const attempts = [
      { supplierId, expectedVersion: 0, taxId: '0999999000098', branchCode: '00000' },
      { supplierId, expectedVersion: 0, branchCode: '00003', nameTh: 'ชื่อใหม่' },
      { supplierId, expectedVersion: 0, taxId: '0999999000098', registry: { check: 'LOOKUP' } },
      { supplierId, expectedVersion: 0, isForeign: true },
    ]
    for (const input of attempts) expect(await updateSupplierFromScreen(as('proc_officer'), input, randomUUID()), JSON.stringify(input)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(await updateSupplierFromScreen(as('proc_officer'), attempts[0], randomUUID())).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'taxId' })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).toMatchObject({ taxId: '0999999000063', branchCode: '00000', nameTh: 'สำนักงานบัญชีทดสอบ จำกัด', version: 0 })
    expect(await prisma.event.count({ where: { aggregateId: supplierId, type: 'supplier.updated' } })).toBe(0)

    // What the forms do send goes through, for PROCUREMENT only
    expect(await updateSupplierFromScreen(as('fin_officer'), { supplierId, expectedVersion: 0, expressVendorCode: 'V0063' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await updateSupplierFromScreen(as('auditor'), { supplierId, expectedVersion: 0, status: 'INACTIVE' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await updateSupplierFromScreen(as('proc_officer'), { supplierId, expectedVersion: 0, expressVendorCode: 'V0063', email: 'ap@supplier.test', phone: null }, randomUUID())).toEqual({ ok: true, supplierId, version: 1 })
  })

  it('a malformed call is refused as invalid, never a crash', async () => {
    const proc = as('proc_officer')
    for (const input of [null, 'x', 42, [], { taxId: 1234567890121 }, { branchCode: '00000' }]) expect(await checkSupplier(proc, input), JSON.stringify(input)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    for (const input of [null, 'x', 42, []]) {
      expect(await createSupplierFromScreen(proc, input, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
      expect(await updateSupplierFromScreen(proc, input, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
    expect(await updateSupplierFromScreen(proc, { supplierId: ids.juristic, expectedVersion: 0, nameTh: 'x' }, 'not-a-key')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await createSupplierFromScreen(proc, { code: 'NO-KEY', nameTh: 'x', isForeign: true }, null)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    // The form's "no check" (null) for a foreign supplier is no check at all
    expect(await createSupplierFromScreen(proc, { code: 'SCREEN-FOREIGN', nameTh: 'Overseas Bolts Ltd', nameEn: null, taxId: null, branchCode: '00000', isVatRegistered: false, isForeign: true, email: null, phone: null, address: null, category: null, expressVendorCode: null, registry: null }, randomUUID())).toMatchObject({ ok: true })
  })
})
