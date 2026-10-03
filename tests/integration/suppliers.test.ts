import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { createSupplier, updateSupplier } from '@/server/services/suppliers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-02: the supplier register (§6.2 Supplier, §2.4 supplier.manage = PROCUREMENT). Tax ids follow BR-TAXID-01 (the
// golden cases of tests/golden/taxid.yaml); (tax id, branch) is unique; changes are checked against the version seen.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg({ doa: false })
})

const proc = () => org.ctxOf('proc_officer', NOW)
const events = (aggregateId: string) => prisma.event.findMany({ where: { aggregateId }, orderBy: { occurredAt: 'asc' }, select: { type: true, data: true } })
const code = () => `S-${randomUUID().slice(0, 8).toUpperCase()}`
/** A company certificate PROCUREMENT uploaded, for a supplier the registries cannot confirm (BR-SUP-03) */
const proof = async () =>
  (await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'หนังสือรับรอง.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.proc_officer! } })).id

describe('[GC-TAXID-01] [GC-TAXID-02] [GC-TAXID-05] the register checks Thai tax ids with mod-11 (BR-TAXID-01)', () => {
  it('stores a valid tax id without its dashes, with an event', async () => {
    const created = await createSupplier(proc(), { code: code(), nameTh: 'บริษัท ทดสอบ จำกัด', taxId: '1-2345-67890-12-1', expressVendorCode: 'V9001', registry: { check: 'LOOKUP' } }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: created.data.supplierId } })
    expect(row).toMatchObject({ taxId: '1234567890121', branchCode: '00000', isForeign: false, status: 'ACTIVE', expressVendorCode: 'V9001', createdById: org.member.proc_officer, version: 0, registrySource: 'STUB' })
    expect(await events(row.id)).toEqual([
      { type: 'supplier.created', data: { code: row.code, taxId: '1234567890121', branchCode: '00000', isForeign: false, registrySource: 'STUB', via: 'PROCUREMENT' } },
      { type: 'supplier.registry_checked', data: { taxId: '1234567890121', branchCode: '00000', sources: ['STUB'], outcome: 'FOUND' } },
    ])
  })

  it('refuses a tax id that fails mod-11 or is not 13 digits, and writes nothing', async () => {
    for (const taxId of ['1234567890122', '123456789012', null]) {
      const c = code()
      expect(await createSupplier(proc(), { code: c, nameTh: 'ผิด', taxId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'taxId', reason: 'TAX_ID_INVALID' } } })
      expect(await prisma.supplier.count({ where: { code: c } })).toBe(0)
    }
  })
})

describe('[S4-02] the supplier register', () => {
  it('accepts a foreign supplier without a Thai tax id', async () => {
    const created = await createSupplier(proc(), { code: code(), nameTh: 'Overseas Tools Ltd', isForeign: true, isVatRegistered: false }, key())
    expect(created).toMatchObject({ ok: true })
    if (created.ok) expect(await prisma.supplier.findUniqueOrThrow({ where: { id: created.data.supplierId } })).toMatchObject({ taxId: null, isForeign: true })
  })

  it('refuses a second supplier with the same tax id and branch, or the same code; another branch is a supplier of its own', async () => {
    const first = await createSupplier(proc(), { code: code(), nameTh: 'สาขาใหญ่', taxId: '0999999999991', registry: { check: 'MANUAL', proofFileId: await proof() } }, key())
    if (!first.ok) throw new Error(JSON.stringify(first.error))
    expect(await createSupplier(proc(), { code: code(), nameTh: 'ซ้ำ', taxId: '0999999999991', registry: { check: 'MANUAL', proofFileId: await proof() } }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { reason: 'SUPPLIER_EXISTS', supplierId: first.data.supplierId } },
    })
    expect(await createSupplier(proc(), { code: code(), nameTh: 'สาขา 1', taxId: '0999999999991', branchCode: '00001', registry: { check: 'MANUAL', proofFileId: await proof() } }, key())).toMatchObject({ ok: true })
    const taken = (await prisma.supplier.findUniqueOrThrow({ where: { id: first.data.supplierId } })).code
    expect(await createSupplier(proc(), { code: taken, nameTh: 'รหัสซ้ำ', taxId: '1234567890121', branchCode: '00009', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CODE_EXISTS' } } })
  })

  it('only PROCUREMENT manages the register (supplier.manage)', async () => {
    const c = code()
    for (const who of ['req_con', 'dm_con', 'ceo']) {
      expect(await createSupplier(org.ctxOf(who, NOW), { code: c, nameTh: 'ไม่มีสิทธิ์', taxId: '1234567890121', branchCode: '00008', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.supplier.count({ where: { code: c } })).toBe(0)
    const created = await createSupplier(proc(), { code: c, nameTh: 'มีสิทธิ์', taxId: '1234567890121', branchCode: '00008', registry: { check: 'LOOKUP' } }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    expect(await updateSupplier(org.ctxOf('req_con', NOW), { supplierId: created.data.supplierId, expectedVersion: 0, nameTh: 'แก้' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('updates against the version seen, records what changed, and refuses a stale or empty change', async () => {
    const created = await createSupplier(proc(), { code: code(), nameTh: 'ก่อนแก้', taxId: '1234567890121', branchCode: '00002', registry: { check: 'LOOKUP' } }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const supplierId = created.data.supplierId
    expect(await updateSupplier(proc(), { supplierId, expectedVersion: 0, nameTh: 'หลังแก้', expressVendorCode: 'V7777', status: 'INACTIVE' }, key())).toMatchObject({ ok: true, data: { version: 1 } })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } })).toMatchObject({ nameTh: 'หลังแก้', expressVendorCode: 'V7777', status: 'INACTIVE', version: 1 })
    expect((await events(supplierId)).at(-1)).toMatchObject({ type: 'supplier.updated', data: { changed: ['nameTh', 'expressVendorCode', 'status'] } })
    expect(await updateSupplier(proc(), { supplierId, expectedVersion: 0, nameTh: 'ช้าไป' }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    expect(await updateSupplier(proc(), { supplierId, expectedVersion: 1, nameTh: 'หลังแก้' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    expect(await updateSupplier(proc(), { supplierId, expectedVersion: 1, taxId: '1234567890122' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TAX_ID_INVALID' } } })
    expect(await updateSupplier(proc(), { supplierId: randomUUID(), expectedVersion: 0, nameTh: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})
