import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getRegistryProvider, setRegistryProvider, stubRegistry } from '@/integrations/registry'
import { prisma } from '@/server/db/client'
import { createSupplier, lookupRegistry } from '@/server/services/suppliers'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-15 (spec §7.15, BR-SUP-01 to BR-SUP-05, FR-SUP-001 AC1–AC3): PROCUREMENT types a tax id and the registries fill
// the supplier's name, address, branch, VAT status and juristic status to confirm; the server checks again when it
// saves and keeps what the registries said; when they cannot confirm, a person confirms with proof. Locally, in tests
// and in the demo the registries are the stub.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg({ doa: false })
})
afterEach(() => setRegistryProvider(null))

const proc = () => org.ctxOf('proc_officer', NOW)
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const code = () => `R-${randomUUID().slice(0, 8).toUpperCase()}`
const proof = async (by = 'proc_officer') =>
  (await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ภพ20.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member[by]! } })).id

describe('[FR-SUP-001/AC1] a tax id fills the supplier from the registries, confirmed before saving', () => {
  it('fills a supplier of the seed from both registries and keeps what they said when it saves', async () => {
    const proposal = ok(await lookupRegistry(proc(), { taxId: '0-9999-99000-01-2' }))
    expect(proposal).toEqual({
      taxId: '0999999000012',
      branchCode: '00000',
      outcome: 'FOUND',
      sources: ['STUB'],
      nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด',
      address: expect.stringContaining('กรุงเทพมหานคร'),
      isVatRegistered: true,
      juristicStatus: 'ยังดำเนินกิจการอยู่',
      individual: false,
    })
    // the user may change the name; the registry's values are kept to compare (BR-SUP-01)
    const created = ok(await createSupplier(proc(), { code: code(), nameTh: 'วัสดุก่อสร้างทดสอบ (สาขาไซต์)', taxId: '0999999000012', branchCode: '00000', registry: { check: 'LOOKUP' } }, key()))
    const row = await prisma.supplier.findUniqueOrThrow({ where: { id: created.supplierId } })
    expect(row).toMatchObject({ nameTh: 'วัสดุก่อสร้างทดสอบ (สาขาไซต์)', registrySource: 'STUB', registryStatus: 'ยังดำเนินกิจการอยู่', registryCheckedAt: NOW })
    expect(row.registryData).toMatchObject({ mode: 'stub', rd: { status: 'FOUND', record: { nameTh: 'บริษัท วัสดุก่อสร้างทดสอบ จำกัด' } } })
  })

  it('refuses an invalid tax id, and only PROCUREMENT looks up', async () => {
    expect(await lookupRegistry(proc(), { taxId: '0999999000013' })).toMatchObject({ ok: false, error: { details: { reason: 'TAX_ID_INVALID' } } })
    expect(await lookupRegistry(org.ctxOf('req_con', NOW), { taxId: '0999999000012' })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-SUP-001/AC2] when the registries cannot confirm, a person confirms with proof; individuals are checked at RD only', () => {
  it('saves with proof when the services do not answer, and refuses without it', async () => {
    const proposal = ok(await lookupRegistry(proc(), { taxId: '0999999000080' }))
    expect(proposal).toMatchObject({ outcome: 'UNAVAILABLE', sources: [], nameTh: null })
    expect(await createSupplier(proc(), { code: code(), nameTh: 'กรอกเอง', taxId: '0999999000080', registry: { check: 'LOOKUP' } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_PROOF_REQUIRED', outcome: 'UNAVAILABLE' } } })
    expect(await createSupplier(proc(), { code: code(), nameTh: 'กรอกเอง', taxId: '0999999000080' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'REGISTRY_CHECK_REQUIRED' } } })
    // proof uploaded by someone else is not proof of this user's check
    expect(await createSupplier(proc(), { code: code(), nameTh: 'กรอกเอง', taxId: '0999999000080', registry: { check: 'MANUAL', proofFileId: await proof('req_con') } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    const fileId = await proof()
    const created = ok(await createSupplier(proc(), { code: code(), nameTh: 'กรอกเอง', taxId: '0999999000080', registry: { check: 'MANUAL', proofFileId: fileId } }, key()))
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: created.supplierId } })).toMatchObject({ registrySource: 'MANUAL' })
    expect(await prisma.fileLink.findFirstOrThrow({ where: { subjectType: 'Supplier', subjectId: created.supplierId } })).toMatchObject({ kind: 'REGISTRY_PROOF', fileId })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: created.supplierId, type: 'supplier.registry_checked' } })).toMatchObject({ data: { outcome: 'UNAVAILABLE', sources: ['MANUAL'] } })
  })

  it('checks an individual at RD only, and shows a closed juristic person as such', async () => {
    expect(ok(await lookupRegistry(proc(), { taxId: '1234567890121' }))).toMatchObject({ outcome: 'FOUND', individual: true, nameTh: 'นายทดสอบ ผู้รับจ้าง', juristicStatus: null })
    expect(ok(await lookupRegistry(proc(), { taxId: '0999999000071' }))).toMatchObject({ outcome: 'FOUND', juristicStatus: 'เลิกกิจการ', isVatRegistered: null })
  })

  it('a foreign supplier skips the registries', async () => {
    expect(await createSupplier(proc(), { code: code(), nameTh: 'Foreign Tools GmbH', isForeign: true }, key())).toMatchObject({ ok: true })
  })
})

describe('[FR-SUP-001/AC3] the stub answers locally and in tests; the real services are never called here (BR-SUP-05)', () => {
  it('uses the stub by default, and a provider swapped in a test is the one called', async () => {
    expect(getRegistryProvider()).toBe(stubRegistry)
    const calls: string[] = []
    setRegistryProvider({ mode: 'stub', lookup: async (q) => (calls.push(q.taxId), { rd: { status: 'NOT_FOUND' }, dbd: { status: 'NOT_FOUND' } }) })
    expect(ok(await lookupRegistry(proc(), { taxId: '0999999000012' })).outcome).toBe('NOT_FOUND')
    expect(calls).toEqual(['0999999000012'])
  })
})
