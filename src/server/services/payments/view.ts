import { NEUTRAL_TEMPLATE_CODE } from '@/core/bankfile'
import { bankOf } from '@/core/bankfile/banks'
import { stepUpNeeded } from '@/core/pin'
import { err, ok, type Result } from '@/core/result'
import { taxDateOf } from '@/core/vat'
import { paymentSettingsOf } from '@/lib/org-settings'
import { isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { PAY_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-pay'
import { REASON_FLAGS, runFlagsNow } from '@/server/queries/payment-runs'
import { fail, type Fail } from '../ap/common'
import { requireModule } from '../modules'
import { proposePaymentRun } from './runs'

// What the payment run screens read (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-101 to FR-PAY-103): the runs of
// /finance/payments by tab with their counts, what /finance/payments/new proposes, and one run of
// /finance/payments/[id] — its items (flagged first, the flags as they stand now while it is a draft or waits for its
// approver), its documents, its bank files, the results and the payment advice of each item, its history, the open
// approval task of the member reading it and what the member may do now. paymentRun.view: FINANCE and AUDITOR read every
// run of the organization; any other member only a run whose approval task they hold or held (ASSIGNED). Module PAY is
// on for every read. Reads only; the commands check everything again. Account numbers leave masked (bank and the last
// four digits), amounts as satang in decimal strings, dates as yyyy-mm-dd or ISO time: plain JSON for the browser.

export const RUN_TABS = ['draft', 'pending', 'toBank', 'sent', 'completed', 'cancelled'] as const
export type RunTab = (typeof RUN_TABS)[number]
const TAB_STATUSES = {
  draft: ['DRAFT'],
  pending: ['PENDING_APPROVAL'],
  toBank: ['APPROVED', 'FILE_READY'],
  sent: ['SENT_TO_BANK'],
  completed: ['COMPLETED'],
  cancelled: ['CANCELLED', 'REJECTED'],
} as const satisfies Record<RunTab, readonly string[]>

export const RUN_PAGE_SIZE = 20
const ADDABLE_LIMIT = 500
const SHA_SHORT = 12

const day = (d: Date) => d.toISOString().slice(0, 10)
const iso = (d: Date | null) => (d ? d.toISOString() : null)

export interface NameDto {
  readonly th: string
  readonly en: string | null
}

/** An account shown masked: its bank and the last four digits (BR-BANK-08, BR-AUTH-04) */
export interface MaskedAccountDto {
  readonly code: string | null
  readonly bankCode: string
  readonly bankName: string | null
  /** The bank's short name (KBANK), for the English screens */
  readonly bankShort: string | null
  readonly last4: string
}

const masked = (a: { code?: string | null; bankCode: string; accountNo: string }): MaskedAccountDto => ({
  code: a.code ?? null,
  bankCode: a.bankCode,
  bankName: bankOf(a.bankCode)?.nameTh ?? null,
  bankShort: bankOf(a.bankCode)?.shortName ?? null,
  last4: a.accountNo.slice(-4),
})

/** paymentRun.view of a member, with PAY on; whether it reaches every run (ORG) or only the runs they decide (ASSIGNED) */
async function reader(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; principal: Extract<Principal, { kind: 'member' }>; everyRun: boolean } | Fail> {
  const principal = await loadPrincipal(tx, ctx)
  if (principal.kind !== 'member' || !isAllowed(principal, 'paymentRun.view')) return fail('FORBIDDEN', 'you may not see payment runs', { capability: 'paymentRun.view' })
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false, error: pay.error }
  return { ok: true, principal, everyRun: scopesFor(principal, 'paymentRun.view').has('ORG') }
}

/** The runs whose approval task the member holds, held or decided (for them, or as a delegate) */
async function assignedRunIds(tx: TenantTx, memberId: string): Promise<string[]> {
  const tasks = await tx.approvalTask.findMany({
    where: { step: { route: { subjectType: 'PAYMENT_RUN' } }, OR: [{ assigneeMemberId: memberId }, { principalMemberId: memberId }, { decidedByMemberId: memberId }] },
    select: { step: { select: { route: { select: { subjectId: true } } } } },
  })
  return [...new Set(tasks.map((t) => t.step.route.subjectId))]
}

// ---------- /finance/payments ----------

export interface PaymentRunRowDto {
  readonly id: string
  /** PAY-{BE}-{SEQ5}: given at the first submit; null while a draft */
  readonly number: string | null
  readonly status: string
  readonly payDate: string
  readonly payer: MaskedAccountDto
  readonly itemCount: number
  readonly totalTransferSatang: string
  /** Items with a flag (BR-PAY-06), as written on them */
  readonly flaggedItems: number
  readonly preparedBy: NameDto
}

export interface PaymentRunListDto {
  readonly tab: RunTab
  readonly page: number
  readonly pageCount: number
  readonly rows: readonly PaymentRunRowDto[]
  readonly counts: Readonly<Record<RunTab, number>>
  /** The member prepares runs (paymentRun.prepare): "เตรียมรอบจ่าย" */
  readonly canPrepare: boolean
}

/** /finance/payments: the runs of one tab, a page at a time, and how many each tab holds */
export async function listPaymentRuns(ctx: Ctx, filter: { tab?: RunTab | null; page?: number | null } = {}): Promise<Result<PaymentRunListDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await reader(tx, ctx)
    if (!who.ok) return err(who.error.code, who.error.message, who.error.details)
    const scope = who.everyRun ? {} : { id: { in: await assignedRunIds(tx, who.principal.memberId) } }
    const tab: RunTab = filter.tab ?? 'draft'
    const grouped = await tx.paymentRun.groupBy({ by: ['status'], where: scope, _count: { _all: true } })
    const byStatus = new Map(grouped.map((g) => [g.status as string, g._count._all]))
    const counts = Object.fromEntries(RUN_TABS.map((t) => [t, TAB_STATUSES[t].reduce((a, s) => a + (byStatus.get(s) ?? 0), 0)])) as Record<RunTab, number>
    const pageCount = Math.max(1, Math.ceil(counts[tab] / RUN_PAGE_SIZE))
    const page = Math.min(Math.max(1, Math.trunc(filter.page ?? 1)), pageCount)
    const rows = await tx.paymentRun.findMany({
      where: { ...scope, status: { in: [...TAB_STATUSES[tab]] } },
      orderBy: [{ payDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * RUN_PAGE_SIZE,
      take: RUN_PAGE_SIZE,
      select: {
        id: true,
        number: true,
        status: true,
        payDate: true,
        itemCount: true,
        totalTransferSatang: true,
        payer: { select: { code: true, bankCode: true, accountNo: true } },
        preparedBy: { select: { displayNameTh: true, displayNameEn: true } },
        _count: { select: { items: { where: { flags: { isEmpty: false } } } } },
      },
    })
    return ok({
      tab,
      page,
      pageCount,
      counts,
      canPrepare: isAllowed(who.principal, 'paymentRun.prepare'),
      rows: rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        payDate: day(r.payDate),
        payer: masked(r.payer),
        itemCount: r.itemCount,
        totalTransferSatang: r.totalTransferSatang.toString(),
        flaggedItems: r._count.items,
        preparedBy: { th: r.preparedBy.displayNameTh, en: r.preparedBy.displayNameEn },
      })),
    })
  })
}

// ---------- /finance/payments/new ----------

export interface NewPaymentRunDto {
  /** The pay date the form opens with: the one asked when it can be used, else the next run day (OQ-130) */
  readonly payDate: string
  /** The date asked could not be used (PAYMENT_DATE_INVALID: PAST, NOT_BUSINESS_DAY) */
  readonly asked: { readonly date: string; readonly code: string; readonly reason: string | null } | null
  readonly payers: ReadonlyArray<MaskedAccountDto & { readonly id: string; readonly neutralTemplate: boolean }>
  /** What the run would take on that date (BR-PAY-03): invoices due by then and every released retention */
  readonly proposed: { readonly documents: number; readonly invoices: number; readonly retentions: number; readonly suppliers: number; readonly payableSatang: string }
}

/** /finance/payments/new: the payers in force and what a run on the date would take (paymentRun.prepare) */
export async function newPaymentRunView(ctx: Ctx, input: { readonly payDate?: string | null } = {}): Promise<Result<NewPaymentRunDto>> {
  let asked: NewPaymentRunDto['asked'] = null
  let proposal = await proposePaymentRun(ctx, input.payDate ? { payDate: input.payDate } : {})
  if (!proposal.ok && input.payDate && (proposal.error.code === 'PAYMENT_DATE_INVALID' || proposal.error.code === 'VALIDATION_FAILED')) {
    const reason = proposal.error.details?.reason
    asked = { date: input.payDate, code: proposal.error.code, reason: typeof reason === 'string' ? reason : null }
    proposal = await proposePaymentRun(ctx)
  }
  if (!proposal.ok) return proposal
  const p = proposal.data
  const payers = await forTenant(ctx.organizationId).bankAccount.findMany({ where: { id: { in: p.payers.map((x) => x.id) } }, select: { id: true, code: true, bankCode: true, accountNo: true, fileTemplateCode: true } })
  const byId = new Map(payers.map((x) => [x.id, x]))
  return ok({
    payDate: p.payDate,
    asked,
    payers: p.payers.flatMap((x) => {
      const row = byId.get(x.id)
      return row ? [{ id: row.id, ...masked(row), neutralTemplate: row.fileTemplateCode === NEUTRAL_TEMPLATE_CODE }] : []
    }),
    proposed: {
      documents: p.documents.length,
      invoices: p.documents.filter((d) => d.kind === 'INVOICE').length,
      retentions: p.documents.filter((d) => d.kind === 'RETENTION').length,
      suppliers: new Set(p.documents.map((d) => d.supplierId)).size,
      payableSatang: p.documents.reduce((a, d) => a + BigInt(d.payableSatang), 0n).toString(),
    },
  })
}

/** The documents a run on this date takes (the same proposal as the page): what "สร้างร่าง" adds */
export async function proposedDocuments(ctx: Ctx, payDate: string): Promise<Result<{ readonly invoiceIds: string[]; readonly retentionIds: string[] }>> {
  const proposal = await proposePaymentRun(ctx, { payDate })
  if (!proposal.ok) return proposal
  const docs = proposal.data.documents
  return ok({ invoiceIds: docs.filter((d) => d.kind === 'INVOICE').map((d) => d.id), retentionIds: docs.filter((d) => d.kind === 'RETENTION').map((d) => d.id) })
}

/**
 * Where a draft stands right after "สร้างร่าง" made it: a draft that changed already (a resend of the same submission
 * after its documents went in) is not given the proposal again
 */
export async function paymentRunState(ctx: Ctx, paymentRunId: string): Promise<Result<{ readonly status: string; readonly version: number; readonly documentCount: number }>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await reader(tx, ctx)
    if (!who.ok) return err(who.error.code, who.error.message, who.error.details)
    const run = await tx.paymentRun.findFirst({ where: { id: paymentRunId }, select: { status: true, version: true, documentCount: true, preparedById: true } })
    if (!run) return err('NOT_FOUND', 'payment run not found')
    if (!who.everyRun && run.preparedById !== who.principal.memberId) return err('FORBIDDEN', 'you may not see this payment run', { capability: 'paymentRun.view' })
    return ok({ status: run.status, version: run.version, documentCount: run.documentCount })
  })
}

// ---------- /finance/payments/[id] ----------

export interface RunDocumentDto {
  readonly kind: 'INVOICE' | 'RETENTION'
  /** The invoice's id, or the retention's */
  readonly id: string
  /** The BCS number of the invoice (of the retention's invoice) and the supplier's own number */
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly dueDate: string | null
  readonly payableSatang: string
  readonly status: 'HELD' | 'PAID' | 'RELEASED'
}

export interface RunItemDto {
  readonly id: string
  readonly seq: number | null
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  /** The payee: the snapshot taken at submit, or the supplier's account in force while a draft; null without one */
  readonly account: MaskedAccountDto | null
  readonly payableSatang: string
  readonly whtSatang: string
  readonly transferSatang: string
  readonly flags: readonly string[]
  readonly flagReason: string | null
  /** A flag needs the preparer's reason and has none for it yet (BR-PAY-06) */
  readonly reasonNeeded: boolean
  readonly status: 'INCLUDED' | 'PAID' | 'FAILED'
  readonly paidOn: string | null
  readonly bankReference: string | null
  readonly failureReason: string | null
  readonly documents: readonly RunDocumentDto[]
  /** The last payment advice of a paid item (BR-PAY-13): PENDING, SENT, FAILED or NO_EMAIL */
  readonly advice: { readonly status: string; readonly sentAt: string | null; readonly sendings: number } | null
}

export interface RunFileDto {
  readonly id: string
  readonly version: number
  readonly fileName: string
  readonly sha256Short: string
  readonly itemCount: number
  readonly totalSatang: string
  readonly generatedBy: NameDto
  readonly generatedAt: string
  readonly firstDownloadedAt: string | null
  readonly status: 'CURRENT' | 'SUPERSEDED'
  readonly reason: string | null
}

export interface RunEventDto {
  readonly id: string
  readonly type: string
  readonly occurredAt: string
  readonly channel: string
  readonly actor: NameDto | null
  readonly system: boolean
  /** An approval decision: what was decided and under which DOA version and rule */
  readonly decision: string | null
  readonly doa: { readonly versionId: string; readonly code: string; readonly versionNo: number; readonly ruleCode: string } | null
  /** The supplier of an item's event */
  readonly supplierCode: string | null
  /** A file's version (made, downloaded) */
  readonly fileVersion: number | null
  /** A reason written by a member, as written */
  readonly note: string | null
}

export interface AddableSupplierDto {
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly hasAccount: boolean }
  readonly documents: ReadonlyArray<Omit<RunDocumentDto, 'status'>>
}

export interface PaymentRunPageDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly version: number
  readonly payDate: string
  readonly payer: MaskedAccountDto
  readonly fileTemplateCode: string
  /** BR-BANK-05: the neutral template of the demo layer, which no bank takes */
  readonly neutralTemplate: boolean
  readonly preparedBy: NameDto
  readonly totalPayableSatang: string
  readonly totalWhtSatang: string
  readonly totalTransferSatang: string
  readonly itemCount: number
  readonly documentCount: number
  readonly flaggedItems: number
  readonly cancelReason: string | null
  readonly times: { readonly submittedAt: string | null; readonly approvedAt: string | null; readonly sentToBankAt: string | null; readonly completedAt: string | null; readonly cancelledAt: string | null }
  /** Flagged first, then by supplier code */
  readonly items: readonly RunItemDto[]
  /** Newest version first */
  readonly files: readonly RunFileDto[]
  readonly history: readonly RunEventDto[]
  /** A file of the run was downloaded (cancelling or making it again then needs "not sent to the bank") */
  readonly downloaded: { readonly any: boolean; readonly current: boolean }
  /** The member holds the run's open approval task: what the decision sends back (BR-PAY-07) */
  readonly decision: { readonly taskId: string; readonly stepUp: boolean; readonly flagsKey: string } | null
  readonly adviceEmail: boolean
  /** Today in Thai time: the latest a payment can be dated (BR-PAY-12) */
  readonly today: string
  readonly may: {
    readonly edit: boolean
    readonly cancelDraft: boolean
    readonly generate: boolean
    readonly regenerate: boolean
    readonly download: boolean
    readonly markSent: boolean
    readonly revertSent: boolean
    readonly cancelApproved: boolean
    readonly recordResults: boolean
    readonly resendAdvice: boolean
  }
  /** While the preparer edits the draft: what may be added, by supplier (BR-PAY-03) */
  readonly addable: readonly AddableSupplierDto[]
}

const RUN_EVENTS = ['PaymentRun']

/** /finance/payments/[id]: one run as the member may see it */
export async function getPaymentRunPage(ctx: Ctx, paymentRunId: string): Promise<Result<PaymentRunPageDto>> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentRunId)) return err('NOT_FOUND', 'payment run not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await reader(tx, ctx)
    if (!who.ok) return err(who.error.code, who.error.message, who.error.details)
    const run = await tx.paymentRun.findFirst({
      where: { id: paymentRunId },
      include: { payer: { select: { code: true, bankCode: true, accountNo: true } }, preparedBy: { select: { displayNameTh: true, displayNameEn: true } } },
    })
    if (!run) return err('NOT_FOUND', 'payment run not found')
    const me = who.principal.memberId
    const tasks = await tx.approvalTask.findMany({
      where: { step: { route: { subjectType: 'PAYMENT_RUN', subjectId: run.id } } },
      select: {
        id: true,
        status: true,
        assigneeMemberId: true,
        principalMemberId: true,
        decidedByMemberId: true,
        reason: true,
        step: { select: { route: { select: { id: true, subjectType: true, amountSatang: true, doaVersion: { select: { stepUpThresholdSatang: true } } } } } },
      },
    })
    const assignees = [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId, t.decidedByMemberId]).filter((m): m is string => !!m))]
    if (!isAllowed(who.principal, 'paymentRun.view', { assigneeMemberIds: assignees })) return err('FORBIDDEN', 'you may not see this payment run', { capability: 'paymentRun.view' })

    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const adviceEmail = paymentSettingsOf(org.settings).adviceEmail
    const live = run.status === 'DRAFT' || run.status === 'PENDING_APPROVAL'
    // the flags as they stand now while the run can still change or is decided on (BR-PAY-07), else as written on it
    const now = live ? await runFlagsNow(tx, ctx.organizationId, run.id) : null
    const nowById = new Map((now?.items ?? []).map((i) => [i.itemId, i]))

    const items = await tx.paymentRunItem.findMany({
      where: { paymentRunId: run.id },
      include: { supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } } },
    })
    const accounts = await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', supplierId: { in: items.map((i) => i.supplierId) } }, select: { supplierId: true, bankCode: true, accountNo: true } })
    const accountOf = new Map(accounts.map((a) => [a.supplierId!, a]))
    const links = await tx.paymentRunDocument.findMany({
      where: { paymentRunId: run.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        paymentRunItemId: true,
        docKind: true,
        invoiceId: true,
        retentionId: true,
        payableSatang: true,
        status: true,
        invoice: { select: { number: true, supplierInvoiceNo: true, dueDate: true } },
        retention: { select: { invoice: { select: { number: true, supplierInvoiceNo: true } } } },
      },
    })
    const notices = items.length
      ? await tx.supplierNotice.findMany({
          where: { templateKey: PAY_SUPPLIER_TEMPLATES.paymentAdvice, subjectType: 'PAYMENT_RUN_ITEM', subjectId: { in: items.map((i) => i.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { subjectId: true, status: true, sentAt: true },
        })
      : []

    const itemDtos: RunItemDto[] = items.map((item) => {
      const flagsNow = nowById.get(item.id)
      const flags: string[] = flagsNow ? [...flagsNow.flags] : [...item.flags]
      const stored = new Set<string>(item.flags)
      const reasonNeeded = flagsNow ? flagsNow.requiresReason && (!item.flagReason || flagsNow.flags.some((f) => REASON_FLAGS.includes(f) && !stored.has(f))) : false
      const snapshot = item.payeeAccountNo && item.payeeBankCode ? { bankCode: item.payeeBankCode, accountNo: item.payeeAccountNo } : null
      const inForce = accountOf.get(item.supplierId)
      const account = snapshot ?? (inForce ? { bankCode: inForce.bankCode, accountNo: inForce.accountNo } : null)
      const mine = notices.filter((n) => n.subjectId === item.id)
      const last = mine.at(-1)
      return {
        id: item.id,
        seq: item.seq,
        supplier: item.supplier,
        account: account ? masked(account) : null,
        payableSatang: item.payableSatang.toString(),
        whtSatang: item.whtSatang.toString(),
        transferSatang: item.transferSatang.toString(),
        flags,
        flagReason: item.flagReason,
        reasonNeeded,
        status: item.status,
        paidOn: item.paidOn ? day(item.paidOn) : null,
        bankReference: item.bankReference,
        failureReason: item.failureReason,
        documents: links
          .filter((l) => l.paymentRunItemId === item.id)
          .map((l) => {
            const inv = l.invoice ?? l.retention?.invoice ?? null
            return {
              kind: l.docKind,
              id: l.invoiceId ?? l.retentionId!,
              number: inv?.number ?? null,
              supplierInvoiceNo: inv?.supplierInvoiceNo ?? null,
              dueDate: l.invoice?.dueDate ? day(l.invoice.dueDate) : null,
              payableSatang: l.payableSatang.toString(),
              status: l.status,
            }
          }),
        advice: last ? { status: last.status, sentAt: iso(last.sentAt), sendings: mine.length } : null,
      }
    })
    itemDtos.sort((a, b) => ((a.flags.length > 0) !== (b.flags.length > 0) ? (a.flags.length > 0 ? -1 : 1) : a.supplier.code < b.supplier.code ? -1 : a.supplier.code > b.supplier.code ? 1 : 0))

    const files = await tx.paymentFile.findMany({
      where: { paymentRunId: run.id },
      orderBy: { version: 'desc' },
      select: { id: true, version: true, fileName: true, sha256: true, itemCount: true, totalSatang: true, generatedAt: true, firstDownloadedAt: true, status: true, reason: true, fileId: true, generatedBy: { select: { displayNameTh: true, displayNameEn: true } } },
    })

    const history = await historyOf(tx, run, items.map((i) => ({ id: i.id, code: i.supplier.code, failureReason: i.failureReason })), tasks, files)

    // the member's open task of the run, while it waits for its approver
    const open = run.status === 'PENDING_APPROVAL' ? tasks.find((t) => t.status === 'OPEN' && (t.assigneeMemberId === me || t.principalMemberId === me)) : undefined
    const decision = open
      ? {
          taskId: open.id,
          stepUp: stepUpNeeded({ subjectType: open.step.route.subjectType, amountSatang: open.step.route.amountSatang, stepUpThresholdSatang: open.step.route.doaVersion.stepUpThresholdSatang }),
          flagsKey: now?.flagsKey ?? '',
        }
      : null

    const p = who.principal
    const preparer = isAllowed(p, 'paymentRun.prepare') && run.preparedById === me
    const file = isAllowed(p, 'paymentRun.file')
    const results = items.some((i) => i.status !== 'INCLUDED')
    const may = {
      edit: run.status === 'DRAFT' && preparer,
      cancelDraft: live && preparer,
      generate: run.status === 'APPROVED' && file,
      regenerate: run.status === 'FILE_READY' && file,
      download: (run.status === 'FILE_READY' || run.status === 'SENT_TO_BANK') && file,
      markSent: run.status === 'FILE_READY' && file,
      revertSent: run.status === 'SENT_TO_BANK' && file && !results,
      cancelApproved: (run.status === 'APPROVED' || run.status === 'FILE_READY') && isAllowed(p, 'paymentRun.cancel'),
      recordResults: run.status === 'SENT_TO_BANK' && isAllowed(p, 'paymentRun.recordResult'),
      resendAdvice: adviceEmail && items.some((i) => i.status === 'PAID') && isAllowed(p, 'paymentAdvice.resend'),
    }

    return ok({
      id: run.id,
      number: run.number,
      status: run.status,
      version: run.version,
      payDate: day(run.payDate),
      payer: masked(run.payer),
      fileTemplateCode: run.fileTemplateCode,
      neutralTemplate: run.fileTemplateCode === NEUTRAL_TEMPLATE_CODE,
      preparedBy: { th: run.preparedBy.displayNameTh, en: run.preparedBy.displayNameEn },
      totalPayableSatang: run.totalPayableSatang.toString(),
      totalWhtSatang: run.totalWhtSatang.toString(),
      totalTransferSatang: run.totalTransferSatang.toString(),
      itemCount: run.itemCount,
      documentCount: run.documentCount,
      flaggedItems: itemDtos.filter((i) => i.flags.length > 0).length,
      cancelReason: run.cancelReason,
      times: { submittedAt: iso(run.submittedAt), approvedAt: iso(run.approvedAt), sentToBankAt: iso(run.sentToBankAt), completedAt: iso(run.completedAt), cancelledAt: iso(run.cancelledAt) },
      items: itemDtos,
      files: files.map((f) => ({
        id: f.id,
        version: f.version,
        fileName: f.fileName,
        sha256Short: f.sha256.slice(0, SHA_SHORT),
        itemCount: f.itemCount,
        totalSatang: f.totalSatang.toString(),
        generatedBy: { th: f.generatedBy.displayNameTh, en: f.generatedBy.displayNameEn },
        generatedAt: f.generatedAt.toISOString(),
        firstDownloadedAt: iso(f.firstDownloadedAt),
        status: f.status,
        reason: f.reason,
      })),
      history,
      downloaded: { any: files.some((f) => f.firstDownloadedAt !== null), current: files.some((f) => f.status === 'CURRENT' && f.firstDownloadedAt !== null) },
      decision,
      adviceEmail,
      today: taxDateOf(ctx.now),
      may,
      addable: may.edit ? await addableDocuments(tx) : [],
    })
  })
}

/** BR-PAY-03: invoices ready for payment and released retentions, by supplier (a document in a live run is not ready) */
async function addableDocuments(tx: TenantTx): Promise<AddableSupplierDto[]> {
  const invoices = await tx.invoice.findMany({
    where: { kind: 'INVOICE', status: 'READY_FOR_PAYMENT' },
    orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    take: ADDABLE_LIMIT,
    select: { id: true, supplierId: true, number: true, supplierInvoiceNo: true, dueDate: true, payableSatang: true },
  })
  const retentions = await tx.retention.findMany({
    where: { status: 'RELEASABLE' },
    orderBy: [{ releaseDueOn: 'asc' }, { id: 'asc' }],
    take: ADDABLE_LIMIT,
    select: { id: true, supplierId: true, amountSatang: true, invoice: { select: { number: true, supplierInvoiceNo: true } } },
  })
  const supplierIds = [...new Set([...invoices.map((i) => i.supplierId), ...retentions.map((r) => r.supplierId)])]
  if (supplierIds.length === 0) return []
  const suppliers = await tx.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, nameTh: true, nameEn: true } })
  const withAccount = new Set((await tx.bankAccount.findMany({ where: { ownerKind: 'SUPPLIER', status: 'ACTIVE', supplierId: { in: supplierIds } }, select: { supplierId: true } })).map((a) => a.supplierId))
  return suppliers
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map((s) => ({
      supplier: { ...s, hasAccount: withAccount.has(s.id) },
      documents: [
        ...invoices.filter((i) => i.supplierId === s.id).map((i) => ({ kind: 'INVOICE' as const, id: i.id, number: i.number, supplierInvoiceNo: i.supplierInvoiceNo, dueDate: i.dueDate ? day(i.dueDate) : null, payableSatang: i.payableSatang.toString() })),
        ...retentions.filter((r) => r.supplierId === s.id).map((r) => ({ kind: 'RETENTION' as const, id: r.id, number: r.invoice.number, supplierInvoiceNo: r.invoice.supplierInvoiceNo, dueDate: null, payableSatang: r.amountSatang.toString() })),
      ],
    }))
}

type TaskRow = { id: string; reason: string | null }
type FileRow = { id: string; fileId: string; version: number }

/**
 * The run's history (FR-PLT-003 AC3): its own events, its items' (results, reasons, advice sent again), the approval
 * tasks of its routes (assigned, decided — with the DOA version and rule — and cancelled) and its files' downloads, in
 * the order they happened. A reason is shown as its member wrote it: kept on the run, the item, the task or a Comment,
 * never in Event.data (BR-BANK-08).
 */
async function historyOf(
  tx: TenantTx,
  run: { id: string; cancelReason: string | null },
  items: ReadonlyArray<{ id: string; code: string; failureReason: string | null }>,
  tasks: readonly TaskRow[],
  files: readonly FileRow[],
): Promise<RunEventDto[]> {
  const events = await tx.event.findMany({
    where: {
      OR: [
        { aggregateType: { in: RUN_EVENTS }, aggregateId: run.id },
        ...(items.length ? [{ aggregateType: 'PaymentRunItem', aggregateId: { in: items.map((i) => i.id) } }] : []),
        ...(tasks.length ? [{ aggregateType: 'ApprovalTask', aggregateId: { in: tasks.map((t) => t.id) } }] : []),
        ...(files.length ? [{ aggregateType: 'File', type: 'file.downloaded', aggregateId: { in: files.map((f) => f.fileId) } }] : []),
      ],
    },
    orderBy: { seq: 'asc' },
    select: { id: true, type: true, aggregateType: true, aggregateId: true, occurredAt: true, channel: true, actorType: true, actorMemberId: true, doaVersionId: true, doaRuleCode: true, data: true },
  })
  const actorIds = [...new Set(events.map((e) => e.actorMemberId).filter((m): m is string => !!m))]
  const actors = actorIds.length ? await tx.member.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayNameTh: true, displayNameEn: true } }) : []
  const versionIds = [...new Set(events.map((e) => e.doaVersionId).filter((v): v is string => !!v))]
  const versions = versionIds.length ? await tx.doaVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, code: true, versionNo: true } }) : []
  const commentIds = events.map((e) => (e.data as { reasonCommentId?: unknown } | null)?.reasonCommentId).filter((c): c is string => typeof c === 'string')
  const comments = commentIds.length ? await tx.comment.findMany({ where: { id: { in: commentIds }, retractedAt: null }, select: { id: true, body: true } }) : []
  const taskOf = new Map(tasks.map((t) => [t.id, t]))
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const fileOf = new Map(files.map((f) => [f.fileId, f]))
  return events.map((e) => {
    const data = (e.data ?? {}) as Record<string, unknown>
    const actor = e.actorMemberId ? actors.find((m) => m.id === e.actorMemberId) : undefined
    const version = e.doaVersionId ? versions.find((v) => v.id === e.doaVersionId) : undefined
    const item = e.aggregateType === 'PaymentRunItem' ? itemOf.get(e.aggregateId) : undefined
    const comment = typeof data.reasonCommentId === 'string' ? comments.find((c) => c.id === data.reasonCommentId)?.body : undefined
    let note: string | null = comment ?? null
    if (e.type === 'approval_task.decided') note = taskOf.get(e.aggregateId)?.reason ?? note
    if (e.type === 'payment_run.cancelled') note = run.cancelReason
    if (e.type === 'payment_run_item.failed') note = item?.failureReason ?? null
    const fileVersion = e.type === 'file.downloaded' ? (fileOf.get(e.aggregateId)?.version ?? null) : typeof data.version === 'number' ? data.version : null
    return {
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      channel: e.channel,
      actor: actor ? { th: actor.displayNameTh, en: actor.displayNameEn } : null,
      system: e.actorType === 'SYSTEM',
      decision: e.type === 'approval_task.decided' && typeof data.decision === 'string' ? data.decision : null,
      doa: version && e.doaRuleCode ? { versionId: version.id, code: version.code, versionNo: version.versionNo, ruleCode: e.doaRuleCode } : null,
      supplierCode: item?.code ?? null,
      fileVersion,
      note,
    }
  })
}
