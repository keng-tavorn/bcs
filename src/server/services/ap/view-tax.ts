import { err, ok, type Result } from '@/core/result'
import { taxDateOf } from '@/core/vat'
import { authorize, isAllowed, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { NameDto } from '@/server/queries/requests'
import { requireModule } from '../modules'
import { payeeAsSeen } from './wht-files'

// What the withholding-tax and retention screens read (S8-13, FR-AP-104 AC2 AC4 AC5, FR-AP-106 AC4): the retentions
// FINANCE releases (/finance/retentions · retention.release), the 50 ทวิ with an individual payee's national id masked
// (/finance/wht · wht.view: FINANCE and AUDITOR — whole only through revealWhtPayeeTaxId, which logs it), and the
// organization's income types with who changed and who confirmed each rate (/finance/wht/types · wht.view to read,
// wht.configure to change). Every view checks its capability and module PAY itself and only reads; the commands check
// everything again (BR-AUTH-05).

const LIST_MAX = 500
const MONTHS_BACK = 12

type Member = Extract<Principal, { kind: 'member' }>

/** The member, when they hold `capability` and the organization has PAY on */
async function gate(tx: TenantTx, ctx: Ctx, capability: 'retention.release' | 'wht.view'): Promise<Result<Member>> {
  const allowed = await authorize(tx, ctx, capability)
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'members only')
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return err(pay.error.code, pay.error.message, pay.error.details)
  return ok(allowed.data)
}

const nameOf = (th: string, en: string | null): NameDto => ({ th, en })
const isoDay = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null)

// ---------- /finance/retentions ----------

export type RetentionStatusDto = 'HELD' | 'RELEASABLE' | 'IN_PAYMENT_RUN' | 'PAID'

export interface RetentionRowDto {
  readonly id: string
  readonly status: RetentionStatusDto
  readonly version: number
  readonly amountSatang: bigint
  /** YYYY-MM-DD; null until the PO's last milestone is received */
  readonly releaseDueOn: string | null
  /** The due date has come (Thai calendar): a HELD one may be released */
  readonly due: boolean
  readonly invoice: { readonly id: string; readonly number: string | null; readonly supplierInvoiceNo: string | null }
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly code: string; readonly name: NameDto }
}

export interface RetentionsViewDto {
  readonly rows: readonly RetentionRowDto[]
  readonly limited: boolean
  /** Today in the Thai calendar, YYYY-MM-DD */
  readonly today: string
}

/** /finance/retentions (retention.release, PAY): every retention, the earliest due first within each status */
export async function listRetentionsView(ctx: Ctx): Promise<Result<RetentionsViewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const member = await gate(tx, ctx, 'retention.release')
    if (!member.ok) return member
    const rows = await tx.retention.findMany({
      orderBy: [{ releaseDueOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      take: LIST_MAX + 1,
      select: {
        id: true,
        status: true,
        version: true,
        amountSatang: true,
        releaseDueOn: true,
        invoice: { select: { id: true, number: true, supplierInvoiceNo: true } },
        po: { select: { id: true, number: true } },
        supplier: { select: { code: true, nameTh: true, nameEn: true } },
      },
    })
    const today = taxDateOf(ctx.now)
    return ok({
      today,
      limited: rows.length > LIST_MAX,
      rows: rows.slice(0, LIST_MAX).map((r) => {
        const due = isoDay(r.releaseDueOn)
        return {
          id: r.id,
          status: r.status,
          version: r.version,
          amountSatang: r.amountSatang,
          releaseDueOn: due,
          due: due !== null && due <= today,
          invoice: r.invoice,
          po: r.po,
          supplier: { code: r.supplier.code, name: nameOf(r.supplier.nameTh, r.supplier.nameEn) },
        }
      }),
    })
  })
}

// ---------- /finance/wht ----------

export interface WhtCertificateRowDto {
  readonly id: string
  readonly number: string
  readonly form: 'PND3' | 'PND53'
  /** YYYY-MM-DD */
  readonly paidOn: string
  readonly totalBaseSatang: bigint
  readonly totalTaxSatang: bigint
  /** The payee as this reader sees it: an individual's national id masked (BR-WHT-09) */
  readonly payee: { readonly name: string; readonly taxId: string; readonly branch: string; readonly individual: boolean; readonly masked: boolean }
  /** The 50 ทวิ PDF, only for a member who may download it (wht.revealTaxId) */
  readonly fileId: string | null
}

export interface WhtViewDto {
  readonly rows: readonly WhtCertificateRowDto[]
  readonly limited: boolean
  /** wht.revealTaxId: "show full id" and the PDF */
  readonly canReveal: boolean
  /** wht.export: the monthly summary */
  readonly canExport: boolean
  /** The months a summary can be made for, this month first (YYYY-MM, Thai calendar) */
  readonly months: readonly string[]
}

type PayeeSnapshot = { name: string; taxId: string; branch: string; address: string; payeeType: 'JURISTIC' | 'INDIVIDUAL' | 'FOREIGN' }

/** The last `count` months up to the month of `today` (YYYY-MM-DD), newest first */
export function monthsUpTo(today: string, count = MONTHS_BACK): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number]
  return Array.from({ length: count }, (_, i) => {
    const index = y * 12 + (m - 1) - i
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
  })
}

/** /finance/wht (wht.view, PAY): the 50 ทวิ issued, last paid first, with the national id of an individual masked */
export async function listWhtCertificatesView(ctx: Ctx): Promise<Result<WhtViewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const member = await gate(tx, ctx, 'wht.view')
    if (!member.ok) return member
    const canReveal = isAllowed(member.data, 'wht.revealTaxId')
    const certificates = await tx.whtCertificate.findMany({
      orderBy: [{ paidOn: 'desc' }, { number: 'desc' }],
      take: LIST_MAX + 1,
      select: { id: true, number: true, form: true, paidOn: true, totalBaseSatang: true, totalTaxSatang: true, payeeSnapshot: true, fileId: true },
    })
    return ok({
      canReveal,
      canExport: isAllowed(member.data, 'wht.export'),
      months: monthsUpTo(taxDateOf(ctx.now)),
      limited: certificates.length > LIST_MAX,
      rows: certificates.slice(0, LIST_MAX).map((c) => {
        const snapshot = c.payeeSnapshot as PayeeSnapshot
        const individual = snapshot.payeeType === 'INDIVIDUAL'
        // never revealed here: the whole id leaves only through revealWhtPayeeTaxId with its log row
        const seen = payeeAsSeen(snapshot, false)
        return {
          id: c.id,
          number: c.number,
          form: c.form,
          paidOn: isoDay(c.paidOn)!,
          totalBaseSatang: c.totalBaseSatang,
          totalTaxSatang: c.totalTaxSatang,
          payee: { name: seen.name, taxId: seen.taxId, branch: seen.branch, individual, masked: individual },
          fileId: canReveal ? c.fileId : null,
        }
      }),
    })
  })
}

// ---------- /finance/wht/types ----------

export interface WhtIncomeTypeRowDto {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly rateBp: number
  readonly form: 'PND3_53' | 'PND53' | 'PND3'
  readonly legalRefTh: string | null
  readonly active: boolean
  readonly updatedBy: NameDto | null
  readonly confirmedBy: NameDto | null
  readonly confirmedAt: Date | null
  /** The reader changed it last: they may not confirm it (BR-WHT-03) */
  readonly changedByMe: boolean
}

export interface WhtTypesViewDto {
  readonly rows: readonly WhtIncomeTypeRowDto[]
  /** wht.configure: add, change and confirm */
  readonly canConfigure: boolean
}

/** /finance/wht/types (wht.view to read, PAY): the organization's income types by code */
export async function listWhtIncomeTypesView(ctx: Ctx): Promise<Result<WhtTypesViewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const member = await gate(tx, ctx, 'wht.view')
    if (!member.ok) return member
    const types = await tx.whtIncomeType.findMany({
      orderBy: { code: 'asc' },
      take: LIST_MAX,
      select: {
        code: true,
        nameTh: true,
        nameEn: true,
        rateBp: true,
        form: true,
        legalRefTh: true,
        active: true,
        updatedById: true,
        confirmedAt: true,
        updatedBy: { select: { displayNameTh: true, displayNameEn: true } },
        confirmedBy: { select: { displayNameTh: true, displayNameEn: true } },
      },
    })
    return ok({
      canConfigure: isAllowed(member.data, 'wht.configure'),
      rows: types.map((t) => ({
        code: t.code,
        nameTh: t.nameTh,
        nameEn: t.nameEn,
        rateBp: t.rateBp,
        form: t.form,
        legalRefTh: t.legalRefTh,
        active: t.active,
        updatedBy: t.updatedBy ? nameOf(t.updatedBy.displayNameTh, t.updatedBy.displayNameEn) : null,
        confirmedBy: t.confirmedBy ? nameOf(t.confirmedBy.displayNameTh, t.confirmedBy.displayNameEn) : null,
        confirmedAt: t.confirmedBy ? t.confirmedAt : null,
        changedByMe: t.updatedById === member.data.memberId,
      })),
    })
  })
}
