import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { cancelInvoice, confirmInvoiceCoding, createInvoice, submitInvoice, updateInvoice } from '@/server/services/ap'
import { uploadInvoiceFile } from '@/server/services/ap/files'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, type ApOrg } from '../support/ap'

// S8-03: every invoice command checks invoice.record in the service (BR-AUTH-05) and needs module PAY (BR-AP-13).
// PROCUREMENT, RECEIVER, a plain member and AUDITOR are refused; an organization without PAY is MODULE_DISABLED.

let ap: ApOrg
let draft: { invoiceId: string; version: number }
let poId: string

beforeAll(async () => {
  ap = await apOrg()
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await receive(ap, po, { 0: '1' })
  poId = po.id
  draft = await codedDraft(ap, po, { no: 'R-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
})

const commands = () => {
  const lineId = () => prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } }).then((l) => l.id)
  return [
    ['invoice.create', (code: string) => createInvoice(ap.org.ctxOf(code, AP_NOW), { poId }, key())],
    ['invoice.update', (code: string) => updateInvoice(ap.org.ctxOf(code, AP_NOW), { ...draft, statedVat: '71.00' }, key())],
    [
      'invoice.confirmCoding',
      async (code: string) => confirmInvoiceCoding(ap.org.ctxOf(code, AP_NOW), { ...draft, lines: [{ invoiceLineId: await lineId(), accountCode: '510101', costCenterId: (await prisma.costCenter.findFirstOrThrow({ where: { organizationId: ap.org.organizationId } })).id }] }, key()),
    ],
    ['invoice.submit', (code: string) => submitInvoice(ap.org.ctxOf(code, AP_NOW), draft, key())],
    ['invoice.cancel', (code: string) => cancelInvoice(ap.org.ctxOf(code, AP_NOW), { ...draft, reason: 'x' }, key())],
    ['upload', (code: string) => uploadInvoiceFile(ap.org.ctxOf(code, AP_NOW), { poId, fileName: 'a.pdf', content: new TextEncoder().encode('%PDF-1.4') })],
  ] as const
}

describe('[FR-AP-101/AC6] invoice commands are refused without invoice.record (§2.4)', () => {
  it.each(['proc_officer', 'receiver_con', 'req_con', 'auditor', 'admin'])('%s is FORBIDDEN on every command and nothing changes', async (code) => {
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })
    for (const [name, run] of commands()) {
      expect(await run(code), `${code} ${name}`).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).toEqual(before)
  })
})

describe('[FR-AP-102/AC6] an organization without PAY (BR-AP-13)', () => {
  it('every invoice command is MODULE_DISABLED', async () => {
    const off = await apOrg({ modules: ['AI', 'BCS_GO'] })
    const po = await sentPo(off, [{ quantity: '1', unitPrice: '1000.00' }])
    const ctx = fin(off)
    expect(await createInvoice(ctx, { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'PAY' } } })
    expect(await uploadInvoiceFile(ctx, { poId: po.id, fileName: 'a.pdf', content: new TextEncoder().encode('%PDF-1.4') })).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    // a draft left from before PAY was switched off cannot move either
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await updateInvoice(fin(ap), { ...draft, statedVat: '71.00' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await submitInvoice(fin(ap), draft, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
      expect(await cancelInvoice(fin(ap), { ...draft, reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })
})

describe('FINANCE may record', () => {
  it('the same submit by FINANCE goes through', async () => {
    expect(ok(await submitInvoice(fin(ap), draft, key())).status).toBe('READY_FOR_PAYMENT')
  })
})
