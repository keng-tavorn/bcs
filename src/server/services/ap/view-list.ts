import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'
import { guard, INVOICEABLE_PO_STATUSES } from './common'

// What the tier-2 invoice screens list (S8-13, docs/sub-specs/S8.md "หน้าจอ", FR-AP-101 AC1 AC2, FR-AP-103 AC1): the
// invoices of /finance/invoices by tab (draft · exceptions · pending approval · ready for payment · all) with a search,
// the invoice inbox of /finance/invoices/inbox, and the POs an invoice can be made on for /finance/invoices/new and for
// an inbox file that waits for its PO. Every read checks the capability itself (invoice.record or invoice.inbox.manage,
// both with module PAY, BR-AP-13) before anything is read; the commands check again. Reads only.

/** The tabs of /finance/invoices and the statuses each one lists (null: every status) */
export const AP_LIST_TABS = ['draft', 'exceptions', 'pending', 'ready', 'all'] as const
export type ApListTab = (typeof AP_LIST_TABS)[number]
const TAB_STATUSES = {
  draft: ['DRAFT'],
  exceptions: ['EXCEPTION'],
  pending: ['PENDING_APPROVAL'],
  ready: ['READY_FOR_PAYMENT'],
  all: null,
} as const satisfies Record<ApListTab, readonly string[] | null>

const LIST_LIMIT = 100
const INBOX_LIMIT = 50
const PO_CHOICE_LIMIT = 300
const SEARCH_MAX = 60

/** Whether the organization takes tier-2 invoices (module PAY): /finance/invoices then lists them instead of tier 1 */
export async function apInvoicesOn(ctx: Ctx): Promise<boolean> {
  return (await requireModule(ctx, 'PAY')).ok
}

async function memberMay(tx: TenantTx, ctx: Ctx, capability: 'invoice.record' | 'invoice.inbox.manage' | 'retention.release' | 'wht.view'): Promise<boolean> {
  const allowed = await authorize(tx, ctx, capability)
  return allowed.ok && allowed.data.kind === 'member'
}

// ---------- /finance/invoices ----------

export interface ApInvoiceRowDto {
  readonly id: string
  /** AP-{BE}-{SEQ5}, given when it is submitted */
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly status: string
  readonly channel: string
  readonly invoiceDate: string | null
  readonly dueDate: string | null
  readonly supplier: { readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly po: { readonly id: string; readonly number: string | null }
  readonly netSatang: bigint
  readonly vatSatang: bigint
  readonly grossSatang: bigint
  readonly payableSatang: bigint
  /** Exceptions of the invoice still open */
  readonly openExceptions: number
  /** The match flagged it as a possible duplicate, not dismissed (BR-MATCH-08) */
  readonly possibleDuplicate: boolean
  readonly createdAt: Date
}

export interface ApInvoiceListDto {
  readonly tab: ApListTab
  readonly q: string
  readonly rows: readonly ApInvoiceRowDto[]
  readonly limited: boolean
  /** How many invoices each tab holds under the search */
  readonly counts: Readonly<Record<ApListTab, number>>
  /** The member may run the inbox (invoice.inbox.manage) */
  readonly canManageInbox: boolean
  /** The member may open /finance/retentions (retention.release) and /finance/wht (wht.view): links from the list */
  readonly canRetentions: boolean
  readonly canWht: boolean
}

function searchWhere(q: string) {
  if (!q) return {}
  // % and _ in what the member typed are letters, not wildcards (§4.10)
  const contains = { contains: escapeLike(q), mode: 'insensitive' as const }
  return { OR: [{ number: contains }, { supplierInvoiceNo: contains }, { po: { number: contains } }, { supplier: { nameTh: contains } }, { supplier: { nameEn: contains } }, { supplier: { code: contains } }] }
}

/** /finance/invoices with PAY on: FINANCE (invoice.record) */
export async function listApInvoices(ctx: Ctx, filter: { tab?: ApListTab | null; q?: string | null } = {}): Promise<Result<ApInvoiceListDto>> {
  const db = forTenant(ctx.organizationId)
  const access = await db.$transaction(async (tx) => {
    const who = await guard(tx, ctx, 'invoice.record')
    if (!who.ok) return who
    return { ok: true as const, canManageInbox: await memberMay(tx, ctx, 'invoice.inbox.manage'), canRetentions: await memberMay(tx, ctx, 'retention.release'), canWht: await memberMay(tx, ctx, 'wht.view') }
  })
  if (!access.ok) return err(access.error.code, access.error.message, access.error.details)
  const tab: ApListTab = filter.tab ?? 'draft'
  const q = (filter.q ?? '').trim().slice(0, SEARCH_MAX)
  const search = searchWhere(q)
  const statuses = TAB_STATUSES[tab]
  const [grouped, rows] = await Promise.all([
    db.invoice.groupBy({ by: ['status'], where: search, _count: { _all: true } }),
    db.invoice.findMany({
      where: { ...search, ...(statuses ? { status: { in: [...statuses] } } : {}) },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT + 1,
      select: {
        id: true,
        number: true,
        supplierInvoiceNo: true,
        status: true,
        channel: true,
        invoiceDate: true,
        dueDate: true,
        netSatang: true,
        statedVatSatang: true,
        grossSatang: true,
        payableSatang: true,
        createdAt: true,
        supplier: { select: { code: true, nameTh: true, nameEn: true } },
        po: { select: { id: true, number: true } },
        exceptions: { where: { status: { in: ['OPEN', 'ACCEPT_REQUESTED'] } }, select: { type: true, status: true } },
      },
    }),
  ])
  const byStatus = new Map(grouped.map((g) => [g.status as string, g._count._all]))
  const count = (tab: ApListTab) => {
    const s = TAB_STATUSES[tab]
    return s ? s.reduce((a, status) => a + (byStatus.get(status) ?? 0), 0) : [...byStatus.values()].reduce((a, b) => a + b, 0)
  }
  const counts = Object.fromEntries(AP_LIST_TABS.map((t) => [t, count(t)])) as Record<ApListTab, number>
  return ok({
    tab,
    q,
    limited: rows.length > LIST_LIMIT,
    counts,
    canManageInbox: access.canManageInbox,
    canRetentions: access.canRetentions,
    canWht: access.canWht,
    rows: rows.slice(0, LIST_LIMIT).map((r) => ({
      id: r.id,
      number: r.number,
      supplierInvoiceNo: r.supplierInvoiceNo,
      status: r.status,
      channel: r.channel,
      invoiceDate: r.invoiceDate?.toISOString().slice(0, 10) ?? null,
      dueDate: r.dueDate?.toISOString().slice(0, 10) ?? null,
      supplier: r.supplier,
      po: r.po,
      netSatang: r.netSatang,
      vatSatang: r.statedVatSatang,
      grossSatang: r.grossSatang,
      payableSatang: r.payableSatang,
      openExceptions: r.exceptions.length,
      possibleDuplicate: r.exceptions.some((e) => e.type === 'POSSIBLE_DUPLICATE' && e.status === 'OPEN'),
      createdAt: r.createdAt,
    })),
  })
}

// ---------- the POs an invoice can be made on ----------

export interface InvoiceablePoChoiceDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }
  readonly netSatang: bigint
}

/**
 * POs that can take a tier-2 invoice (BR-MATCH-05, BR-IVC-06): sent, received in part or in full, or closed, and not on
 * the tier-1 track; the last sent first. The command checks the PO again under its lock.
 */
async function invoiceablePos(ctx: Ctx): Promise<InvoiceablePoChoiceDto[]> {
  const rows = await forTenant(ctx.organizationId).purchaseOrder.findMany({
    where: { status: { in: [...INVOICEABLE_PO_STATUSES] }, OR: [{ invoiceTrack: 'MATCHING' }, { invoiceTrack: null, invoices: { none: {} } }] },
    orderBy: [{ sentAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: PO_CHOICE_LIMIT,
    select: { id: true, number: true, status: true, netSatang: true, supplier: { select: { id: true, code: true, nameTh: true, nameEn: true } } },
  })
  return rows
}

/** /finance/invoices/new: FINANCE (invoice.record, PAY on) chooses the PO */
export async function newApInvoiceView(ctx: Ctx): Promise<Result<{ readonly pos: readonly InvoiceablePoChoiceDto[] }>> {
  const who = await forTenant(ctx.organizationId).$transaction((tx) => guard(tx, ctx, 'invoice.record'))
  if (!who.ok) return err(who.error.code, who.error.message, who.error.details)
  return ok({ pos: await invoiceablePos(ctx) })
}

// ---------- /finance/invoices/inbox ----------

export interface InboxFileDto {
  readonly fileId: string
  readonly fileName: string
  /** The invoice that took the file (not cancelled or rejected); null: it waits for FINANCE to choose its PO */
  readonly invoice: { readonly id: string; readonly number: string | null; readonly status: string } | null
}

export interface InboxEmailDto {
  readonly id: string
  readonly receivedAt: Date
  readonly fromAddress: string
  readonly subject: string
  readonly status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED'
  /** IGNORED: why (NO_INVOICE_FILE, or the words FINANCE wrote) */
  readonly ignoreReason: string | null
  /** FAILED: the reader's code and how often it was tried */
  readonly failedCode: string | null
  readonly attempts: number
  readonly files: readonly InboxFileDto[]
  /** Attachments the inbox did not take, with why (FR-AP-101 AC2) */
  readonly skipped: ReadonlyArray<{ readonly fileName: string; readonly reason: string }>
  /** Drafts made from the message (any status) */
  readonly invoices: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly supplierInvoiceNo: string | null; readonly status: string; readonly poNumber: string | null }>
  /** PO numbers of the organization's pattern found in the subject or the file names */
  readonly poRefsFound: readonly string[]
  /** The supplier whose e-mail address sent it, when exactly one does (to list its POs first) */
  readonly senderSupplierId: string | null
}

export interface InboxViewDto {
  readonly address: string | null
  readonly emails: readonly InboxEmailDto[]
  readonly limited: boolean
  /** The member may make a draft from a waiting file (invoice.record) */
  readonly canRecord: boolean
  /** The POs a waiting file can be put on (empty without invoice.record) */
  readonly pos: readonly InvoiceablePoChoiceDto[]
}

const LIVE = (status: string) => status !== 'CANCELLED' && status !== 'REJECTED'

/** /finance/invoices/inbox: FINANCE (invoice.inbox.manage, PAY on) */
export async function getInvoiceInboxView(ctx: Ctx): Promise<Result<InboxViewDto>> {
  const db = forTenant(ctx.organizationId)
  const access = await db.$transaction(async (tx) => {
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay
    const allowed = await authorize(tx, ctx, 'invoice.inbox.manage')
    if (!allowed.ok) return allowed
    if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'members only')
    return ok({ canRecord: await memberMay(tx, ctx, 'invoice.record') })
  })
  if (!access.ok) return access
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const ap = ((org.settings ?? {}) as { ap?: { inboxAddress?: unknown } }).ap
  const address = typeof ap?.inboxAddress === 'string' && ap.inboxAddress ? ap.inboxAddress : null

  const emails = await db.inboundEmail.findMany({
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: INBOX_LIMIT + 1,
    select: {
      id: true,
      receivedAt: true,
      fromAddress: true,
      subject: true,
      status: true,
      ignoreReason: true,
      attempts: true,
      poRefsFound: true,
      invoices: { orderBy: { createdAt: 'asc' }, select: { id: true, number: true, supplierInvoiceNo: true, status: true, sourceFileId: true, po: { select: { number: true } } } },
    },
  })
  const shown = emails.slice(0, INBOX_LIMIT)
  const ids = shown.map((e) => e.id)
  const [links, events, senders] = await Promise.all([
    ids.length ? db.fileLink.findMany({ where: { subjectType: 'InboundEmail', subjectId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { subjectId: true, file: { select: { id: true, fileName: true } } } }) : [],
    ids.length
      ? db.event.findMany({ where: { aggregateType: 'InboundEmail', aggregateId: { in: ids }, type: { in: ['inbound_email.processed', 'inbound_email.ignored', 'inbound_email.failed'] } }, orderBy: { seq: 'desc' }, select: { aggregateId: true, type: true, data: true } })
      : [],
    shown.length ? db.supplier.findMany({ where: { email: { in: [...new Set(shown.map((e) => e.fromAddress))], mode: 'insensitive' } }, select: { id: true, email: true } }) : [],
  ])
  // A file is another invoice's paper too when an invoice of another message took it (never by the commands, kept for safety)
  const fileIds = links.map((l) => l.file.id)
  const takers = fileIds.length ? await db.invoice.findMany({ where: { sourceFileId: { in: fileIds }, status: { notIn: ['CANCELLED', 'REJECTED'] } }, select: { id: true, number: true, status: true, sourceFileId: true } }) : []
  const takerOf = new Map(takers.map((t) => [t.sourceFileId!, { id: t.id, number: t.number, status: t.status }]))
  const lastEvent = (id: string, type: string) => events.find((e) => e.aggregateId === id && e.type === type)?.data as Record<string, unknown> | undefined
  const skippedOf = (id: string) => {
    const data = lastEvent(id, 'inbound_email.processed') ?? lastEvent(id, 'inbound_email.ignored')
    const list = Array.isArray(data?.skipped) ? (data.skipped as unknown[]) : []
    return list.flatMap((s) => {
      const item = s as { fileName?: unknown; reason?: unknown }
      return typeof item.fileName === 'string' && typeof item.reason === 'string' ? [{ fileName: item.fileName, reason: item.reason }] : []
    })
  }
  const senderOf = (from: string) => {
    const matched = senders.filter((s) => s.email?.toLowerCase() === from.toLowerCase())
    return matched.length === 1 ? matched[0]!.id : null
  }

  return ok({
    address,
    limited: emails.length > INBOX_LIMIT,
    canRecord: access.data.canRecord,
    pos: access.data.canRecord ? await invoiceablePos(ctx) : [],
    emails: shown.map((e) => {
      const failed = e.status === 'FAILED' ? lastEvent(e.id, 'inbound_email.failed') : undefined
      return {
        id: e.id,
        receivedAt: e.receivedAt,
        fromAddress: e.fromAddress,
        subject: e.subject,
        status: e.status,
        ignoreReason: e.ignoreReason,
        failedCode: typeof failed?.code === 'string' ? failed.code : null,
        attempts: e.attempts,
        files: links.filter((l) => l.subjectId === e.id).map((l) => ({ fileId: l.file.id, fileName: l.file.fileName, invoice: takerOf.get(l.file.id) ?? null })),
        skipped: skippedOf(e.id),
        invoices: e.invoices.map((i) => ({ id: i.id, number: i.number, supplierInvoiceNo: i.supplierInvoiceNo, status: i.status, poNumber: i.po.number })),
        poRefsFound: e.poRefsFound,
        senderSupplierId: senderOf(e.fromAddress),
      }
    }),
  })
}

/** Whether a message can still be skipped (the command refuses the same): not skipped yet and no live invoice from it */
export function canIgnoreEmail(email: Pick<InboxEmailDto, 'status' | 'invoices'>): boolean {
  return email.status !== 'IGNORED' && !email.invoices.some((i) => LIVE(i.status))
}
