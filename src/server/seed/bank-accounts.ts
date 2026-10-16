import { z } from 'zod'
import { bankOf } from '@/core/bankfile/banks'
import { NEUTRAL_TEMPLATE_CODE } from '@/core/bankfile/templates'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { InputWorkbook } from './workbook'

// The bank accounts of a sample organization (S9-01, docs/sub-specs/S9.md "การอ่านชีตของไฟล์ระยะ 1", ADR-128): its own
// accounts from sheet CompanyBankAccounts, ACTIVE, with the neutral file template because the sheet's fileFormat says
// the bank's file spec is still awaited (P0-03, ADR-130); and one ACTIVE account per supplier from the bank columns of
// sheet SupplierPayment. They come from the seed, not from an approved change (sourceChangeId null, INV-PAY-04); real
// accounts come in through BankAccountChange (S9-15). A workbook without these sheets (the demo) gives nothing.
// Running again changes nothing that exists. Events carry the last four digits only (BR-BANK-08).

const digits = (raw: string) => raw.replace(/[-\s]/g, '')
const AccountNo = z.string().transform(digits).pipe(z.string().regex(/^\d{10,12}$/))
const BankCode = z.string().refine((c) => bankOf(c) !== null, 'BANK_CODE_UNKNOWN')

const CompanyRow = z.object({ code: z.string().min(1), bankCode: BankCode, branchTh: z.string().nullable(), accountType: z.enum(['CURRENT', 'SAVINGS']), accountNo: AccountNo })
const SupplierRow = z.object({ supplierCode: z.string().min(1), bankCode: BankCode, bankBranchTh: z.string().nullable(), accountNo: AccountNo, accountName: z.string().min(1).max(200) })

export interface BankAccountsInput {
  readonly company: z.infer<typeof CompanyRow>[]
  readonly suppliers: z.infer<typeof SupplierRow>[]
}

function rowsOf<T extends z.ZodType>(workbook: InputWorkbook, sheet: string, schema: T): z.infer<T>[] {
  if (!workbook.hasSheet(sheet)) return []
  return workbook.table(sheet).map(({ row, values }) => {
    const parsed = schema.safeParse(values)
    if (!parsed.success) throw new Error(`${sheet} row ${row}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return parsed.data
  })
}

export function parseBankAccounts(workbook: InputWorkbook): BankAccountsInput {
  return { company: rowsOf(workbook, 'CompanyBankAccounts', CompanyRow), suppliers: rowsOf(workbook, 'SupplierPayment', SupplierRow) }
}

export interface BankAccountsReport {
  readonly company: number
  readonly suppliers: number
}

export async function seedBankAccounts(organizationId: string, input: BankAccountsInput, now: Date): Promise<BankAccountsReport> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const events: EventDraft[] = []
    const activated = (row: { id: string; ownerKind: 'SUPPLIER' | 'ORGANIZATION'; supplierId: string | null; code: string | null; bankCode: string; accountNo: string }): EventDraft => ({
      type: 'bank_account.activated',
      aggregateType: 'BankAccount',
      aggregateId: row.id,
      data: { ownerKind: row.ownerKind, supplierId: row.supplierId, code: row.code, bankCode: row.bankCode, last4: row.accountNo.slice(-4), via: 'SEED', changeId: null },
    })
    // the organization's own accounts are in its legal name
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { legalNameTh: true } })
    const codes = new Set((await tx.bankAccount.findMany({ where: { ownerKind: 'ORGANIZATION' }, select: { code: true } })).map((a) => a.code))
    let company = 0
    for (const c of input.company) {
      if (codes.has(c.code)) continue
      const row = await tx.bankAccount.create({
        data: { organizationId, ownerKind: 'ORGANIZATION', code: c.code, bankCode: c.bankCode, accountNo: c.accountNo, accountName: org.legalNameTh, branchName: c.branchTh, accountType: c.accountType, fileTemplateCode: NEUTRAL_TEMPLATE_CODE, activatedAt: now },
        select: { id: true, ownerKind: true, supplierId: true, code: true, bankCode: true, accountNo: true },
      })
      events.push(activated(row))
      company++
    }
    const suppliers = new Map((await tx.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
    const paid = new Set((await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE' }, select: { supplierId: true } })).map((a) => a.supplierId))
    let supplierAccounts = 0
    for (const s of input.suppliers) {
      const supplierId = suppliers.get(s.supplierCode)
      if (!supplierId) throw new Error(`SupplierPayment: no supplier ${s.supplierCode}`)
      if (paid.has(supplierId)) continue
      const row = await tx.bankAccount.create({
        data: { organizationId, ownerKind: 'SUPPLIER', supplierId, bankCode: s.bankCode, accountNo: s.accountNo, accountName: s.accountName, branchName: s.bankBranchTh, activatedAt: now },
        select: { id: true, ownerKind: true, supplierId: true, code: true, bankCode: true, accountNo: true },
      })
      events.push(activated(row))
      paid.add(supplierId)
      supplierAccounts++
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return { company, suppliers: supplierAccounts }
  })
}
