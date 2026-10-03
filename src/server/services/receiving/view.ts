import { z } from 'zod'
import { resolveRoute } from '@/core/doa'
import { lineNet, parseQuantity, vatFromNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import type { SodPolicy, SodRule } from '@/core/sod'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { isAllowed, loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { effectiveSodPolicy, loadRoutePolicy } from '@/server/doa/policy'
import {
  getReceivingPo,
  listReceivingCandidates,
  poViewFacts,
  RECEIVABLE_PO_STATUSES,
  RECEIVING_PAGE_SIZE,
  type PoViewFactsDto,
  type ReceiptDto,
  type ReceivingCandidateDto,
  type ReceivingLineDto,
  type ReceivingPoDto,
  type VarianceDto,
} from '@/server/queries/receiving'
import { approverRoles, membersById, type ApproverRoleDto, type MemberRefDto } from '@/server/queries/requests'
import type { RunOptions } from '../_pipeline'
import { receivesAtAll, receivingDecision, type ReceivingDecision } from './access'
import { recordGrPreviewSodBlock } from './index'
import { photosUsable } from './photos'
import { receiveOnLine, shortNow, stillToCome, type LineStanding } from './standing'

// What the receiving screens show (spec §9.1 /receiving, FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2, §9.9 principle 3), on
// the web and later in LIFF (S5-06): the POs a member may receive, a page at a time, one PO with what came and what is
// still to come, and — before anything is posted — what a receipt will do: what is accepted, what lies beyond what is
// still on order and must go back or wait for the GR_VARIANCE approver (named), what is damaged, and the PO's status
// after it. Every rule stays in the gr.post and po.close_short commands, which check again; this file reads, decides who
// may see what, and calculates with ./standing.ts exactly as the commands do. Who may open a PO's receiving page: whoever
// may receive it (gr.post) once it went to the supplier, and whoever may view it (po.view, §2.4). Amounts — the PO's
// prices and what a variance is worth — are shown to po.view only, with the facts the PO's PDF and the PO page use: the
// organization roles, who sent the PO and the requesters of its PRs (OWN), and its approvers (ASSIGNED). A RECEIVER
// receives by quantity: §2.4 also names "the assigned receiver" under po.view, but no screen of a PO treats a receiver
// as assigned yet (no assignment exists apart from the department), so that waits for the user's decision.

const Quantity = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/)
const scaled = (text: string): bigint => parseQuantity(text)
const MAX_PHOTOS = 20

type Receivable = (typeof RECEIVABLE_PO_STATUSES)[number]
const takesGoods = (status: string): status is Receivable => (RECEIVABLE_PO_STATUSES as readonly string[]).includes(status)
/** PO statuses reached only after the PO went to the supplier (§6.4) */
const WENT_OUT = [...RECEIVABLE_PO_STATUSES, 'RECEIVED', 'CLOSED'] as const

async function principalAndPolicy(ctx: Ctx): Promise<{ principal: Principal; sodPolicy: SodPolicy }> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => ({ principal: await loadPrincipal(tx, ctx), sodPolicy: await effectiveSodPolicy(tx, ctx.now) }))
}

/** po.view on this PO (§2.4), from the facts the PO pages and its PDF use */
function viewsPo(principal: Principal, facts: PoViewFactsDto): boolean {
  return isAllowed(principal, 'po.view', { ownerMemberIds: facts.ownerMemberIds, assigneeMemberIds: facts.assigneeMemberIds })
}

/** Where a line of the read model stands (./standing.ts) */
const standingOfLine = (l: ReceivingLineDto): LineStanding => ({ ordered: scaled(l.ordered), received: scaled(l.received), cancelled: scaled(l.cancelled), keepPending: scaled(l.keepPending) })

// ---------- who approves a variance kept (GR_VARIANCE, BR-GR-03) ----------

export type ApproverPreviewDto =
  /** The first approver the DOA engine names now; the route is made again, under lock, when the receipt is posted */
  | { readonly kind: 'ROUTE'; readonly ruleCode: string; readonly assignee: MemberRefDto | null; readonly actingFor: MemberRefDto | null; readonly role: ApproverRoleDto }
  /**
   * Keeping it is not possible: the DOA cannot route it (DOA_NOT_CONFIGURED, APPROVER_NOT_FOUND, …), or the damaged
   * goods lie beyond what is still to come (BEYOND_ORDER) and go back
   */
  | { readonly kind: 'BLOCKED'; readonly code: string }

interface VarianceAsk {
  readonly key: string
  readonly amountSatang: Satang
  /** The department of the PO line's budget, which pays (BR-DOA-05) */
  readonly departmentId: string
}

/** The GR_VARIANCE approver of each variance, as routeVariance of the receiving service would route it (ADR-038 ข้อ 7) */
async function varianceApprovers(ctx: Ctx, tx: TenantTx, asks: readonly VarianceAsk[], vatRateBp: number | null, actor: string): Promise<Map<string, ApproverPreviewDto>> {
  const out = new Map<string, ApproverPreviewDto>()
  if (asks.length === 0) return out
  const policy = await loadRoutePolicy(tx)
  const resolved = asks.map((a) => ({
    key: a.key,
    route: resolveRoute(
      {
        documentType: 'GR_VARIANCE',
        amount: { netSatang: a.amountSatang, vatSatang: vatFromNet(a.amountSatang, vatRateBp ?? 0).vat },
        requesterMemberId: actor,
        chargedDepartmentId: a.departmentId,
        conflictMemberIds: [actor],
        at: ctx.now,
      },
      policy,
    ),
  }))
  const db = forTenant(ctx.organizationId)
  const firstSteps = resolved.flatMap((r) => (r.route.ok && r.route.data.steps[0] ? [r.route.data.steps[0]] : []))
  const [people, roleOf] = await Promise.all([membersById(db, firstSteps.flatMap((s) => [s.assigneeMemberId, s.principalMemberId])), approverRoles(db)])
  for (const r of resolved) {
    if (!r.route.ok) {
      out.set(r.key, { kind: 'BLOCKED', code: r.route.error.code })
      continue
    }
    const step = r.route.data.steps[0]
    if (!step) {
      out.set(r.key, { kind: 'BLOCKED', code: 'APPROVER_NOT_FOUND' })
      continue
    }
    out.set(r.key, {
      kind: 'ROUTE',
      ruleCode: r.route.data.ruleCode,
      assignee: people.get(step.assigneeMemberId) ?? null,
      actingFor: step.principalMemberId ? (people.get(step.principalMemberId) ?? null) : null,
      role: roleOf(step.resolvedFrom),
    })
  }
  return out
}

// ---------- the list (/receiving) ----------

export interface ReceivingListDto {
  /** The member receives goods at all: a RECEIVER, or any member while the DOA lets requesters receive (OQ-04) */
  readonly receives: boolean
  /** POs of this page the member may receive now, oldest sent first */
  readonly rows: readonly ReceivingCandidateDto[]
  /** POs of this page the member would receive but separation of duties refuses (BR-SOD-02, BR-SOD-07) */
  readonly blocked: ReadonlyArray<ReceivingCandidateDto & { readonly rule: SodRule }>
  /** Page shown (from 1), of how many; `total` POs on all pages, those refused by separation of duties included */
  readonly page: number
  readonly pageCount: number
  readonly pageSize: number
  readonly total: number
}

export async function listReceivable(ctx: Ctx, input: { readonly page?: number } = {}): Promise<Result<ReceivingListDto>> {
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!memberId) return err('FORBIDDEN', 'only a member receives goods')
  const { principal, sodPolicy } = await principalAndPolicy(ctx)
  if (principal.kind !== 'member') return err('FORBIDDEN', 'only an active member receives goods')
  if (!receivesAtAll(principal, sodPolicy)) return ok({ receives: false, rows: [], blocked: [], page: 1, pageCount: 1, pageSize: RECEIVING_PAGE_SIZE, total: 0 })
  // Narrow the read to what a grant of gr.post can cover: the departments of a DEPT grant, and the member's own requests
  // while the DOA in effect lets requesters receive (OQ-04); the decision is still made per PO below
  const scopes = scopesFor(principal, 'gr.post')
  const filter = {
    departmentIds: scopes.has('DEPT') ? [...principal.departmentIds] : [],
    requesterMemberId: scopes.has('OWN') && sodPolicy.requesterMayReceive ? memberId : null,
  }
  let page = input.page && Number.isInteger(input.page) && input.page > 0 ? input.page : 1
  let candidates = await listReceivingCandidates(ctx, { ...filter, page })
  const pageCount = Math.max(1, Math.ceil(candidates.total / RECEIVING_PAGE_SIZE))
  if (page > pageCount) {
    // A page past the end (the list shrank since the link was made): the last page instead
    page = pageCount
    candidates = await listReceivingCandidates(ctx, { ...filter, page })
  }
  const rows: ReceivingCandidateDto[] = []
  const blocked: Array<ReceivingCandidateDto & { rule: SodRule }> = []
  for (const c of candidates.rows) {
    const decision = receivingDecision(principal, sodPolicy, c.parties)
    if (decision.kind === 'RECEIVE') rows.push(c)
    else if (decision.kind === 'SOD') blocked.push({ ...c, rule: decision.rule })
  }
  return ok({ receives: true, rows, blocked, page, pageCount, pageSize: RECEIVING_PAGE_SIZE, total: candidates.total })
}

// ---------- one PO (/receiving/[poId]) ----------

export type VarianceView = Omit<VarianceDto, 'amountSatang'> & { readonly amountSatang: bigint | null }
export type ReceivingLineView = Omit<ReceivingLineDto, 'unitPriceSatang' | 'budgetDepartmentId'> & { readonly unitPriceSatang: bigint | null }
export type ReceiptView = Omit<ReceiptDto, 'variances'> & { readonly variances: readonly VarianceView[] }

export interface CloseShortPlanDto {
  /** The lines that will be given up, with what never came; the amount goes back once approved (BR-GR-04) */
  readonly lines: ReadonlyArray<{ readonly poLineId: string; readonly description: string; readonly uom: string; readonly quantity: string; readonly amountSatang: Satang }>
  readonly totalSatang: Satang
  /** One approver per line in the order of the lines; usually the same person */
  readonly approvers: readonly ApproverPreviewDto[]
}

export interface ReceivingViewDto {
  readonly po: Omit<ReceivingPoDto, 'lines' | 'receipts' | 'closeShort' | 'parties'> & {
    readonly lines: readonly ReceivingLineView[]
    readonly receipts: readonly ReceiptView[]
    readonly closeShort: readonly VarianceView[]
  }
  readonly decision: ReceivingDecision
  /** The PO takes goods now and the member may post them */
  readonly receivable: boolean
  /** po.view on this PO (§2.4): amounts are shown; otherwise they are left out */
  readonly showAmounts: boolean
  /** po.close: the member closes POs (PROCUREMENT), whatever this PO's state */
  readonly closesPo: boolean
  /** po.close: PROCUREMENT may ask to close the PO short now */
  readonly canCloseShort: boolean
  /** A close-short waits for its approver */
  readonly closeShortPending: boolean
  /** Nothing can be closed short yet: what is not in is damaged goods waiting to be kept or not */
  readonly closeShortWaitsForDamaged: boolean
  readonly closeShortPlan: CloseShortPlanDto | null
  /** settings.receiving.overTolerancePct (OQ-20) */
  readonly tolerancePct: number
}

async function tolerancePctOf(tx: TenantTx, organizationId: string): Promise<number> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  return OrgSettingsSchema.shape.receiving.parse((org.settings as { receiving?: unknown } | null)?.receiving).overTolerancePct
}

export async function getReceivingView(ctx: Ctx, poId: string): Promise<Result<ReceivingViewDto>> {
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!memberId) return err('FORBIDDEN', 'only a member opens a receiving page')
  const po = await getReceivingPo(ctx, poId)
  if (!po) return err('NOT_FOUND', 'purchase order not found')
  const db = forTenant(ctx.organizationId)
  const loaded = await db.$transaction(async (tx) => ({
    principal: await loadPrincipal(tx, ctx),
    sodPolicy: await effectiveSodPolicy(tx, ctx.now),
    facts: await poViewFacts(tx, po.id),
    tolerancePct: await tolerancePctOf(tx, ctx.organizationId),
  }))
  const { principal, sodPolicy, facts } = loaded
  const decision = receivingDecision(principal, sodPolicy, po.parties)
  const showAmounts = viewsPo(principal, facts)
  // gr.post opens the page of a PO once it went to the supplier: before that a receiver has nothing to receive on it
  const wentToSupplier = po.sentAt !== null || (WENT_OUT as readonly string[]).includes(po.status)
  const mayReceiveIt = decision.kind !== 'NONE' && wentToSupplier
  if (!showAmounts && !mayReceiveIt) return err('FORBIDDEN', 'no access to this purchase order')

  const open = takesGoods(po.status)
  const closeShortPending = po.closeShort.some((v) => v.status === 'PENDING_APPROVAL')
  const closesPo = isAllowed(principal, 'po.close')
  // What closing short would give up now: what is still to come, damaged goods waiting to be kept left out (./standing.ts)
  const notIn = po.lines.filter((l) => scaled(l.outstanding) > 0n)
  const shortLines = notIn.map((l) => ({ line: l, short: shortNow(standingOfLine(l), l.unitPriceSatang) })).filter((s) => s.short.quantity > 0n)
  const asksCloseShort = open && closesPo && !closeShortPending
  const canCloseShort = asksCloseShort && shortLines.length > 0

  let closeShortPlan: CloseShortPlanDto | null = null
  if (canCloseShort) {
    const lines = shortLines.map(({ line, short }) => ({ poLineId: line.id, description: line.description, uom: line.uom, quantity: formatQuantity(short.quantity), amountSatang: short.amountSatang, departmentId: line.budgetDepartmentId }))
    const approvers = await db.$transaction((tx) => varianceApprovers(ctx, tx, lines.map((l) => ({ key: l.poLineId, amountSatang: l.amountSatang, departmentId: l.departmentId })), po.vatRateBp, memberId))
    closeShortPlan = {
      lines: lines.map(({ departmentId: _d, ...l }) => l),
      totalSatang: lines.reduce((sum, l) => sum + l.amountSatang, 0n),
      approvers: lines.map((l) => approvers.get(l.poLineId) ?? { kind: 'BLOCKED', code: 'APPROVER_NOT_FOUND' }),
    }
  }

  const variance = (v: VarianceDto): VarianceView => ({ ...v, amountSatang: showAmounts ? v.amountSatang : null })
  const { parties: _parties, ...rest } = po
  return ok({
    po: {
      ...rest,
      lines: po.lines.map(({ budgetDepartmentId: _b, ...l }) => ({ ...l, unitPriceSatang: showAmounts ? l.unitPriceSatang : null })),
      receipts: po.receipts.map((r) => ({ ...r, variances: r.variances.map(variance) })),
      closeShort: po.closeShort.map(variance),
    },
    decision,
    receivable: open && decision.kind === 'RECEIVE',
    showAmounts,
    closesPo,
    canCloseShort,
    closeShortPending,
    closeShortWaitsForDamaged: asksCloseShort && notIn.length > 0 && shortLines.length === 0,
    closeShortPlan,
    tolerancePct: loaded.tolerancePct,
  })
}

// ---------- what a receipt will do, before it is posted (§9.9 principle 3) ----------

export const PreviewInput = z.strictObject({
  poId: z.uuid(),
  /** Photos the receiver uploaded; damaged goods need one (BR-GR-05) */
  photoFileIds: z.array(z.uuid()).max(MAX_PHOTOS).default([]),
  lines: z
    .array(
      z.strictObject({
        poLineId: z.uuid(),
        received: Quantity,
        rejected: Quantity.default('0'),
        /** The rejected goods are damaged (a DAMAGED variance); otherwise they are refused for another reason */
        damaged: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200),
})

export interface ApproverChoiceDto {
  readonly quantity: string
  readonly amountSatang: Satang | null
  /** Who approves when the receiver keeps it */
  readonly keepApprover: ApproverPreviewDto
}

export interface ReceiptPreviewLineDto {
  readonly poLineId: string
  readonly description: string
  readonly uom: string
  readonly received: string
  readonly rejected: string
  /** Accepted by this receipt now (what waits for an approval or goes back is not in it) */
  readonly accepted: string
  /** Not in after this receipt (damaged goods waiting to be kept included) */
  readonly outstandingAfter: string
  /** Kept beyond the order within the tolerance, and held at once (BR-GR-02) */
  readonly withinTolerance: string | null
  readonly holdSatang: Satang | null
  /** Beyond what is still on order and the tolerance: goes back (RETURN_EXCESS) or waits for approval (ACCEPT_EXCESS) */
  readonly excess: ApproverChoiceDto | null
  /** Damaged: replaced by the supplier (RETURN_REPLACE) or kept once approved (ACCEPT_DAMAGED) — the receiver chooses */
  readonly damaged: ApproverChoiceDto | null
}

export interface ReceiptPreviewDto {
  readonly poStatusAfter: 'PARTIALLY_RECEIVED' | 'RECEIVED'
  /** Lines of the PO with something not in after this receipt */
  readonly linesOutstandingAfter: number
  readonly tolerancePct: number
  readonly showAmounts: boolean
  readonly lines: readonly ReceiptPreviewLineDto[]
}

const invalid = (field: string, reason: string, extra: Record<string, unknown> = {}) => err('VALIDATION_FAILED', 'the receipt cannot be posted like this', { field, reason, ...extra })
const SOD_BLOCKED = Symbol('SOD_BLOCKED')

/**
 * Calculates a receipt as gr.post would, without writing anything; posting checks and calculates again under lock. A
 * member refused by separation of duties is answered as gr.post answers, and the refusal is recorded once per attempt
 * (FR-DOA-007 AC2) through the check-only command of the receiving service, with `options.idempotencyKey` from the form.
 */
export async function previewGoodsReceipt(ctx: Ctx, rawInput: unknown, options: RunOptions): Promise<Result<ReceiptPreviewDto>> {
  const parsed = PreviewInput.safeParse(rawInput)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return invalid(issue?.path.join('.') || '(input)', 'QUANTITY')
  }
  const input = parsed.data
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!memberId) return err('FORBIDDEN', 'only a member receives goods')
  const po = await getReceivingPo(ctx, input.poId)
  if (!po) return err('NOT_FOUND', 'purchase order not found')

  const db = forTenant(ctx.organizationId)
  const outcome = await db.$transaction(async (tx): Promise<Result<ReceiptPreviewDto> | typeof SOD_BLOCKED> => {
    const principal = await loadPrincipal(tx, ctx)
    const decision = receivingDecision(principal, await effectiveSodPolicy(tx, ctx.now), po.parties)
    if (decision.kind === 'NONE') return err('FORBIDDEN', 'missing capability gr.post', { capability: 'gr.post' })
    if (decision.kind === 'SOD') return SOD_BLOCKED
    if (!takesGoods(po.status)) return err('INVALID_STATE_TRANSITION', `gr.post is not allowed when the purchase order is ${po.status}`, { from: po.status, command: 'gr.post' })
    const tolerancePct = await tolerancePctOf(tx, ctx.organizationId)
    if (!Number.isInteger(tolerancePct)) return invalid('tolerance', 'TOLERANCE')
    if (new Set(input.lines.map((l) => l.poLineId)).size !== input.lines.length) return invalid('lines', 'DUPLICATE_LINE')
    if (!(await photosUsable(tx, memberId, input.photoFileIds))) return invalid('photoFileIds', 'FILE')

    const lines: ReceiptPreviewLineDto[] = []
    const asks: VarianceAsk[] = []
    const beyondOrder = new Set<string>()
    const after = new Map(po.lines.map((l) => [l.id, scaled(l.received)]))
    for (const [i, l] of input.lines.entries()) {
      const line = po.lines.find((x) => x.id === l.poLineId)
      if (!line) return invalid(`lines.${i}.poLineId`, 'LINE')
      const received = scaled(l.received)
      const rejected = scaled(l.rejected)
      if (received <= 0n || rejected > received) return invalid(`lines.${i}.received`, 'QUANTITY')
      if (rejected > 0n && l.damaged && input.photoFileIds.length === 0) return invalid('photoFileIds', 'PHOTO_REQUIRED')
      const standing = standingOfLine(line)
      const increment = receiveOnLine(standing, { unitPriceSatang: line.unitPriceSatang, received: received - rejected, tolerancePct })
      const receivedAfter = standing.received + increment.accepted
      after.set(line.id, receivedAfter)
      const left = standing.ordered - receivedAfter - standing.cancelled
      if (increment.over) asks.push({ key: `${line.id}:excess`, amountSatang: increment.over.amountSatang, departmentId: line.budgetDepartmentId })
      // The amount the command gives a DAMAGED variance: what was rejected × the PO price, rounded once
      const damagedSatang = rejected > 0n && l.damaged ? lineNet(formatQuantity(rejected), line.unitPriceSatang) : null
      if (damagedSatang !== null) {
        // Kept damaged goods fill what is still to come; beyond it they go back (gr.post refuses DAMAGED_BEYOND_ORDER)
        if (rejected > stillToCome({ ...standing, received: receivedAfter })) beyondOrder.add(line.id)
        else asks.push({ key: `${line.id}:damaged`, amountSatang: damagedSatang, departmentId: line.budgetDepartmentId })
      }
      lines.push({
        poLineId: line.id,
        description: line.description,
        uom: line.uom,
        received: formatQuantity(received),
        rejected: formatQuantity(rejected),
        accepted: formatQuantity(increment.accepted),
        outstandingAfter: formatQuantity(left > 0n ? left : 0n),
        withinTolerance: increment.withinTolerance > 0n ? formatQuantity(increment.withinTolerance) : null,
        holdSatang: increment.holdSatang > 0n ? increment.holdSatang : null,
        excess: increment.over ? { quantity: formatQuantity(increment.over.quantity), amountSatang: increment.over.amountSatang, keepApprover: { kind: 'BLOCKED', code: 'PENDING' } } : null,
        damaged: damagedSatang !== null ? { quantity: formatQuantity(rejected), amountSatang: damagedSatang, keepApprover: { kind: 'BLOCKED', code: 'PENDING' } } : null,
      })
    }

    const approvers = await varianceApprovers(ctx, tx, asks, po.vatRateBp, memberId)
    const showAmounts = viewsPo(principal, await poViewFacts(tx, po.id))
    const amount = (satang: Satang | null) => (showAmounts ? satang : null)
    const damagedApprover = (poLineId: string, fallback: ApproverPreviewDto): ApproverPreviewDto =>
      beyondOrder.has(poLineId) ? { kind: 'BLOCKED', code: 'BEYOND_ORDER' } : (approvers.get(`${poLineId}:damaged`) ?? fallback)
    const withApprovers = lines.map((l) => ({
      ...l,
      holdSatang: amount(l.holdSatang),
      excess: l.excess ? { ...l.excess, amountSatang: amount(l.excess.amountSatang), keepApprover: approvers.get(`${l.poLineId}:excess`) ?? l.excess.keepApprover } : null,
      damaged: l.damaged ? { ...l.damaged, amountSatang: amount(l.damaged.amountSatang), keepApprover: damagedApprover(l.poLineId, l.damaged.keepApprover) } : null,
    }))
    // The PO after this receipt: every line in, or given up, → RECEIVED (statusAfterReceipt of the command)
    const outstandingAfter = po.lines.filter((l) => after.get(l.id)! + scaled(l.cancelled) < scaled(l.ordered)).length
    return ok({ poStatusAfter: outstandingAfter ? 'PARTIALLY_RECEIVED' : 'RECEIVED', linesOutstandingAfter: outstandingAfter, tolerancePct, showAmounts, lines: withApprovers })
  })
  if (outcome !== SOD_BLOCKED) return outcome
  // FR-DOA-007 AC2: recorded once per attempt, and answered as gr.post answers it
  const recorded = await recordGrPreviewSodBlock(ctx, po.id, options)
  return recorded.ok ? err('INTERNAL', 'the separation-of-duties refusal was not recorded', { requestId: ctx.requestId }) : { ok: false, error: recorded.error }
}
