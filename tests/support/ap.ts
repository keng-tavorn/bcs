import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { confirmInvoiceCoding, createInvoice, submitInvoice, updateInvoice } from '@/server/services/ap'
import { postGoodsReceipt } from '@/server/services/receiving'
import type { DoaOrg } from './doa-org'
import { p2p } from './p2p'
import { createP1Org } from './p1-org'

// Tier-2 invoice tests (S8): an organization of the phase-1 fixtures with PAY on, the roles the invoice commands need,
// a supplier, the account codes, and POs sent and received through the real services (./p2p.ts), then the invoice
// commands step by step. Each call makes its own budget line, request and PO, so tests never share money.

export const AP_NOW = new Date('2026-10-12T03:00:00Z')
export const key = () => ({ idempotencyKey: randomUUID(), sender: null })
export const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

export interface ApOrg {
  readonly org: DoaOrg
  readonly supplierId: string
  readonly flow: ReturnType<typeof p2p>
}

export async function apOrg(options: { modules?: Array<'PAY' | 'AI' | 'BCS_GO'>; supplier?: { isVatRegistered?: boolean; registryFlag?: 'NONE' | 'VAT_CANCELLED' | 'CEASED'; paymentTermDays?: number } } = {}): Promise<ApOrg> {
  const org = await createP1Org(options.modules ? { modules: options.modules } : {})
  const { organizationId } = org
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: AP_NOW },
      { organizationId, memberId: org.member.dm_fin!, role: 'FINANCE', grantedAt: AP_NOW },
      { organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: AP_NOW },
      { organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: AP_NOW },
    ],
  })
  const s = options.supplier ?? {}
  const supplierId = (
    await prisma.supplier.create({
      data: { organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012', email: 'ap-supplier@test.bcs.local', isVatRegistered: s.isVatRegistered ?? true, registryFlag: s.registryFlag ?? 'NONE', paymentTermDays: s.paymentTermDays ?? null },
    })
  ).id
  await prisma.accountCode.createMany({
    data: [
      { organizationId, code: '510101', nameTh: 'ค่าวัสดุก่อสร้าง', type: 'COST' },
      { organizationId, code: '530101', nameTh: 'ค่าใช้จ่ายสำนักงาน', type: 'EXPENSE' },
      { organizationId, code: '599999', nameTh: 'รหัสที่เลิกใช้', type: 'EXPENSE', active: false },
    ],
  })
  // The budget lines of the tests charge 510101 unless a test says otherwise
  return { org, supplierId, flow: p2p(org, AP_NOW) }
}

/** A PO of these lines (quantity, unit price) on a funded budget line, approved and sent to the supplier */
export async function sentPo(ap: ApOrg, lines: Array<{ quantity: string; unitPrice: string }>, options: { fund?: bigint; accountCode?: string | null } = {}) {
  const budgetLineId = await ap.flow.fundedLine(options.fund ?? 10_000_000n)
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: options.accountCode === undefined ? '510101' : options.accountCode } })
  const pr = await ap.flow.approvedRequest(budgetLineId, lines)
  const po = await ap.flow.approvedPo(
    pr.lines.map((l) => l.id),
    ap.supplierId,
  )
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: AP_NOW } })
  return { ...(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })), budgetLineId }
}

/** receiver_con accepts these quantities on the PO's lines (by line index) */
export async function receive(ap: ApOrg, po: { id: string; lines: ReadonlyArray<{ id: string }> }, quantities: Record<number, string>) {
  return ok(
    await postGoodsReceipt(
      ap.org.ctxOf('receiver_con', AP_NOW),
      { poId: po.id, lines: Object.entries(quantities).map(([i, q]) => ({ poLineId: po.lines[Number(i)]!.id, received: q, rejected: '0' })) },
      key(),
    ),
  )
}

export const fin = (ap: ApOrg, code = 'fin_officer') => ap.org.ctxOf(code, AP_NOW)

/**
 * A draft by FINANCE on the PO with its header and lines, every line coded with the budget line's account code and
 * cost center. Returns the invoice id and version, ready to submit.
 */
export async function codedDraft(
  ap: ApOrg,
  po: { id: string; lines: ReadonlyArray<{ id: string }> },
  invoice: { no: string; date?: string; vat: string; discount?: string; isFinal?: boolean; lines: Array<{ line: number; quantity: string; unitPrice: string }> },
  who = 'fin_officer',
) {
  const ctx = fin(ap, who)
  const { invoiceId } = ok(await createInvoice(ctx, { poId: po.id }, key()))
  let version = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
  ;({ version } = ok(
    await updateInvoice(
      ctx,
      {
        invoiceId,
        version,
        supplierInvoiceNo: invoice.no,
        invoiceDate: invoice.date ?? '2026-10-10',
        statedVat: invoice.vat,
        ...(invoice.discount ? { discount: invoice.discount } : {}),
        ...(invoice.isFinal ? { isFinal: true } : {}),
        lines: invoice.lines.map((l) => ({ poLineId: po.lines[l.line]!.id, quantity: l.quantity, unitPrice: l.unitPrice })),
      },
      key(),
    ),
  ))
  const lines = await prisma.invoiceLine.findMany({ where: { invoiceId }, include: { poLine: { include: { budgetLine: true } } } })
  ;({ version } = ok(
    await confirmInvoiceCoding(ctx, { invoiceId, version, lines: lines.map((l) => ({ invoiceLineId: l.id, accountCode: l.poLine.budgetLine.accountCode ?? '510101', costCenterId: l.poLine.budgetLine.costCenterId })) }, key()),
  ))
  return { invoiceId, version }
}

export async function submit(ap: ApOrg, draft: { invoiceId: string; version: number }, who = 'fin_officer') {
  return submitInvoice(fin(ap, who), draft, key())
}

export async function balanceOf(budgetLineId: string) {
  const b = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })
  const baht = (s: bigint) => `${s / 100n}.${String(s % 100n).padStart(2, '0')}`
  return { available: baht(b.availableSatang), reserved: baht(b.reservedSatang), committed: baht(b.committedSatang), actual: baht(b.actualSatang) }
}

/** A DRAFT INVOICE_READ action of the Document Agent read for a PO (S13-12), proposing these values by path */
export async function invoiceReading(ap: ApOrg, poId: string, proposed: Record<string, string> = {}) {
  const row = await prisma.agentAction.create({
    data: {
      organizationId: ap.org.organizationId,
      agent: 'DOCUMENT',
      purpose: 'INVOICE_READ',
      level: 'L1',
      status: 'DRAFT',
      channel: 'WEB',
      promptVersion: 'INVOICE_READ@1',
      model: 'claude-sonnet-5-5',
      requestedById: ap.org.member.fin_officer!,
      subjectType: 'PURCHASE_ORDER',
      subjectId: poId,
      output: {},
      review: { requiredPaths: Object.keys(proposed).sort(), confirmedPaths: [], proposed },
      createdAt: AP_NOW,
    },
  })
  return row.id
}
