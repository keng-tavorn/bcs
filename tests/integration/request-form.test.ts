import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { POST as autosave } from '@/app/(workspace)/requests/new/autosave/route'
import { fund } from '@/core/budget'
import { BYTES_PER_MIB } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { systemCtx } from '@/server/context'
import { applyBudget } from '@/server/budget/ledger'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { budgetLineAvailability, doaGapNames, listFormBudgetLines, listMyOpenDrafts, listRequestCatalog, sentRequestSummary } from '@/server/queries/request-form'
import { runCommand } from '@/server/services/_pipeline'
import { decideTask } from '@/server/services/approvals/decide'
import { createBudgetGrant } from '@/server/services/budget/grants'
import { getDownloadUrl } from '@/server/services/files'
import { cancelRequest, createDraft, editRequest, resubmitRequest, submitRequest } from '../support/requests'
import { attachFile, detachFile } from '@/server/services/requests/attachments'
import { reportDoaGapCommand } from '@/server/services/requests/doa-gap'
import { getNewRequestForm, getRequestForEdit } from '@/server/services/requests/form-view'
import { previewRequest } from '@/server/services/requests/preview'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-11 · S3-06 · the screen side of S2-17 and S3-07: what the request form reads and the commands it sends — catalog,
// prefill, budget lines and their balance, the expected route, attachments and who may download them, drafts saved
// from two devices and by the autosave route, a returned request edited while it keeps its reservation, and the DOA gap
// reported to ORG_ADMIN although the submit is rolled back. Real Postgres, an organization built from the §7.4 fixtures;
// Monday 5 Oct 2026 10:00 Thai time (DOA-DEMO version 1 in effect).

const NOW = new Date('2026-10-05T03:00:00Z')
const DAY = '2026-10-05'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
const line: Record<string, string> = {}

beforeAll(async () => {
  org = await createDoaOrg()
  for (const code of ['admin', 'admin2']) {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member[code]!, role: 'ORG_ADMIN', grantedAt: NOW } })
  }
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  for (const l of await prisma.budgetLine.findMany({ where: { organizationId: org.organizationId } })) line[l.code] = l.id
})

/** A file the member uploaded (the upload itself is tested in files.test.ts) */
async function fileOf(memberCode: string, fileName = 'เอกสาร.pdf'): Promise<string> {
  const row = await prisma.fileObject.create({
    data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName, mimeType: 'application/pdf', sizeBytes: 1000, status: 'AVAILABLE', uploadedById: org.member[memberCode]! },
  })
  return row.id
}

/** One line of `price` baht that includes VAT, so the gross amount is exactly the price */
async function draftOf(requester: string, price: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await createDraft(
    org.ctxOf(requester, NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุสำนักงาน', priceIncludesVat: true, lines: [{ description: 'วัสดุ', quantity: '1', uom: 'ชุด', unitPrice: price }], ...extra },
    key(),
  )
  if (!r.ok) throw new Error(`draft failed: ${JSON.stringify(r.error)}`)
  return r.data.requestId
}

/** An extra budget line of a department, funded with `satang` (as an import would) */
async function fundedLine(departmentCode: string, code: string, satang: bigint): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const costCenter = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: `CC-${departmentCode}` } })
  const created = await prisma.budgetLine.create({
    data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department[departmentCode]!, costCenterId: costCenter.id, code, nameTh: `งบทดสอบ ${code}`, plannedSatang: 0n },
  })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: created.id } })
  const ctx = systemCtx(org.organizationId, NOW, 'test')
  const importId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const funded = await applyBudget(tx, ctx, [{ budgetLineId: created.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, satang, importId) }])
    if (!funded.ok) throw new Error('funding failed')
    await appendEvents(tx, ctx, funded.events)
  })
  return created.id
}

const preview = (requester: string, input: { budgetLineId?: string | null; requestId?: string; lines: Array<[string, string]>; priceIncludesVat?: boolean }) =>
  previewRequest(
    org.ctxOf(requester, NOW),
    {
      requestTypeCode: 'BUY_GOODS',
      budgetLineId: input.budgetLineId ?? null,
      requestId: input.requestId ?? null,
      priceIncludesVat: input.priceIncludesVat ?? true,
      lines: input.lines.map(([quantity, unitPrice]) => ({ quantity, unitPrice, vatable: true })),
    },
    'th',
  )

describe('[FR-INT-001/AC1] the catalog lists the active request types that have a published form', () => {
  it('in the organization’s order, without types switched off or without a form', async () => {
    await prisma.requestType.create({ data: { organizationId: org.organizationId, code: 'NO_FORM', nameTh: 'ไม่มีฟอร์ม', documentType: 'PURCHASE_REQUEST', sortOrder: 0 } })
    const off = await prisma.requestType.create({ data: { organizationId: org.organizationId, code: 'SWITCHED_OFF', nameTh: 'ปิดใช้', documentType: 'PURCHASE_REQUEST', active: false } })
    const form = await prisma.formVersion.create({ data: { organizationId: org.organizationId, requestTypeId: off.id, versionNo: 1, schema: { fields: [], visibility: [], rules: [] }, status: 'PUBLISHED' } })
    await prisma.requestType.update({ where: { id: off.id }, data: { currentFormVersionId: form.id } })
    await prisma.requestType.update({ where: { organizationId_code: { organizationId: org.organizationId, code: 'BUY_GOODS' } }, data: { descriptionTh: 'วัสดุ อุปกรณ์ สินค้าทั่วไป' } })

    const catalog = await listRequestCatalog(org.ctxOf('req_con', NOW), 'th')
    expect(catalog.map((t) => t.code).sort()).toEqual(['BUY_GOODS', 'HIRE_SERVICE', 'IT_PURCHASE', 'NEW_SUPPLIER'])
    expect(catalog.find((t) => t.code === 'BUY_GOODS')).toEqual({ code: 'BUY_GOODS', name: 'ซื้อของ', description: 'วัสดุ อุปกรณ์ สินค้าทั่วไป', documentType: 'PURCHASE_REQUEST' })
    // An organization without English names shows its own names to English readers
    expect((await listRequestCatalog(org.ctxOf('req_con', NOW), 'en')).find((t) => t.code === 'BUY_GOODS')?.name).toBe('ซื้อของ')
    // Opening a type that is switched off or has no form finds nothing
    expect(await getNewRequestForm(org.ctxOf('req_con', NOW), 'SWITCHED_OFF', 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getNewRequestForm(org.ctxOf('req_con', NOW), 'NO_FORM', 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('the catalog, the form, the preview and a new draft agree: a type whose current form is not published shows no card and opens nothing', async () => {
    const type = await prisma.requestType.create({ data: { organizationId: org.organizationId, code: 'NOT_PUBLISHED', nameTh: 'ฟอร์มยังไม่เผยแพร่', documentType: 'PURCHASE_REQUEST' } })
    const form = await prisma.formVersion.create({ data: { organizationId: org.organizationId, requestTypeId: type.id, versionNo: 1, schema: { fields: [], visibility: [], rules: [] }, status: 'DRAFT' } })
    await prisma.requestType.update({ where: { id: type.id }, data: { currentFormVersionId: form.id } })
    const ctx = org.ctxOf('req_con', NOW)
    expect((await listRequestCatalog(ctx, 'th')).map((t) => t.code)).not.toContain('NOT_PUBLISHED')
    expect(await getNewRequestForm(ctx, 'NOT_PUBLISHED', 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await previewRequest(ctx, { requestTypeCode: 'NOT_PUBLISHED', priceIncludesVat: false, lines: [{ quantity: '1', unitPrice: '100.00', vatable: true }] }, 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await createDraft(ctx, { requestTypeCode: 'NOT_PUBLISHED', title: 'ไม่ควรสร้างได้' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_PUBLISHED_FORM' } } })
  })
})

describe('[FR-INT-003/AC1] a new form is filled from the requester’s context (BR-FORM-02)', () => {
  it('the paying department, its budget line, today’s VAT rate and the form of the type', async () => {
    const opened = await getNewRequestForm(org.ctxOf('receiver_con', NOW), 'BUY_GOODS', 'th')
    if (!opened.ok) throw new Error(JSON.stringify(opened.error))
    const form = opened.data
    expect(form.requesterDepartmentName).toBe('ฝ่ายก่อสร้าง')
    expect(form.budgetLines.map((l) => [l.code, l.departmentName, l.granted])).toEqual([['CON-OPEX-2569', 'ฝ่ายก่อสร้าง', false]])
    // The department's only line is chosen for the requester
    expect(form.defaultBudgetLineId).toBe(line['CON-OPEX-2569'])
    expect(form.vatRateBp).toBe(700)
    expect(form.form.rules.map((r) => r.id)).toEqual(['ATT-QUOTES'])
    expect(form.attachmentKinds).not.toContain('QUOTATION')
    expect(form.attachmentKinds).toEqual(expect.arrayContaining(['DPA', 'OTHER']))
    expect(form.draft).toBeNull()
  })

  it('with several lines, the one the requester used last for the same type comes first; otherwise they choose', async () => {
    const capex = await fundedLine('CON', 'CON-CAPEX-TEST', 100_000_000n)
    const ctx = org.ctxOf('asst_con', NOW)
    // From now on CON has two lines: the requester chooses one
    expect(await getNewRequestForm(ctx, 'BUY_GOODS', 'th')).toMatchObject({ ok: true, data: { defaultBudgetLineId: null } })
    const id = await draftOf('asst_con', '1000.00', { budgetLineId: capex })
    expect(await submitRequest(ctx, { requestId: id }, key())).toMatchObject({ ok: true })
    expect(await getNewRequestForm(ctx, 'BUY_GOODS', 'th')).toMatchObject({ ok: true, data: { defaultBudgetLineId: capex } })
    // Another type was never used: the requester chooses
    expect(await getNewRequestForm(ctx, 'HIRE_SERVICE', 'th')).toMatchObject({ ok: true, data: { defaultBudgetLineId: null } })
  })
})

describe('[FR-INT-003/AC2] [FR-BUD-004/AC2] the form offers only the budget lines the requester may use', () => {
  it('their own department’s lines, and another department’s only through a grant in force', async () => {
    const ownOnly = (await listFormBudgetLines(org.ctxOf('req_con', NOW), DAY, 'th')).map((l) => l.code)
    expect(ownOnly).not.toContain('IT-OPEX-2569')
    const granted = await createBudgetGrant(org.ctxOf('fin_officer', NOW), { budgetLineId: line['IT-OPEX-2569']!, granteeMemberId: org.member.dm_con!, validFrom: '2026-10-01T00:00:00Z' }, key())
    expect(granted).toMatchObject({ ok: true })
    const offered = await listFormBudgetLines(org.ctxOf('dm_con', NOW), DAY, 'th')
    expect(offered.find((l) => l.code === 'IT-OPEX-2569')).toMatchObject({ granted: true, departmentName: 'ฝ่ายไอที' })
    expect((await listFormBudgetLines(org.ctxOf('req_con', NOW), DAY, 'th')).map((l) => l.code)).not.toContain('IT-OPEX-2569')
  })
})

describe('[FR-INT-004/AC1] the form shows what is left on the chosen line, and whether the amount before VAT fits', () => {
  it('only to a requester who may use the line (budget.view SELECTED_LINE_ONLY)', async () => {
    const own = await budgetLineAvailability(org.ctxOf('req_con', NOW), { budgetLineId: line['CON-OPEX-2569']!, day: DAY })
    expect(own).toMatchObject({ budgetLineId: line['CON-OPEX-2569'], departmentId: org.department.CON })
    // Another department's line without a grant: nothing is shown
    expect(await budgetLineAvailability(org.ctxOf('req_con', NOW), { budgetLineId: line['FIN-OPEX-2569']!, day: DAY })).toBeNull()
    expect(await preview('req_con', { budgetLineId: line['FIN-OPEX-2569']!, lines: [['1', '1000.00']] })).toMatchObject({ ok: true, data: { budget: { kind: 'NOT_USABLE' } } })
  })

  it('compares the amount before VAT with what is available (BR-BUD-03)', async () => {
    const before = await budgetLineAvailability(org.ctxOf('req_con', NOW), { budgetLineId: line['CON-OPEX-2569']!, day: DAY })
    const fits = await preview('req_con', { budgetLineId: line['CON-OPEX-2569']!, lines: [['1', '107000.00']] })
    expect(fits).toMatchObject({
      ok: true,
      data: {
        totals: { net: { amount: '100000.00' }, vat: { amount: '7000.00' }, gross: { amount: '107000.00' }, vatRateBp: 700 },
        budget: { kind: 'LINE', available: before!.available, need: { amount: '100000.00' }, enough: true, shortfall: { amount: '0.00' } },
      },
    })
    const available = BigInt(before!.available.amount.replace('.', ''))
    const tooMuch = await preview('req_con', { budgetLineId: line['CON-OPEX-2569']!, lines: [['2', before!.available.amount]], priceIncludesVat: false })
    expect(tooMuch).toMatchObject({ ok: true, data: { budget: { kind: 'LINE', enough: false } } })
    if (tooMuch.ok && tooMuch.data.budget.kind === 'LINE') expect(tooMuch.data.budget.shortfall.amount.replace('.', '')).toBe(String(available))
  })

  it('a returned request counts what it already holds as available to it', async () => {
    const id = await draftOf('req_con', '30000.00', { budgetLineId: line['CON-OPEX-2569'] })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: id } } } })
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการ' }, key())).toMatchObject({ ok: true })
    const held = await prisma.budgetAllocation.aggregate({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: (await prisma.requestLine.findMany({ where: { requestId: id } })).map((l) => l.id) } }, _sum: { reservedSatang: true } })
    const plain = await budgetLineAvailability(org.ctxOf('req_con', NOW), { budgetLineId: line['CON-OPEX-2569']!, day: DAY })
    const editing = await budgetLineAvailability(org.ctxOf('req_con', NOW), { budgetLineId: line['CON-OPEX-2569']!, day: DAY, requestId: id })
    expect(BigInt(editing!.available.amount.replace('.', '')) - BigInt(plain!.available.amount.replace('.', ''))).toBe(held._sum.reservedSatang)
    // Someone else's request id adds nothing
    const other = await budgetLineAvailability(org.ctxOf('asst_con', NOW), { budgetLineId: line['CON-OPEX-2569']!, day: DAY, requestId: id })
    expect(other!.available).toEqual(plain!.available)
  })
})

describe('[FR-INT-004/AC3] the submit checks the budget again under lock, because it may change while the form is filled in', () => {
  it('the form said it fits; another request took the budget first; the submit is refused with what is left and what is missing', async () => {
    // A line of 100,000.00 baht; two requests of 60,000.00 before VAT
    const tight = await fundedLine('FIN', 'FIN-TIGHT-2569', 10_000_000n)
    const first = await draftOf('fin_officer', '60000.00', { budgetLineId: tight, priceIncludesVat: false })
    const second = await draftOf('dm_fin', '60000.00', { budgetLineId: tight, priceIncludesVat: false })
    // Both forms show enough budget while neither is sent
    for (const [who, id] of [['fin_officer', first], ['dm_fin', second]] as const) {
      expect(await preview(who, { budgetLineId: tight, requestId: id, lines: [['1', '60000.00']], priceIncludesVat: false })).toMatchObject({ ok: true, data: { budget: { enough: true } } })
    }
    expect(await submitRequest(org.ctxOf('fin_officer', NOW), { requestId: first }, key())).toMatchObject({ ok: true })
    expect(await submitRequest(org.ctxOf('dm_fin', NOW), { requestId: second }, key())).toMatchObject({
      ok: false,
      error: { code: 'BUDGET_INSUFFICIENT', details: { available: '40000.00', shortfall: '20000.00' } },
    })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: 'DRAFT', number: null })
  })

  it('two submits at the same moment: the line is locked, so only one of them gets the budget', async () => {
    const tight = await fundedLine('IT', 'IT-TIGHT-2569', 10_000_000n)
    const a = await draftOf('dm_it', '60000.00', { budgetLineId: tight, priceIncludesVat: false })
    const b = await draftOf('admin', '60000.00', { budgetLineId: tight, priceIncludesVat: false })
    const results = await Promise.all([submitRequest(org.ctxOf('dm_it', NOW), { requestId: a }, key()), submitRequest(org.ctxOf('admin', NOW), { requestId: b }, key())])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.error.code)).toEqual(['BUDGET_INSUFFICIENT'])
    const balance = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: tight } })
    expect(balance).toMatchObject({ availableSatang: 4_000_000n, reservedSatang: 6_000_000n })
  })
})

describe('[FR-INT-006/AC2] the same draft open on two devices: the second save gets CONFLICT_VERSION', () => {
  it('a save names the version it was based on; an older one changes nothing; the requester reloads and goes on', async () => {
    const created = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ร่างสองเครื่อง' }, key())
    expect(created).toMatchObject({ ok: true, data: { version: 0 } })
    if (!created.ok) return
    const requestId = created.data.requestId
    const base = { requestId, budgetLineId: line['CON-OPEX-2569'], priceIncludesVat: false, lines: [{ description: 'กระดาษ', quantity: '5', uom: 'รีม', unitPrice: '120.00' }] }
    // Device A saves first
    expect(await editRequest(org.ctxOf('req_con', NOW), { ...base, title: 'จากโน้ตบุ๊ก', expectedVersion: 0 }, key())).toMatchObject({ ok: true, data: { version: 1 } })
    // Device B still has version 0
    expect(await editRequest(org.ctxOf('req_con', NOW), { ...base, title: 'จากมือถือ', expectedVersion: 0 }, key())).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT_VERSION', details: { expectedVersion: 0, version: 1 } },
    })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ title: 'จากโน้ตบุ๊ก', version: 1 })
    // Reloading gives B the latest version, and B goes on from it
    const reloaded = await getRequestForEdit(org.ctxOf('req_con', NOW), requestId, 'th')
    expect(reloaded).toMatchObject({ ok: true, data: { draft: { version: 1, title: 'จากโน้ตบุ๊ก' } } })
    expect(await editRequest(org.ctxOf('req_con', NOW), { ...base, title: 'จากมือถือ', expectedVersion: 1 }, key())).toMatchObject({ ok: true, data: { version: 2 } })
    // Sending names the version reviewed too
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId, expectedVersion: 1 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId, expectedVersion: 2, }, key())).toMatchObject({ ok: true })
  })

  it('a returned request sent again names its version too', async () => {
    const id = await draftOf('req_con', '25000.00', { budgetLineId: line['CON-OPEX-2569'] })
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: id } } } })
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'แก้ชื่อ' }, key())
    const version = (await prisma.request.findUniqueOrThrow({ where: { id } })).version
    expect(await resubmitRequest(org.ctxOf('req_con', NOW), { requestId: id, expectedVersion: version - 1 }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    expect(await resubmitRequest(org.ctxOf('req_con', NOW), { requestId: id, expectedVersion: version }, key())).toMatchObject({ ok: true })
  })
})

describe('[FR-INT-006/AC1] a draft opens again on any device with everything saved so far', () => {
  it('lines, answers, quotations with their files, attachments, and the version to save from', async () => {
    const quoteFile = await fileOf('req_con', 'ใบเสนอราคา-ก.pdf')
    const created = await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'BUY_GOODS',
        title: 'โต๊ะประชุม',
        budgetLineId: line['CON-OPEX-2569'],
        formData: { singleSourceJustification: 'ผู้ผลิตรายเดียว' },
        lines: [{ description: 'โต๊ะ', quantity: '2.5', uom: 'ตัว', unitPrice: '1234.50', vatable: false }],
        quotations: [{ supplierName: 'ร้านเฟอร์นิเจอร์', amount: '3086.25', includesVat: false, fileId: quoteFile, selected: true }],
      },
      key(),
    )
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const requestId = created.data.requestId
    const dpa = await fileOf('req_con', 'ข้อตกลง.pdf')
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId, fileId: dpa, kind: 'DPA' }, key())).toMatchObject({ ok: true })
    const opened = await getRequestForEdit(org.ctxOf('req_con', NOW), requestId, 'th')
    expect(opened).toMatchObject({
      ok: true,
      data: {
        type: { code: 'BUY_GOODS' },
        draft: {
          requestId,
          version: 0,
          status: 'DRAFT',
          title: 'โต๊ะประชุม',
          budgetLineId: line['CON-OPEX-2569'],
          formData: { singleSourceJustification: 'ผู้ผลิตรายเดียว' },
          lines: [{ description: 'โต๊ะ', quantity: '2.5', uom: 'ตัว', unitPrice: '1234.50', vatable: false, serviceEndDate: null }],
          quotations: [{ supplierName: 'ร้านเฟอร์นิเจอร์', amount: '3086.25', includesVat: false, fileId: quoteFile, fileName: 'ใบเสนอราคา-ก.pdf', selected: true }],
          // The quotation's file is its own; only files attached one by one are attachments
          attachments: [{ fileId: dpa, fileName: 'ข้อตกลง.pdf', kind: 'DPA' }],
        },
      },
    })
    expect(await listMyOpenDrafts(org.ctxOf('req_con', NOW), 'th', 50)).toEqual(expect.arrayContaining([expect.objectContaining({ id: requestId, title: 'โต๊ะประชุม', typeName: 'ซื้อของ', status: 'DRAFT' })]))
  })

  it('only its requester opens it for editing, and only until it is sent', async () => {
    const id = await draftOf('req_con', '500.00', { budgetLineId: line['CON-OPEX-2569'] })
    expect(await getRequestForEdit(org.ctxOf('asst_con', NOW), id, 'th')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getRequestForEdit(org.ctxOf('proc_officer', NOW), id, 'th')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await listMyOpenDrafts(org.ctxOf('asst_con', NOW), 'th', 50)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(await getRequestForEdit(org.ctxOf('req_con', NOW), id, 'th')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { status: 'PENDING_APPROVAL' } } })
    expect(await getRequestForEdit(org.ctxOf('req_con', NOW), randomUUID(), 'th')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('a quantity of zero is refused as invalid input, not left to the database', async () => {
    const r = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ศูนย์', lines: [{ description: 'ของ', quantity: '0.0000', uom: 'ชิ้น', unitPrice: '10.00' }] }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity' } } })
  })
})

/** Each line of a request with its amount before VAT and what it holds on the budget (INV-BUD-03: never more than its amount) */
async function holdsOf(requestId: string) {
  const lines = await prisma.requestLine.findMany({ where: { requestId }, orderBy: { lineNo: 'asc' } })
  const held = await prisma.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: lines.map((l) => l.id) } } })
  return lines.map((l) => ({ id: l.id, lineNo: l.lineNo, description: l.description, net: l.netSatang, reserved: held.filter((h) => h.sourceId === l.id).reduce((sum, h) => sum + h.reservedSatang, 0n) }))
}

const balanceOf = async (budgetLineId: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId }, select: { availableSatang: true, reservedSatang: true } })

/** budget.reservation_released events written for one request */
const releasesOf = (requestId: string) => prisma.event.count({ where: { type: 'budget.reservation_released', data: { path: ['documentId'], equals: requestId } } })

describe('[FR-INT-006/AC1] [FR-INT-009/AC2] a returned request keeps its reservation while it is edited and saved by itself (§6.4)', () => {
  const LINE = (description: string, unitPrice: string, id?: string | null) => ({ ...(id !== undefined ? { id } : {}), description, quantity: '1', uom: 'งาน', unitPrice })

  it('a save while a line is being typed leaves the lines alone; lines change by their ids; a line taken away gives back only its own share; the resubmit moves only the difference', async () => {
    const requester = org.ctxOf('req_con', NOW)
    const budgetLineId = line['CON-OPEX-2569']!
    const created = await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'ปูนและทราย', budgetLineId, priceIncludesVat: false, lines: [LINE('ปูน', '30000.00'), LINE('ทราย', '5000.00')] }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const id = created.data.requestId
    const [cement, sand] = created.data.lineIds as [string, string]
    expect(await submitRequest(requester, { requestId: id }, key())).toMatchObject({ ok: true })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: id } } } })
    expect(await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'แยกรายการปูนออก' }, key())).toMatchObject({ ok: true })
    const returned = await balanceOf(budgetLineId)
    expect(await holdsOf(id)).toMatchObject([
      { id: cement, description: 'ปูน', net: 3_000_000n, reserved: 3_000_000n },
      { id: sand, description: 'ทราย', net: 500_000n, reserved: 500_000n },
    ])
    const releasesBefore = await releasesOf(id)

    // 1) The autosave runs while ปูน's quantity is blank on screen: the save carries no lines, so nothing moves
    expect(await editRequest(requester, { requestId: id, title: 'ปูนและทราย (แก้)', priceIncludesVat: false, formData: {} }, key())).toMatchObject({ ok: true, data: { lineIds: [cement, sand] } })
    expect(await holdsOf(id)).toMatchObject([
      { id: cement, description: 'ปูน', reserved: 3_000_000n },
      { id: sand, description: 'ทราย', reserved: 500_000n },
    ])
    expect(await balanceOf(budgetLineId)).toEqual(returned)
    expect(await releasesOf(id)).toBe(releasesBefore)

    // 2) Saved in another order with a new description: each line keeps its own content and its own hold
    const reordered = await editRequest(requester, { requestId: id, lines: [LINE('ทรายหยาบ', '5000.00', sand), LINE('ปูน', '30000.00', cement)] }, key())
    expect(reordered).toMatchObject({ ok: true, data: { lineIds: [sand, cement] } })
    expect(await holdsOf(id)).toMatchObject([
      { id: sand, lineNo: 1, description: 'ทรายหยาบ', net: 500_000n, reserved: 500_000n },
      { id: cement, lineNo: 2, description: 'ปูน', net: 3_000_000n, reserved: 3_000_000n },
    ])
    expect(await balanceOf(budgetLineId)).toEqual(returned)

    // 3) The requester takes ปูน away (asked first on screen): its own share goes back at once (docs/sub-specs/S3.md);
    // ทราย keeps its own, and a new line holds nothing until the request is sent again
    const removed = await editRequest(requester, { requestId: id, lines: [LINE('ทรายหยาบ', '5000.00', sand), LINE('หิน', '2000.00', null)] }, key())
    if (!removed.ok) throw new Error(JSON.stringify(removed.error))
    const stone = removed.data.lineIds[1]!
    expect(removed.data.lineIds[0]).toBe(sand)
    expect(await holdsOf(id)).toMatchObject([
      { id: sand, description: 'ทรายหยาบ', net: 500_000n, reserved: 500_000n },
      { id: stone, description: 'หิน', net: 200_000n, reserved: 0n },
    ])
    expect(await balanceOf(budgetLineId)).toEqual({ availableSatang: returned.availableSatang + 3_000_000n, reservedSatang: returned.reservedSatang - 3_000_000n })
    expect(await prisma.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: cement }, select: { reservedSatang: true } })).toEqual([{ reservedSatang: 0n }])
    expect(await releasesOf(id)).toBe(releasesBefore + 1)
    // INV-BUD-03 after every save: no line holds more than its amount before VAT
    for (const h of await holdsOf(id)) expect(h.reserved <= h.net).toBe(true)

    // 4) Sent again: what the lines hold is given back and the new total reserved in one step — only 2,000.00 moves
    const beforeResubmit = await balanceOf(budgetLineId)
    expect(await resubmitRequest(requester, { requestId: id }, key())).toMatchObject({ ok: true })
    expect(await balanceOf(budgetLineId)).toEqual({ availableSatang: beforeResubmit.availableSatang - 200_000n, reservedSatang: beforeResubmit.reservedSatang + 200_000n })
    expect(await holdsOf(id)).toMatchObject([
      { id: sand, reserved: 500_000n },
      { id: stone, reserved: 200_000n },
    ])
  })

  it('a save naming a line of another request, or one line twice, is refused and changes nothing', async () => {
    const requester = org.ctxOf('req_con', NOW)
    const id = await draftOf('req_con', '1000.00')
    const other = await draftOf('req_con', '2000.00')
    const [own] = (await holdsOf(id)).map((h) => h.id)
    const [foreign] = (await holdsOf(other)).map((h) => h.id)
    expect(await editRequest(requester, { requestId: id, lines: [LINE('ของ', '1000.00', foreign)] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'lines.0.id', reason: 'LINE_ID' } } })
    expect(await editRequest(requester, { requestId: id, lines: [LINE('ของ', '1000.00', own), LINE('ของซ้ำ', '1000.00', own)] }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'lines.1.id', reason: 'LINE_ID' } },
    })
    // A new draft has no saved lines yet
    expect(await createDraft(requester, { requestTypeCode: 'BUY_GOODS', title: 'ใหม่', lines: [LINE('ของ', '1000.00', own)] }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'lines.0.id', reason: 'LINE_ID' } },
    })
    expect(await holdsOf(id)).toMatchObject([{ id: own, description: 'วัสดุ' }])
  })
})

describe('[FR-INT-006/AC1] a save changes only what it carries', () => {
  it('the stored title, urgency and needed-by date stay when a save leaves them out; null clears what may be cleared', async () => {
    const requester = org.ctxOf('req_con', NOW)
    const created = await createDraft(
      requester,
      { requestTypeCode: 'BUY_GOODS', title: 'ชื่อจริงของคำขอ', urgency: 'URGENT', neededBy: '2026-11-30', budgetLineId: line['CON-OPEX-2569'], nonLowestQuoteReason: 'ส่งเร็วกว่า', lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' }] },
      key(),
    )
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const id = created.data.requestId
    // The requester cleared the title to retype it: the autosave leaves it out
    expect(await editRequest(requester, { requestId: id, priceIncludesVat: true, formData: { singleSourceJustification: 'มีรายเดียว' } }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({
      title: 'ชื่อจริงของคำขอ',
      urgency: 'URGENT',
      neededBy: new Date('2026-11-30T00:00:00Z'),
      budgetLineId: line['CON-OPEX-2569'],
      nonLowestQuoteReason: 'ส่งเร็วกว่า',
      priceIncludesVat: true,
      formData: { singleSourceJustification: 'มีรายเดียว' },
    })
    expect(await editRequest(requester, { requestId: id, neededBy: null, budgetLineId: null, nonLowestQuoteReason: null }, key())).toMatchObject({ ok: true })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: 'ชื่อจริงของคำขอ', urgency: 'URGENT', neededBy: null, budgetLineId: null, nonLowestQuoteReason: null })
  })

  it('[FR-INT-002/AC1] every save drops the answers of fields the form hides now (BR-FORM-01) and refuses answers that are not fields of the form', async () => {
    const requester = org.ctxOf('req_con', NOW)
    const answers = { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }
    const created = await createDraft(requester, { requestTypeCode: 'IT_PURCHASE', title: 'ไลเซนส์', formData: { category: 'SOFTWARE', assetTag: 'X-1', ...answers } }, key())
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    const id = created.data.requestId
    // The asset tag is hidden for software: not stored
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).formData).toEqual({ category: 'SOFTWARE', ...answers })
    // Hardware shows it: stored
    expect(await editRequest(requester, { requestId: id, formData: { category: 'HARDWARE', assetTag: 'X-1', ...answers } }, key())).toMatchObject({ ok: true })
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).formData).toEqual({ category: 'HARDWARE', assetTag: 'X-1', ...answers })
    // An answer that is not a field of the form, or a value no field takes, is refused and nothing changes
    expect(await editRequest(requester, { requestId: id, formData: { category: 'HARDWARE', note: 'ไม่ใช่ช่องของฟอร์ม' } }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'formData.note', reason: 'FORM_FIELD_UNKNOWN' } },
    })
    expect(await editRequest(requester, { requestId: id, formData: { category: { nested: 'x' } } as never }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await createDraft(requester, { requestTypeCode: 'IT_PURCHASE', title: 'ไลเซนส์', formData: { 'not a field': 'x' } }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).formData).toEqual({ category: 'HARDWARE', assetTag: 'X-1', ...answers })
  })
})

describe('[FR-INT-006/AC1] [FR-INT-002/AC1] only the requester saves their draft; a member who is not active opens no form and saves nothing', () => {
  it('another member’s save of the draft is refused and changes nothing (request.create OWN)', async () => {
    const id = await draftOf('req_con', '1000.00')
    const before = await prisma.request.findUniqueOrThrow({ where: { id } })
    expect(await editRequest(org.ctxOf('asst_con', NOW), { requestId: id, title: 'แก้โดยคนอื่น', lines: [{ description: 'ของ', quantity: '9', uom: 'ชิ้น', unitPrice: '9.00' }] }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(await editRequest(org.ctxOf('proc_officer', NOW), { requestId: id, title: 'แก้โดยฝ่ายจัดซื้อ' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: before.title, version: before.version })
    expect(await holdsOf(id)).toMatchObject([{ description: 'วัสดุ', net: 100_000n }])
  })

  it('a deactivated member is refused the form, the preview and a new draft (FORBIDDEN)', async () => {
    const gone = await prisma.member.create({
      data: { organizationId: org.organizationId, displayNameTh: 'ผู้ใช้ที่พ้นสภาพ', email: `gone-${randomUUID()}@test.bcs.local`, status: 'DEACTIVATED', primaryDepartmentId: org.department.CON! },
    })
    const ctx = { ...org.ctxOf('req_con', NOW), actor: { type: 'USER' as const, memberId: gone.id } }
    expect(await getNewRequestForm(ctx, 'BUY_GOODS', 'th')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await previewRequest(ctx, { requestTypeCode: 'BUY_GOODS', priceIncludesVat: false, lines: [{ quantity: '1', unitPrice: '100.00', vatable: true }] }, 'th')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createDraft(ctx, { requestTypeCode: 'BUY_GOODS', title: 'ไม่ควรสร้างได้' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.request.count({ where: { requesterMemberId: gone.id } })).toBe(0)
  })
})

const PASSWORD = 'request-form-autosave-9'

/** Signs the member in through Better Auth's HTTP handler (the path a browser uses) and returns the session cookie */
async function sessionCookie(code: string): Promise<string> {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })
  const userId = await upsertUserWithPassword({ email: member.email, name: member.displayNameTh, password: PASSWORD })
  await prisma.member.update({ where: { id: member.id }, data: { userId } })
  const env = getEnv()
  const res = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': `198.18.61.${Math.floor(Math.random() * 200) + 1}` },
      body: JSON.stringify({ email: member.email, password: PASSWORD }),
    }),
  )
  expect(res.status).toBe(200)
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

const AUTOSAVE_URL = 'http://localhost:3101/requests/new/autosave'
const save = (body: string, headers: Record<string, string> = {}) => autosave(new Request(AUTOSAVE_URL, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost:3101', ...headers }, body }))
const draftBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    idempotencyKey: randomUUID(),
    requestId: null,
    requestTypeCode: 'BUY_GOODS',
    expectedVersion: null,
    draft: { title: 'จากหน้าฟอร์ม', budgetLineId: line['CON-OPEX-2569'], priceIncludesVat: false, formData: {}, lines: [{ id: null, description: 'กระดาษ', quantity: '5', uom: 'รีม', unitPrice: '120.00', vatable: true }], quotations: [] },
    ...extra,
  })

describe('[FR-INT-006/AC1] the autosave route: the signed-in requester only, from this site only, a draft of reasonable size', () => {
  it('answers 401 without a session, 403 for another site, 400 for a body that is not a draft and 413 above 1 MB', async () => {
    expect(await (await save(draftBody())).json()).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
    expect((await save(draftBody())).status).toBe(401)
    const cookie = await sessionCookie('req_con')
    const foreign = await save(draftBody(), { cookie, origin: 'https://evil.example' })
    expect([foreign.status, await foreign.json()]).toEqual([403, { ok: false, code: 'FORBIDDEN' }])
    expect((await save(draftBody(), { cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const broken = await save('{"idempotencyKey": not json', { cookie })
    expect([broken.status, await broken.json()]).toMatchObject([400, { ok: false, code: 'VALIDATION_FAILED' }])
    expect((await save(JSON.stringify({ requestId: null }), { cookie })).status).toBe(400)
    const huge = await save(draftBody({ draft: { title: 'ใหญ่', formData: { singleSourceJustification: 'ก'.repeat(BYTES_PER_MIB) } } }), { cookie })
    expect([huge.status, await huge.json()]).toEqual([413, { ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' }])
    expect(await prisma.request.count({ where: { requesterMemberId: org.member.req_con, title: 'ใหญ่' } })).toBe(0)
  })

  it('creates the draft on the first save and edits it after; another member’s save of it is refused with 403', async () => {
    const cookie = await sessionCookie('req_con')
    const created = await save(draftBody(), { cookie, origin: 'http://localhost:3101' })
    expect(created.status).toBe(200)
    const first = (await created.json()) as { ok: true; requestId: string; version: number; lineIds: string[] }
    expect(first).toMatchObject({ ok: true, version: 0 })
    expect(first.lineIds).toHaveLength(1)
    const edited = await save(
      JSON.stringify({
        idempotencyKey: randomUUID(),
        requestId: first.requestId,
        requestTypeCode: 'BUY_GOODS',
        expectedVersion: 0,
        draft: { title: 'จากหน้าฟอร์ม (แก้)', priceIncludesVat: false, formData: {}, lines: [{ id: first.lineIds[0], description: 'กระดาษ A4', quantity: '5', uom: 'รีม', unitPrice: '120.00', vatable: true }] },
      }),
      { cookie },
    )
    expect(await edited.json()).toEqual({ ok: true, requestId: first.requestId, version: 1, lineIds: first.lineIds })

    const intruder = await save(
      JSON.stringify({ idempotencyKey: randomUUID(), requestId: first.requestId, requestTypeCode: 'BUY_GOODS', expectedVersion: 1, draft: { title: 'แก้โดยคนอื่น', priceIncludesVat: false, formData: {} } }),
      { cookie: await sessionCookie('asst_con') },
    )
    expect([intruder.status, await intruder.json()]).toEqual([403, { ok: false, code: 'FORBIDDEN' }])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: first.requestId } })).toMatchObject({ title: 'จากหน้าฟอร์ม (แก้)', version: 1 })
    // An older version is refused as a conflict (409), so the form offers the latest one
    const stale = await save(
      JSON.stringify({ idempotencyKey: randomUUID(), requestId: first.requestId, requestTypeCode: 'BUY_GOODS', expectedVersion: 0, draft: { title: 'จากอีกเครื่อง', priceIncludesVat: false, formData: {} } }),
      { cookie },
    )
    expect([stale.status, await stale.json()]).toMatchObject([409, { ok: false, code: 'CONFLICT_VERSION' }])
  })
})

describe('[FR-DOA-003/AC2] right after sending, the requester sees the number and who decides it now', () => {
  it('the sent request’s number and its approver; nothing for someone else’s request', async () => {
    const id = await draftOf('req_con', '45000.00', { budgetLineId: line['CON-OPEX-2569'] })
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    if (!sent.ok) throw new Error(JSON.stringify(sent.error))
    expect(await sentRequestSummary(org.ctxOf('req_con', NOW), id, 'th')).toEqual({ number: sent.data.number, waitingFor: [{ name: 'ผู้ใช้ vp_ops', principalName: null }] })
    expect(await sentRequestSummary(org.ctxOf('asst_con', NOW), id, 'th')).toBeNull()
    // Cancelled: nobody decides it any more
    expect(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true })
    expect(await sentRequestSummary(org.ctxOf('req_con', NOW), id, 'th')).toMatchObject({ number: sent.data.number, waitingFor: [] })
  })
})

describe('[FR-PLT-004/AC2] files attached to a request: by its requester, downloaded by those who may view the request', () => {
  it('the requester attaches a file of a kind and takes it off again; each is a change of the draft (request.drafted) naming the file', async () => {
    const id = await draftOf('req_con', '1500.00', { budgetLineId: line['CON-OPEX-2569'] })
    const file = await fileOf('req_con')
    const attached = await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: file, kind: 'DPA' }, key())
    expect(attached).toMatchObject({ ok: true, data: { requestId: id, fileId: file, kind: 'DPA' } })
    expect(await prisma.fileLink.findMany({ where: { subjectType: 'Request', subjectId: id }, select: { fileId: true, kind: true } })).toEqual([{ fileId: file, kind: 'DPA' }])
    const fileEvents = () => prisma.event.findMany({ where: { aggregateId: id, type: 'request.drafted', data: { path: ['file', 'fileId'], equals: file } }, orderBy: { seq: 'asc' } })
    expect(await fileEvents()).toMatchObject([{ data: { requestTypeCode: 'BUY_GOODS', lines: 1, file: { action: 'ATTACHED', fileId: file, kinds: ['DPA'] } }, actorMemberId: org.member.req_con }])
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: file, kind: 'OTHER' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ALREADY_ATTACHED' } } })

    expect(await detachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: file }, key())).toMatchObject({ ok: true })
    expect(await prisma.fileLink.count({ where: { subjectType: 'Request', subjectId: id } })).toBe(0)
    expect((await fileEvents()).map((e) => e.data)).toMatchObject([{ file: { action: 'ATTACHED' } }, { file: { action: 'DETACHED', fileId: file, kinds: ['DPA'] } }])
    expect(await detachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: file }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('refuses another member, someone else’s file, quotation files one by one, kinds no rule asks for, and a sent request', async () => {
    const id = await draftOf('req_con', '1500.00', { budgetLineId: line['CON-OPEX-2569'] })
    const own = await fileOf('req_con')
    // Deny: only the requester changes the attachments of their request (request.create OWN)
    expect(await attachFile(org.ctxOf('asst_con', NOW), { requestId: id, fileId: await fileOf('asst_con'), kind: 'OTHER' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: await fileOf('asst_con'), kind: 'OTHER' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: own, kind: 'QUOTATION' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'USE_QUOTATIONS' } } })
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: own, kind: 'INVOICE' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'KIND' } } })
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: own, kind: 'OTHER' }, key())).toMatchObject({ ok: true })
    expect(await detachFile(org.ctxOf('asst_con', NOW), { requestId: id, fileId: own }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: await fileOf('req_con'), kind: 'OTHER' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await detachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: own }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('a quotation’s file is not taken off one by one: it goes with its quotation', async () => {
    const quoteFile = await fileOf('req_con')
    const id = await draftOf('req_con', '900.00', { quotations: [{ supplierName: 'ผู้ขาย', amount: '900.00', includesVat: true, fileId: quoteFile, selected: true }] })
    expect(await detachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: quoteFile }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.fileLink.count({ where: { subjectType: 'Request', subjectId: id, kind: 'QUOTATION' } })).toBe(1)
  })

  it('downloads: the requester, the approver given the task and organization-wide readers — no other member, no other organization', async () => {
    const id = await draftOf('req_con', '45000.00', { budgetLineId: line['CON-OPEX-2569'] })
    const file = await fileOf('req_con')
    await attachFile(org.ctxOf('req_con', NOW), { requestId: id, fileId: file, kind: 'OTHER' }, key())
    const url = async (who: string) => getDownloadUrl(org.ctxOf(who, NOW), { fileId: file })

    const own = await url('req_con')
    expect(own).toMatchObject({ ok: true })
    if (own.ok) expect(Number(new URL(own.data.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    // Deny: a colleague of the same department with no part in the request, and the head of another line of departments
    expect(await url('asst_con')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await url('vp_sup')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // The VP of OPS heads the line CON belongs to (request.view DEPT_HEAD, §2.4) before any task is theirs
    expect(await url('vp_ops')).toMatchObject({ ok: true })
    // PROCUREMENT reads every request of the organization (request.view ORG)
    expect(await url('proc_officer')).toMatchObject({ ok: true })
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    // The VP of OPS now also has the task (ASSIGNED); the colleague and the other VP still do not
    expect(await url('vp_ops')).toMatchObject({ ok: true })
    expect(await url('asst_con')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await url('vp_sup')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const stranger = await createDoaOrg()
    expect(await getDownloadUrl(stranger.ctxOf('req_con', NOW), { fileId: file })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('[FR-DOA-003/AC2] before sending, the requester sees the expected route with its Thai explanation', () => {
  it('45,000 baht of CON goes to the VP of OPS under rule PR-02, and the preview writes nothing', async () => {
    const events = await prisma.event.count({ where: { organizationId: org.organizationId } })
    const routes = await prisma.approvalRoute.count({ where: { organizationId: org.organizationId } })
    const r = await preview('req_con', { budgetLineId: line['CON-OPEX-2569'], lines: [['1', '45000.00']] })
    expect(r).toMatchObject({
      ok: true,
      data: {
        route: {
          kind: 'ROUTE',
          doaCode: 'DOA-DEMO',
          versionNo: 1,
          ruleCode: 'PR-02',
          escalatedFromRuleCode: null,
          amountBasis: 'GROSS',
          basisAmount: { amount: '45000.00' },
          band: { over: { amount: '20000.00' }, upTo: { amount: '100000.00' } },
          steps: [{ stepNo: 1, assigneeName: 'ผู้ใช้ vp_ops', principalName: null, position: 'VP', departmentName: 'สายปฏิบัติการ' }],
        },
      },
    })
    if (r.ok && r.data.route.kind === 'ROUTE') expect(r.data.route.explanationTh).toContain('DOA-DEMO ฉบับ 1 ข้อ PR-02')
    expect(await prisma.event.count({ where: { organizationId: org.organizationId } })).toBe(events)
    expect(await prisma.approvalRoute.count({ where: { organizationId: org.organizationId } })).toBe(routes)
  })

  it('English readers see the approver’s English name when the organization has one (the Thai name otherwise)', async () => {
    const english = (who: string) =>
      previewRequest(org.ctxOf(who, NOW), { requestTypeCode: 'BUY_GOODS', budgetLineId: line['CON-OPEX-2569'], priceIncludesVat: true, lines: [{ quantity: '1', unitPrice: '45000.00', vatable: true }] }, 'en')
    expect(await english('req_con')).toMatchObject({ ok: true, data: { route: { steps: [{ assigneeName: 'ผู้ใช้ vp_ops' }] } } })
    await prisma.member.update({ where: { id: org.member.vp_ops! }, data: { displayNameEn: 'Weera Operations' } })
    try {
      expect(await english('req_con')).toMatchObject({ ok: true, data: { route: { steps: [{ assigneeName: 'Weera Operations' }] } } })
      expect(await preview('req_con', { budgetLineId: line['CON-OPEX-2569'], lines: [['1', '45000.00']] })).toMatchObject({ ok: true, data: { route: { steps: [{ assigneeName: 'ผู้ใช้ vp_ops' }] } } })
    } finally {
      await prisma.member.update({ where: { id: org.member.vp_ops! }, data: { displayNameEn: null } })
    }
  })

  it('a draft is previewed with its own request type, whatever type the screen names', async () => {
    const supplier = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'NEW_SUPPLIER', title: 'ผู้ขายใหม่', formData: { supplierName: 'บริษัท ก' } }, key())
    if (!supplier.ok) throw new Error(JSON.stringify(supplier.error))
    const asPurchase = await previewRequest(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', requestId: supplier.data.requestId, priceIncludesVat: false, lines: [{ quantity: '1', unitPrice: '45000.00', vatable: true }] }, 'th')
    expect(asPurchase).toMatchObject({ ok: true, data: { route: { kind: 'NO_ROUTE' }, budget: { kind: 'NONE' } } })
  })

  it('a department manager asking for their own department moves up a band (BR-DOA-06); a line of another department routes to its owners (BR-DOA-05)', async () => {
    expect(await preview('dm_con', { budgetLineId: line['CON-OPEX-2569'], lines: [['1', '15000.00']] })).toMatchObject({
      ok: true,
      data: { route: { kind: 'ROUTE', ruleCode: 'PR-02', escalatedFromRuleCode: 'PR-01', steps: [{ assigneeName: 'ผู้ใช้ vp_ops' }] } },
    })
    // dm_con holds a grant on IT's line (above): IT's manager decides
    expect(await preview('dm_con', { budgetLineId: line['IT-OPEX-2569'], lines: [['1', '5000.00']] })).toMatchObject({
      ok: true,
      data: { route: { kind: 'ROUTE', ruleCode: 'PR-01', steps: [{ assigneeName: 'ผู้ใช้ dm_it', departmentName: 'ฝ่ายไอที' }] } },
    })
    expect(await preview('req_con', { lines: [] })).toMatchObject({ ok: true, data: { route: { kind: 'NEEDS_AMOUNT' } } })
  })

  it('only the requester previews their own request', async () => {
    const id = await draftOf('req_con', '700.00')
    expect(await preview('asst_con', { requestId: id, lines: [['1', '700.00']] })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-DOA-003/AC3] when the DOA cannot route a request, the requester is told whom to contact and ORG_ADMIN is told', () => {
  it('a vacant VP: the preview says why; the refused submit still tells the administrators, once per gap, and says how many were told', async () => {
    const id = await draftOf('req_con', '30000.00', { budgetLineId: line['CON-OPEX-2569'] })
    await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.vp_ops }, data: { validTo: new Date('2026-10-01T00:00:00Z') } })
    try {
      const blocked = await preview('req_con', { requestId: id, budgetLineId: line['CON-OPEX-2569'], lines: [['1', '30000.00']] })
      expect(blocked).toMatchObject({
        ok: true,
        data: { route: { kind: 'BLOCKED', code: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02', position: 'VP', departments: ['ฝ่ายก่อสร้าง', 'สายปฏิบัติการ', 'สำนักงานใหญ่'] } },
      })
      // Whom to contact is said by role on the screen: no administrator's name leaves the server (personal data)
      expect(blocked.ok && blocked.data).not.toHaveProperty('contacts')
      const sameKey = key()
      const refused = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, sameKey)
      expect(refused).toMatchObject({ ok: false, error: { code: 'APPROVER_NOT_FOUND', details: { ruleCode: 'PR-02', position: 'VP', departments: ['CON', 'OPS', 'HQ'], adminsNotified: 2 } } })
      // The screen names them in words
      expect(await doaGapNames(org.ctxOf('req_con', NOW), { position: 'VP', departments: ['CON', 'OPS', 'HQ'] }, 'th')).toEqual({
        position: 'VP',
        departments: ['ฝ่ายก่อสร้าง', 'สายปฏิบัติการ', 'สำนักงานใหญ่'],
      })
      // The submit itself left nothing behind (FR-INT-007 AC1) ...
      expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DRAFT', number: null })
      expect(await prisma.approvalRoute.count({ where: { subjectId: id } })).toBe(0)
      // ... but the gap was recorded on the request and both administrators were told
      const notified = await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'admin.doa_gap', subjectId: id }, orderBy: { recipientMemberId: 'asc' } })
      expect(notified.map((n) => n.recipientMemberId).sort()).toEqual([org.member.admin!, org.member.admin2!].sort())
      expect(notified[0]).toMatchObject({ urgency: 'IMMEDIATE', data: { requestId: id, code: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02', position: 'VP' } })
      const reported = await prisma.event.findMany({ where: { aggregateId: id, type: 'request.doa_gap_reported' } })
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({ actorMemberId: org.member.req_con, data: { code: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02', position: 'VP', notifiedAdmins: 2 } })
      // The same submission sent again replays the report; a new attempt records it but tells nobody twice
      await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, sameKey)
      expect(await prisma.event.count({ where: { aggregateId: id, type: 'request.doa_gap_reported' } })).toBe(1)
      await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
      expect(await prisma.event.count({ where: { aggregateId: id, type: 'request.doa_gap_reported' } })).toBe(2)
      expect(await prisma.notification.count({ where: { organizationId: org.organizationId, templateKey: 'admin.doa_gap', subjectId: id } })).toBe(2)
    } finally {
      await prisma.positionAssignment.updateMany({ where: { organizationId: org.organizationId, memberId: org.member.vp_ops }, data: { validTo: null } })
    }
    // Fixed: the same request goes through
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true })
  })

  it('no DOA in effect: DOA_NOT_CONFIGURED, and ORG_ADMIN is told', async () => {
    const bare = await createDoaOrg({ doa: false })
    await prisma.roleAssignment.create({ data: { organizationId: bare.organizationId, memberId: bare.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const draft = await createDraft(bare.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ก่อนมี DOA', lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(bare.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { adminsNotified: 1 } } })
    expect(await prisma.notification.findFirstOrThrow({ where: { organizationId: bare.organizationId, templateKey: 'admin.doa_gap' } })).toMatchObject({
      recipientMemberId: bare.member.admin,
      data: { code: 'DOA_NOT_CONFIGURED', ruleCode: null, position: null },
    })
    // The preview gives the same reason before the requester presses send
    expect(await previewRequest(bare.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', requestId: draft.data.requestId, priceIncludesVat: false, lines: [{ quantity: '1', unitPrice: '100.00', vatable: true }] }, 'th')).toMatchObject({
      ok: true,
      data: { route: { kind: 'BLOCKED', code: 'DOA_NOT_CONFIGURED' } },
    })
  })

  it('the CEO asking above the last band: NO_HIGHER_AUTHORITY in the preview and at submit, and ORG_ADMIN is told (GC-DOA-11)', async () => {
    const ceo = org.ctxOf('ceo', NOW)
    const quoteFile = await fileOf('ceo', 'ใบเสนอราคา.pdf')
    // 150,000.00 including VAT: ATT-QUOTES applies, met by one quotation and a single-source justification
    const id = await draftOf('ceo', '150000.00', {
      budgetLineId: line['HQ-OPEX-2569'],
      formData: { singleSourceJustification: 'ผู้ผลิตรายเดียว' },
      quotations: [{ supplierName: 'ผู้ผลิต', amount: '150000.00', includesVat: true, fileId: quoteFile, selected: true }],
    })
    expect(await previewRequest(ceo, { requestTypeCode: 'BUY_GOODS', requestId: id, budgetLineId: line['HQ-OPEX-2569'], priceIncludesVat: true, lines: [{ quantity: '1', unitPrice: '150000.00', vatable: true }] }, 'th')).toMatchObject({
      ok: true,
      data: { route: { kind: 'BLOCKED', code: 'NO_HIGHER_AUTHORITY', ruleCode: 'PR-03' } },
    })
    const refused = await submitRequest(ceo, { requestId: id }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY', details: { ruleCode: 'PR-03', adminsNotified: 2 } } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'DRAFT', number: null })
    const told = await prisma.notification.findMany({ where: { organizationId: org.organizationId, templateKey: 'admin.doa_gap', subjectId: id } })
    expect(told.map((n) => n.recipientMemberId).sort()).toEqual([org.member.admin!, org.member.admin2!].sort())
    expect(told[0]).toMatchObject({ urgency: 'IMMEDIATE', data: { requestId: id, code: 'NO_HIGHER_AUTHORITY', ruleCode: 'PR-03' } })
    expect(await prisma.event.count({ where: { aggregateId: id, type: 'request.doa_gap_reported', data: { path: ['code'], equals: 'NO_HIGHER_AUTHORITY' } } })).toBe(1)
  })

  it('with no active administrator nobody can be told, and the refusal says so (adminsNotified 0)', async () => {
    const lonely = await createDoaOrg({ doa: false })
    const draft = await createDraft(lonely.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไม่มีผู้ดูแล', lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' }] }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(lonely.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { adminsNotified: 0 } } })
    expect(await prisma.notification.count({ where: { organizationId: lonely.organizationId, templateKey: 'admin.doa_gap' } })).toBe(0)
  })

  it('only the requester’s own refused submit reports a gap (request.submit OWN)', async () => {
    const id = await draftOf('req_con', '30000.00')
    const input = { requestId: id, code: 'APPROVER_NOT_FOUND', ruleCode: 'PR-02', position: 'VP', departments: ['CON'] }
    expect(await runCommand(org.ctxOf('asst_con', NOW), reportDoaGapCommand, input, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await prisma.event.count({ where: { aggregateId: id, type: 'request.doa_gap_reported' } })).toBe(0)
  })
})

describe('[FR-INT-002/AC1] the server checks the form again: hidden fields are dropped, visible required ones must be answered', () => {
  const answers = { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }
  const itDraft = async (formData: Record<string, string>, serviceEndDate?: string) => {
    const r = await createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'IT_PURCHASE',
        title: 'ไลเซนส์',
        budgetLineId: line['CON-OPEX-2569'],
        formData,
        lines: [{ description: 'ไลเซนส์ 1 ปี', quantity: '1', uom: 'ชุด', unitPrice: '12000.00', ...(serviceEndDate ? { serviceEndDate } : {}) }],
      },
      key(),
    )
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    return r.data.requestId
  }

  it('an asset tag typed while the category was hardware is dropped once it is software — at the save and again at submit', async () => {
    const id = await itDraft({ category: 'SOFTWARE', assetTag: 'X-1', ...answers }, '2027-10-31')
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).formData).toEqual({ category: 'SOFTWARE', ...answers })
    // A hidden answer stored some other way (an older draft) is dropped by the submit's own check (BR-FORM-01)
    await prisma.request.update({ where: { id }, data: { formData: { category: 'SOFTWARE', assetTag: 'X-1', ...answers } } })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true })
    expect((await prisma.request.findUniqueOrThrow({ where: { id } })).formData).toEqual({ category: 'SOFTWARE', ...answers })
  })

  it('a visible required answer that is missing is refused, naming the field', async () => {
    const id = await itDraft({ ...answers })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'formData.category', reason: 'FORM' } } })
  })
})
