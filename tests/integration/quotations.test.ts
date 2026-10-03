import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { satangToAmount } from '@/core/money/dto'
import { prisma } from '@/server/db/client'
import { formDefinition } from '@/server/forms/schema'
import { createDraft, editRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S2-17 (FR-INT-005 AC4–AC5, BR-FORM-05, BR-FORM-06): quotations are data compared before VAT, with a reason when the
// chosen one is not the lowest; IT and service requests ask three screening questions, and a supplier that processes
// personal data needs a DPA; service and licence lines carry the day the service ends.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
beforeAll(async () => {
  org = await createDoaOrg()
})

/** A file the member uploaded (the upload itself is tested in files.test.ts) */
async function fileOf(memberCode: string): Promise<string> {
  const row = await prisma.fileObject.create({
    data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'ใบเสนอราคา.pdf', mimeType: 'application/pdf', sizeBytes: 1000, status: 'AVAILABLE', uploadedById: org.member[memberCode]! },
  })
  return row.id
}

/** GC-FORM-09 to GC-FORM-11: A 107,000 with VAT, B 101,000 without, C 105,000 with VAT; C is the lowest before VAT */
async function quotes(selected: 'A' | 'B' | 'C') {
  const amounts = { A: ['107000.00', true], B: ['101000.00', false], C: ['105000.00', true] } as const
  return Promise.all(
    (['A', 'B', 'C'] as const).map(async (ref) => ({ supplierName: `ผู้ขาย ${ref}`, amount: amounts[ref][0], includesVat: amounts[ref][1], fileId: await fileOf('req_con'), selected: ref === selected })),
  )
}

const LINE = { description: 'เครื่องผสมปูน', quantity: '1', uom: 'เครื่อง', unitPrice: '107000.00' }

describe('[FR-INT-005/AC4] quotations are data, compared before VAT (GC-FORM-09 to GC-FORM-11)', () => {
  it('refuses the chosen quotation that is not the lowest without a reason, and accepts it with one', async () => {
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องผสมปูน', priceIncludesVat: true, lines: [LINE], quotations: await quotes('A') }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    const requestId = draft.data.requestId
    // Each quotation's file is a QUOTATION attachment, so ATT-QUOTES (above 100,000 baht) sees three
    expect(await prisma.fileLink.count({ where: { subjectType: 'Request', subjectId: requestId, kind: 'QUOTATION' } })).toBe(3)

    // GC-FORM-10: A is not the lowest before VAT (C is) and no reason is given
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'nonLowestQuoteReason', rule: 'QUOTE-LOWEST', lowest: [2] } },
    })
    // GC-FORM-11: with a reason it goes
    const quotations = (await prisma.requestQuotation.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } })).map((q, i) => ({
      supplierName: q.supplierName,
      amount: satangToAmount(q.amountSatang),
      includesVat: q.includesVat,
      fileId: q.fileId!,
      selected: i === 0,
    }))
    expect(await editRequest(org.ctxOf('req_con', NOW), { requestId, title: 'เครื่องผสมปูน', priceIncludesVat: true, lines: [LINE], quotations, nonLowestQuoteReason: 'ส่งของได้เร็วกว่า 2 สัปดาห์' }, key())).toMatchObject({ ok: true })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: true })
    // GC-FORM-09: the prices before VAT, kept with the rate of the tax date
    const stored = await prisma.requestQuotation.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } })
    expect(stored.map((q) => [q.supplierName, q.netSatang, q.vatRateBp, q.isSelected])).toEqual([
      ['ผู้ขาย A', 10_000_000n, 700, true],
      ['ผู้ขาย B', 10_100_000n, 700, false],
      ['ผู้ขาย C', 9_813_084n, 700, false],
    ])
  })

  it('choosing the lowest needs no reason', async () => {
    const draft = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เครื่องผสมปูน', priceIncludesVat: true, lines: [LINE], quotations: await quotes('C') }, key())
    if (!draft.ok) throw new Error(JSON.stringify(draft.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true })
  })

  it('needs exactly one chosen quotation, each with a file the requester uploaded', async () => {
    const two = (await quotes('A')).map((q, i) => ({ ...q, selected: i < 2 }))
    expect(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'สองใบ', lines: [LINE], quotations: two }, key())).toMatchObject({
      ok: false,
      error: { details: { reason: 'MORE_THAN_ONE_SELECTED' } },
    })
    const someoneElses = [{ supplierName: 'ผู้ขาย X', amount: '5000.00', includesVat: false, fileId: await fileOf('asst_con'), selected: true }]
    expect(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไฟล์คนอื่น', lines: [LINE], quotations: someoneElses }, key())).toMatchObject({ ok: false, error: { details: { reason: 'FILE' } } })

    const noFile = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไม่มีไฟล์', lines: [{ ...LINE, unitPrice: '5000.00' }], quotations: [{ supplierName: 'ผู้ขาย Y', amount: '5000.00', includesVat: false, selected: true }] }, key())
    if (!noFile.ok) throw new Error(JSON.stringify(noFile.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: noFile.data.requestId }, key())).toMatchObject({ ok: false, error: { details: { field: 'quotations.0.fileId', reason: 'FILE_REQUIRED' } } })

    const noneChosen = await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไม่ได้เลือก', lines: [LINE], quotations: (await quotes('A')).map((q) => ({ ...q, selected: false })) }, key())
    if (!noneChosen.ok) throw new Error(JSON.stringify(noneChosen.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: noneChosen.data.requestId }, key())).toMatchObject({ ok: false, error: { details: { rule: 'QUOTE-SELECTED' } } })
  })
})

describe('[FR-INT-005/AC5] IT and service requests ask three screening questions; personal data needs a DPA (BR-FORM-05)', () => {
  const SCREENING = ['processesPersonalData', 'accessesSystems', 'accessesPremises']

  it('the forms of IT_PURCHASE and HIRE_SERVICE carry the three questions, in Thai and English, and the ATT-DPA rule', async () => {
    for (const code of ['IT_PURCHASE', 'HIRE_SERVICE']) {
      const type = await prisma.requestType.findFirstOrThrow({ where: { organizationId: org.organizationId, code }, include: { currentFormVersion: true } })
      const form = formDefinition(type.currentFormVersion!.schema)
      const questions = form.fields.filter((f) => SCREENING.includes(f.id))
      expect(questions.map((f) => f.id), code).toEqual(SCREENING)
      for (const q of questions) expect(q, `${code} ${q.id}`).toMatchObject({ type: 'select', required: true, options: ['Y', 'N'], label: { th: expect.any(String), en: expect.any(String) } })
      expect(form.rules.map((r) => r.id), code).toContain('ATT-DPA')
    }
  })

  const service = (answers: Record<string, string>, serviceEndDate?: string) =>
    createDraft(
      org.ctxOf('req_con', NOW),
      {
        requestTypeCode: 'HIRE_SERVICE',
        title: 'จ้างดูแลระบบเงินเดือน',
        lines: [{ description: 'ค่าบริการรายเดือน', quantity: '12', uom: 'เดือน', unitPrice: '3000.00', ...(serviceEndDate ? { serviceEndDate } : {}) }],
        formData: { scopeOfWork: 'ดูแลระบบเงินเดือน', servicePeriod: '12 เดือน', ...answers },
      },
      key(),
    )

  it('a supplier that processes personal data needs a DPA attached; unanswered questions are refused', async () => {
    const unanswered = await service({}, '2027-10-31')
    if (!unanswered.ok) throw new Error(JSON.stringify(unanswered.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: unanswered.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'FORM' } } })

    const personal = await service({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' }, '2027-10-31')
    if (!personal.ok) throw new Error(JSON.stringify(personal.error))
    const requestId = personal.data.requestId
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: false, error: { code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-DPA' } } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: await fileOf('req_con'), subjectType: 'Request', subjectId: requestId, kind: 'DPA' } })
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId }, key())).toMatchObject({ ok: true })

    const none = await service({ processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }, '2027-10-31')
    if (!none.ok) throw new Error(JSON.stringify(none.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: none.data.requestId }, key())).toMatchObject({ ok: true })
  })

  it('service lines and licence lines carry the day the service ends; hardware lines do not need it', async () => {
    const answers = { processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' }
    const noEnd = await service(answers)
    if (!noEnd.ok) throw new Error(JSON.stringify(noEnd.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: noEnd.data.requestId }, key())).toMatchObject({ ok: false, error: { details: { field: 'lines.0.serviceEndDate', reason: 'SERVICE_END_DATE' } } })

    const it = (category: string, serviceEndDate?: string) =>
      createDraft(
        org.ctxOf('req_con', NOW),
        { requestTypeCode: 'IT_PURCHASE', title: 'อุปกรณ์ไอที', lines: [{ description: 'รายการ', quantity: '1', uom: 'ชุด', unitPrice: '20000.00', ...(serviceEndDate ? { serviceEndDate } : {}) }], formData: { category, ...answers } },
        key(),
      )
    const licence = await it('SOFTWARE')
    if (!licence.ok) throw new Error(JSON.stringify(licence.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: licence.data.requestId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SERVICE_END_DATE' } } })
    const dated = await it('SOFTWARE', '2027-09-30')
    if (!dated.ok) throw new Error(JSON.stringify(dated.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: dated.data.requestId }, key())).toMatchObject({ ok: true })
    expect((await prisma.requestLine.findFirstOrThrow({ where: { requestId: dated.data.requestId } })).serviceEndDate?.toISOString().slice(0, 10)).toBe('2027-09-30')
    const hardware = await it('HARDWARE')
    if (!hardware.ok) throw new Error(JSON.stringify(hardware.error))
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: hardware.data.requestId }, key())).toMatchObject({ ok: true })
  })
})
