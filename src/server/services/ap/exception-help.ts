import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { lineKey } from '@/core/duplicates'
import { taxDateOf } from '@/core/vat'
import { MS_PER_DAY } from '@/lib/constants'
import { HELP_MESSAGE_MAX, type HelpFix } from '@/lib/exception-help'
import { newId } from '@/lib/ids'
import { s6SettingsOf } from '@/lib/org-settings'
import { authorize, isAllowed, loadPrincipal, scopesFor, type Principal, type ResourceScope } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { effectiveSodPolicy } from '@/server/doa/policy'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { isUuid } from '@/server/queries/requests'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice, SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-notices'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { CHANGEABLE_PO } from '../purchase-orders/change'
import { receivingDecision } from '../receiving/access'
import { departmentReceivers } from '../receiving/receivers'
import { fail } from './common'
import { invoiceScopes, mayReadInvoice, resolvesInvoice } from './file-policy'
import { INVOICED_STATUSES } from './match-run'

// The helper of an invoice's differences (NEW-126 · ADR-081 · "ผู้ช่วยตรวจเอกสาร" of docs/reports/bcs-assistants.md):
// for each difference still OPEN that the reader may see — sent to their role (BR-MATCH-09, within the grant's scope) or
// read by FINANCE who records invoices — code gathers what it rests on: the PO line and what this invoice bills of it,
// the goods received, the agreed price with the supplier and what the organization paid before (the last only for those
// who read every PO). Then the ways to settle it that the reader really has (BR-MATCH-10 and the roles of §2.4: ask for
// a price variance, change the PO, receive the rest, check again, dismiss a possible duplicate, reopen, reject, move
// budget), and who a question may go to. Nothing here is written by an AI and nothing here decides.
//
// match_exception.message sends what a person read and confirmed: a question to a receiver or requester of the PO line
// (in the app, and by LINE or e-mail with the invoice and PO numbers only · BR-NOTI-01, BR-AP-09), or an e-mail to the
// supplier through SupplierNotice (ADR-126). Only a member sends it (BR-AI-01: never an agent, never the system), each
// send is an Event naming who pressed it, and neither the event nor a log carries the text.

type Role = 'PROCUREMENT' | 'RECEIVER' | 'FINANCE'

/** The ways to settle each kind of difference, in the order the helper offers them (BR-MATCH-10) */
const FIXES_OF: Readonly<Record<string, readonly HelpFix[]>> = {
  PRICE_OVER: ['VARIANCE', 'PO_CHANGE', 'ASK', 'EMAIL_SUPPLIER', 'RECHECK', 'REOPEN', 'REJECT'],
  QTY_OVER_ORDERED: ['PO_CHANGE', 'ASK', 'EMAIL_SUPPLIER', 'RECHECK', 'REOPEN', 'REJECT'],
  QTY_NOT_RECEIVED: ['RECEIVE', 'ASK', 'RECHECK', 'EMAIL_SUPPLIER', 'REOPEN', 'REJECT'],
  ACCEPTANCE_PENDING: ['RECEIVE', 'ASK', 'RECHECK', 'EMAIL_SUPPLIER', 'REOPEN', 'REJECT'],
  VAT_MISMATCH: ['REOPEN', 'EMAIL_SUPPLIER', 'REJECT'],
  VAT_SUPPLIER_NOT_REGISTERED: ['EMAIL_SUPPLIER', 'REJECT'],
  POSSIBLE_DUPLICATE: ['DISMISS_DUPLICATE', 'REJECT'],
  BUDGET_SHORT: ['BUDGET_TRANSFER', 'RECHECK'],
}

/** Kinds whose question goes to the receivers as well as the requesters: what was received is theirs to say */
const RECEIVING_KINDS: readonly string[] = ['QTY_NOT_RECEIVED', 'ACCEPTANCE_PENDING']
/** Kinds a question to the PO line's people is about; a whole-invoice difference has nobody on the line to ask */
const ASKING_KINDS: readonly string[] = ['PRICE_OVER', 'QTY_OVER_ORDERED', ...RECEIVING_KINDS]
/** Kinds the supplier can put right with a credit note or a new invoice */
const SUPPLIER_KINDS: readonly string[] = ['PRICE_OVER', 'QTY_OVER_ORDERED', 'QTY_NOT_RECEIVED', 'ACCEPTANCE_PENDING', 'VAT_MISMATCH', 'VAT_SUPPLIER_NOT_REGISTERED']
/** A PO still taking receipts (gr.post) */
const RECEIVING_PO: readonly string[] = ['SENT', 'PARTIALLY_RECEIVED']
/** The POs whose prices count as paid before (BR-PRC-01's statuses) */
const PRICED_PO_EXCLUDED = ['REJECTED', 'CANCELLED', 'DRAFT', 'PENDING_APPROVAL'] as const
const PAST_PRICES_SHOWN = 3

export interface HelpMemberDto {
  readonly id: string
  readonly th: string
  readonly en: string | null
  /** RECEIVER: received the PO's goods or receives for a department that asked for them · REQUESTER: asked for the line */
  readonly relation: 'RECEIVER' | 'REQUESTER'
}

export interface ExceptionHelpDto {
  readonly exceptionId: string
  readonly type: string
  readonly assigneeRole: Role
  readonly amountSatang: bigint
  readonly quantity: string | null
  /** The PO line and this invoice's line, for a difference of one line */
  readonly line: {
    readonly lineNo: number
    readonly poLineNo: number
    readonly description: string
    readonly uom: string
    readonly ordered: string
    readonly received: string
    readonly cancelled: string
    readonly invoicedElsewhere: string
    readonly invoiced: string
    readonly poUnitPriceSatang: bigint
    readonly unitPriceSatang: bigint
  } | null
  /** The goods received on the line (posted receipts, the last one's day in the organization's time), for a quantity difference */
  readonly receipts: { readonly count: number; readonly lastOn: string | null } | null
  /** The supplier's agreed price for the line's catalogue item on the invoice's date, for a price difference */
  readonly agreement: { readonly kind: 'FOUND'; readonly unitPriceSatang: bigint; readonly validTo: string } | { readonly kind: 'NONE' | 'NO_ITEM' } | null
  /** What the organization paid for the same item before, for a price difference read by one who reads every PO */
  readonly pastPrices: {
    readonly windowDays: number
    readonly count: number
    readonly recent: ReadonlyArray<{ readonly poNumber: string | null; readonly unitPriceSatang: bigint; readonly approvedOn: string; readonly priceIncludesVat: boolean }>
  } | null
  /** The ways the reader has, in the helper's order, each with where it is done */
  readonly fixes: ReadonlyArray<{ readonly key: HelpFix; readonly href: string }>
  /** Who a question may go to (never the reader); empty when the kind has nobody to ask */
  readonly recipients: readonly HelpMemberDto[]
  /** The supplier may be e-mailed by this reader about this kind; `hasEmail` false: the supplier has no address */
  readonly email: { readonly hasEmail: boolean } | null
}

export interface InvoiceHelpDto {
  readonly invoiceId: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly po: { readonly id: string; readonly number: string | null }
  readonly supplier: { readonly nameTh: string; readonly nameEn: string | null }
  readonly statedVatSatang: bigint
  readonly helps: readonly ExceptionHelpDto[]
}

interface OpenException {
  readonly id: string
  readonly type: string
  readonly assigneeRole: Role
  readonly amountSatang: bigint
  readonly quantity: { toString(): string } | null
  readonly status: string
  readonly invoiceLine: { readonly id: string; readonly poLineId: string } | null
}

/** Whether the reader sees the helper of this difference: FINANCE who records invoices, or the role it is sent to */
function sees(principal: Principal, e: Pick<OpenException, 'assigneeRole'>, scopes: readonly ResourceScope[]): boolean {
  return isAllowed(principal, 'invoice.record') || resolvesInvoice(principal, new Set([e.assigneeRole]), scopes)
}

/** Whether the reader may e-mail the supplier about it: FINANCE, or PROCUREMENT about what is sent to them */
function emails(principal: Principal, e: Pick<OpenException, 'assigneeRole' | 'type'>, scopes: readonly ResourceScope[]): boolean {
  if (!SUPPLIER_KINDS.includes(e.type)) return false
  return isAllowed(principal, 'invoice.record') || (e.assigneeRole === 'PROCUREMENT' && resolvesInvoice(principal, new Set(['PROCUREMENT']), scopes))
}

/** The people of the PO line a question may go to, active members other than the reader, by name */
async function recipientsOf(tx: TenantTx, ctx: Ctx, e: OpenException, poId: string, me: string): Promise<HelpMemberDto[]> {
  if (!e.invoiceLine || !ASKING_KINDS.includes(e.type)) return []
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLineId: e.invoiceLine.poLineId } } } } }, select: { requesterMemberId: true, requesterDepartmentId: true } })
  const relation = new Map<string, HelpMemberDto['relation']>(requests.map((r) => [r.requesterMemberId, 'REQUESTER' as const]))
  if (RECEIVING_KINDS.includes(e.type)) {
    const posted = await tx.goodsReceipt.findMany({ where: { poId, lines: { some: { poLineId: e.invoiceLine.poLineId } } }, select: { receiverMemberId: true } })
    const department = await departmentReceivers(tx, ctx.organizationId, [...new Set(requests.map((r) => r.requesterDepartmentId))], ctx.now)
    for (const id of [...posted.map((g) => g.receiverMemberId), ...department]) if (!relation.has(id)) relation.set(id, 'RECEIVER')
  }
  relation.delete(me)
  if (relation.size === 0) return []
  const members = await tx.member.findMany({ where: { id: { in: [...relation.keys()] }, status: 'ACTIVE' }, select: { id: true, displayNameTh: true, displayNameEn: true }, orderBy: [{ displayNameTh: 'asc' }, { id: 'asc' }] })
  // Receivers first: for a quantity difference they are the ones who know
  return members
    .map((m) => ({ id: m.id, th: m.displayNameTh, en: m.displayNameEn, relation: relation.get(m.id)! }))
    .sort((a, b) => (a.relation === b.relation ? 0 : a.relation === 'RECEIVER' ? -1 : 1))
}

/** Whether the reader may receive on the PO now (gr.post with BR-SOD-02 and BR-SOD-07 — the receiving page's decision) */
async function receivesOn(tx: TenantTx, ctx: Ctx, principal: Principal, poId: string): Promise<boolean> {
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId } } } } } }, select: { id: true, requesterMemberId: true, requesterDepartmentId: true } })
  const decided = await tx.approvalTask.findMany({
    where: { status: 'APPROVED', step: { route: { OR: [{ subjectType: 'REQUEST', subjectId: { in: requests.map((r) => r.id) } }, { subjectType: 'PURCHASE_ORDER', subjectId: poId }] } } },
    select: { decidedByMemberId: true, principalMemberId: true },
  })
  const approvers = [...new Set(decided.flatMap((t) => [t.decidedByMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)))]
  return receivingDecision(principal, await effectiveSodPolicy(tx, ctx.now), { requests, approvers }).kind === 'RECEIVE'
}

/**
 * The helper of every OPEN difference of the invoice the reader may see (above). NOT_FOUND when the id is no invoice of
 * the organization, FORBIDDEN for a member who does not read it, MODULE_DISABLED with PAY off. Read only.
 */
export async function getExceptionHelp(ctx: Ctx, invoiceId: string): Promise<Result<InvoiceHelpDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'a member reads the helper')
  const me = ctx.actor.memberId
  if (!isUuid(invoiceId)) return err('NOT_FOUND', 'invoice not found')
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<InvoiceHelpDto>> => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true,
        number: true,
        status: true,
        supplierId: true,
        supplierInvoiceNo: true,
        invoiceDate: true,
        statedVatSatang: true,
        po: { select: { id: true, number: true, status: true } },
        supplier: { select: { nameTh: true, nameEn: true, email: true } },
        lines: { select: { id: true, lineNo: true, poLineId: true, quantity: true, unitPriceSatang: true } },
        exceptions: {
          where: { status: { in: ['OPEN', 'ACCEPT_REQUESTED'] } },
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, assigneeRole: true, amountSatang: true, quantity: true, status: true, invoiceLine: { select: { id: true, poLineId: true } } },
        },
      },
    })
    if (!invoice) return err('NOT_FOUND', 'invoice not found')
    const principal = await loadPrincipal(tx, ctx)
    const openRoles: ReadonlySet<string> = new Set(invoice.exceptions.filter((e) => e.status === 'OPEN').map((e) => e.assigneeRole))
    const scopes = await invoiceScopes(tx, invoice.po.id)
    if (!mayReadInvoice(principal, openRoles, scopes)) return err('FORBIDDEN', 'you do not read this invoice', { capability: 'invoice.record' })
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return pay

    const head = { invoiceId: invoice.id, number: invoice.number, supplierInvoiceNo: invoice.supplierInvoiceNo, po: { id: invoice.po.id, number: invoice.po.number }, supplier: { nameTh: invoice.supplier.nameTh, nameEn: invoice.supplier.nameEn }, statedVatSatang: invoice.statedVatSatang }
    // Only an invoice the match stopped has differences to settle; one waiting for its variance approval waits
    if (invoice.status !== 'EXCEPTION') return ok({ ...head, helps: [] })
    const mine = invoice.exceptions.filter((e) => e.status === 'OPEN' && sees(principal, e, scopes)) as OpenException[]
    if (mine.length === 0) return ok({ ...head, helps: [] })

    const open = invoice.exceptions.filter((e) => e.status === 'OPEN')
    const record = isAllowed(principal, 'invoice.record')
    const may: Readonly<Record<HelpFix, boolean>> = {
      VARIANCE: isAllowed(principal, 'invoice.variance.request') && open.every((e) => e.type === 'PRICE_OVER'),
      PO_CHANGE: isAllowed(principal, 'po.change') && (CHANGEABLE_PO as readonly string[]).includes(invoice.po.status),
      RECEIVE: RECEIVING_PO.includes(invoice.po.status) && (await receivesOn(tx, ctx, principal, invoice.po.id)),
      ASK: true,
      EMAIL_SUPPLIER: true,
      RECHECK: record || resolvesInvoice(principal, openRoles, scopes),
      DISMISS_DUPLICATE: record,
      REOPEN: record,
      REJECT: isAllowed(principal, 'invoice.reject'),
      BUDGET_TRANSFER: scopesFor(principal, 'budget.transfer.submit').size > 0,
    }
    const seesEveryPo = scopesFor(principal, 'po.view').has('ORG')
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const windowDays = s6SettingsOf(org.settings).priceRefWindowDays
    const invoiceDay = invoice.invoiceDate ?? ctx.now

    const helps: ExceptionHelpDto[] = []
    for (const e of mine) {
      const invoiceLine = e.invoiceLine ? invoice.lines.find((l) => l.id === e.invoiceLine!.id) : undefined
      const poLine = invoiceLine ? await tx.poLine.findUniqueOrThrow({ where: { id: invoiceLine.poLineId }, select: { id: true, lineNo: true, description: true, uom: true, quantity: true, receivedQuantity: true, cancelledQuantity: true, unitPriceSatang: true, sources: { select: { requestLine: { select: { catalogItemId: true } } } } } }) : null
      let line: ExceptionHelpDto['line'] = null
      let receipts: ExceptionHelpDto['receipts'] = null
      let agreement: ExceptionHelpDto['agreement'] = null
      let pastPrices: ExceptionHelpDto['pastPrices'] = null
      if (invoiceLine && poLine) {
        const elsewhere = await tx.invoiceLine.aggregate({ where: { poLineId: poLine.id, invoice: { id: { not: invoice.id }, status: { in: [...INVOICED_STATUSES] } } }, _sum: { quantity: true } })
        line = {
          lineNo: invoiceLine.lineNo,
          poLineNo: poLine.lineNo,
          description: poLine.description,
          uom: poLine.uom,
          ordered: poLine.quantity.toString(),
          received: poLine.receivedQuantity.toString(),
          cancelled: poLine.cancelledQuantity.toString(),
          invoicedElsewhere: (elsewhere._sum.quantity ?? 0).toString(),
          invoiced: invoiceLine.quantity.toString(),
          poUnitPriceSatang: poLine.unitPriceSatang,
          unitPriceSatang: invoiceLine.unitPriceSatang,
        }
        if (RECEIVING_KINDS.includes(e.type)) {
          const posted = await tx.goodsReceipt.findMany({ where: { poId: invoice.po.id, status: 'POSTED', lines: { some: { poLineId: poLine.id } } }, select: { postedAt: true }, orderBy: { postedAt: 'desc' } })
          const last = posted[0]?.postedAt
          receipts = { count: posted.length, lastOn: last ? taxDateOf(last) : null }
        }
        if (e.type === 'PRICE_OVER') {
          const items = [...new Set(poLine.sources.map((s) => s.requestLine.catalogItemId).filter((id): id is string => Boolean(id)))]
          if (items.length === 0) agreement = { kind: 'NO_ITEM' }
          else {
            const found = await tx.priceAgreement.findFirst({
              where: { catalogItemId: { in: items }, supplierId: invoice.supplierId, validFrom: { lte: invoiceDay }, validTo: { gt: invoiceDay }, OR: [{ endedAt: null }, { endedAt: { gt: invoiceDay } }] },
              orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
              select: { unitPriceSatang: true, validTo: true },
            })
            agreement = found ? { kind: 'FOUND', unitPriceSatang: found.unitPriceSatang, validTo: found.validTo.toISOString().slice(0, 10) } : { kind: 'NONE' }
          }
          if (seesEveryPo) {
            // The same item as BR-DUP-01 keys it (a catalogue item, else the description and unit), on other POs
            const key = lineKey({ catalogItemId: items[0] ?? null, description: poLine.description, uom: poLine.uom })
            const since = new Date(ctx.now.getTime() - windowDays * MS_PER_DAY)
            const rows = await tx.poLine.findMany({
              where: {
                poId: { not: invoice.po.id },
                po: { approvedAt: { gte: since, lte: ctx.now }, status: { notIn: [...PRICED_PO_EXCLUDED] } },
                OR: [...(items.length ? [{ sources: { some: { requestLine: { catalogItemId: { in: items } } } } }] : []), { description: poLine.description }],
              },
              orderBy: [{ po: { approvedAt: 'desc' } }, { id: 'asc' }],
              select: { description: true, uom: true, unitPriceSatang: true, po: { select: { number: true, approvedAt: true, priceIncludesVat: true } }, sources: { select: { requestLine: { select: { catalogItemId: true } } } } },
            })
            const same = rows.filter((r) => lineKey({ catalogItemId: r.sources.map((s) => s.requestLine.catalogItemId).find((id): id is string => Boolean(id)) ?? null, description: r.description, uom: r.uom }) === key)
            pastPrices = {
              windowDays,
              count: same.length,
              recent: same.slice(0, PAST_PRICES_SHOWN).map((r) => ({ poNumber: r.po.number, unitPriceSatang: r.unitPriceSatang, approvedOn: taxDateOf(r.po.approvedAt!), priceIncludesVat: r.po.priceIncludesVat })),
            }
          }
        }
      }
      const recipients = await recipientsOf(tx, ctx, e, invoice.po.id, me)
      const emailing = emails(principal, e, scopes)
      const page = `/finance/invoices/${invoice.id}`
      const here = `exception-help-${e.id}`
      const href: Readonly<Record<HelpFix, string>> = {
        VARIANCE: `${page}#invoice-exception-actions`,
        PO_CHANGE: `/procurement/pos/${invoice.po.id}/change`,
        RECEIVE: `/receiving/${invoice.po.id}`,
        ASK: `#${here}-ask`,
        EMAIL_SUPPLIER: `#${here}-email`,
        RECHECK: `${page}#invoice-exception-actions`,
        DISMISS_DUPLICATE: `${page}#invoice-exception-actions`,
        REOPEN: `${page}#invoice-exception-actions`,
        REJECT: `${page}#invoice-exception-actions`,
        BUDGET_TRANSFER: '/budgets/transfers/new',
      }
      const has = (fix: HelpFix) => (fix === 'ASK' ? recipients.length > 0 : fix === 'EMAIL_SUPPLIER' ? emailing && !!invoice.supplier.email : may[fix])
      helps.push({
        exceptionId: e.id,
        type: e.type,
        assigneeRole: e.assigneeRole,
        amountSatang: e.amountSatang,
        quantity: e.quantity?.toString() ?? null,
        line,
        receipts,
        agreement,
        pastPrices,
        fixes: (FIXES_OF[e.type] ?? []).filter(has).map((key) => ({ key, href: href[key] })),
        recipients,
        email: emailing ? { hasEmail: !!invoice.supplier.email } : null,
      })
    }
    return ok({ ...head, helps })
  })
}

// ---------- match_exception.message ----------

const MessageInput = z.strictObject({
  exceptionId: z.uuid(),
  /** MEMBER: a receiver or requester of the line, in the app (and LINE) · SUPPLIER: an e-mail to the supplier */
  to: z.enum(['MEMBER', 'SUPPLIER']),
  memberId: z.uuid().optional(),
  text: z.string().trim().min(1).max(HELP_MESSAGE_MAX),
})

export interface SentMessage {
  readonly exceptionId: string
  readonly to: 'MEMBER' | 'SUPPLIER'
}

export const sendExceptionMessageCommand = defineCommand({
  name: 'match_exception.message',
  capability: 'invoice.exception.resolve',
  input: MessageInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SentMessage>> {
    // BR-AI-01: a person presses send; an agent or a job never does
    if (ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'only a member sends a message from the helper')
    const allowed = await authorize(tx, ctx, 'invoice.exception.resolve')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const principal = allowed.data
    if (principal.kind !== 'member') return fail('FORBIDDEN', 'only a member sends a message from the helper')
    const pay = await requireModule(ctx, 'PAY', tx)
    if (!pay.ok) return { ok: false, error: pay.error }
    const exception = await tx.matchException.findFirst({
      where: { id: input.exceptionId },
      select: {
        id: true,
        type: true,
        assigneeRole: true,
        amountSatang: true,
        quantity: true,
        status: true,
        invoiceLine: { select: { id: true, poLineId: true } },
        invoice: { select: { id: true, number: true, status: true, supplierId: true, supplierInvoiceNo: true, po: { select: { id: true, number: true } }, supplier: { select: { email: true } } } },
      },
    })
    if (!exception) return fail('NOT_FOUND', 'exception not found')
    const invoice = exception.invoice
    const scopes = await invoiceScopes(tx, invoice.po.id)
    if (!sees(principal, exception, scopes)) return fail('FORBIDDEN', 'the difference is not sent to you', { capability: 'invoice.exception.resolve' })
    if (exception.status !== 'OPEN' || invoice.status !== 'EXCEPTION') return fail('INVALID_STATE_TRANSITION', `match_exception.message is not allowed from ${exception.status}`, { from: exception.status, command: 'match_exception.message' })
    const sender = await tx.member.findUniqueOrThrow({ where: { id: principal.memberId }, select: { displayNameTh: true, displayNameEn: true } })
    const base = { exceptionId: exception.id, type: exception.type }

    if (input.to === 'MEMBER') {
      if (!input.memberId) return fail('VALIDATION_FAILED', 'who the question goes to', { field: 'memberId' })
      const recipient = (await recipientsOf(tx, ctx, exception as OpenException, invoice.po.id, principal.memberId)).find((r) => r.id === input.memberId)
      if (!recipient) return fail('FORBIDDEN', 'the question goes to a receiver or requester of the line only', { reason: 'RECIPIENT_NOT_ALLOWED' })
      const notification: NotificationDraft = {
        recipientMemberId: recipient.id,
        templateKey: 'invoice.question',
        data: { number: invoice.number, invoiceId: invoice.id, poId: invoice.po.id, poNumber: invoice.po.number, relation: recipient.relation, senderTh: sender.displayNameTh, senderEn: sender.displayNameEn, text: input.text },
        urgency: 'IMMEDIATE',
        // One notice per send; the command's idempotency key keeps a resend from writing a second one
        dedupeKey: `invoice.question:${exception.id}:${newId()}`,
        subjectType: 'INVOICE',
        subjectId: invoice.id,
      }
      const events: EventDraft[] = [{ type: 'invoice.question_sent', aggregateType: 'Invoice', aggregateId: invoice.id, data: { ...base, recipientMemberId: recipient.id, relation: recipient.relation } }]
      return { ok: true, result: { exceptionId: exception.id, to: 'MEMBER' }, events, notifications: [notification] }
    }

    if (!emails(principal, exception, scopes)) return fail('FORBIDDEN', 'FINANCE, or PROCUREMENT about its own differences, e-mails the supplier', { reason: 'SUPPLIER_NOT_ALLOWED' })
    if (!invoice.supplier.email) return fail('VALIDATION_FAILED', 'the supplier has no e-mail address', { field: 'to', reason: 'SUPPLIER_NO_EMAIL' })
    const notice = await enqueueSupplierNotice(tx, ctx, {
      templateKey: SUPPLIER_TEMPLATES.invoiceQuestion,
      supplierId: invoice.supplierId,
      subjectType: 'Invoice',
      subjectId: invoice.id,
      dedupeKey: `invoice_question:${exception.id}:${newId()}`,
      data: { number: invoice.number, supplierInvoiceNo: invoice.supplierInvoiceNo, poNumber: invoice.po.number, senderTh: sender.displayNameTh, senderEn: sender.displayNameEn, text: input.text },
    })
    // A fresh key always makes its row: none means a fault, never a send to report
    if (!notice.noticeId) throw new Error('supplier notice of a fresh key was not written')
    const events: EventDraft[] = [{ type: 'invoice.supplier_asked', aggregateType: 'Invoice', aggregateId: invoice.id, data: { ...base, noticeId: notice.noticeId } }, ...notice.events]
    return { ok: true, result: { exceptionId: exception.id, to: 'SUPPLIER' }, events, notifications: notice.notifications, outbox: notice.outbox }
  },
})

export function sendExceptionMessage(ctx: Ctx, input: z.input<typeof MessageInput>, options: RunOptions) {
  return runCommand(ctx, sendExceptionMessageCommand, input, options)
}
