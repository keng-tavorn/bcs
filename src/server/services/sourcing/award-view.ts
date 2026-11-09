import { resolveRoute } from '@/core/doa'
import { satangToAmount } from '@/core/money/dto'
import { vatFromNet } from '@/core/money/math'
import type { Result } from '@/core/result'
import type { AwardReasonCode } from '@/core/sourcing'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadRoutePolicy } from '@/server/doa/policy'
import { departmentsOf, isUuid, membersById, type DepartmentRefDto, type MemberRefDto } from '@/server/queries/requests'
import { requireModule } from '../modules'
import { rfxReading } from './access'
import { awardPeople, conflictsOf, planAward, snapshotOf, type AwardPlan, type AwardSnapshot } from './awards'
import { comparisonOf, type RfxComparison } from './comparison'

// What an award shows (S10-10 · BR-RFX-12 · FR-SRC-204 AC3): the facts its approver decides on — on /tasks/[id], the
// LIFF task and the award page — and the award page of procurement with the comparison to pick the winners from and
// the route the award would take now (previewRoute). A draft's facts are worked out live (planAward); a sent award's
// come from the snapshot frozen at award.submit, so the approver sees what was sent. Amounts in baht text; an
// individual supplier is named by its code only (BR-AI-32 · as the comparison's facts).

export interface AwardFactsDto {
  readonly awardDecisionId: string
  readonly number: string | null
  readonly status: string
  readonly poStatus: string
  readonly rfx: { readonly id: string; readonly number: string | null; readonly title: string; readonly kind: string }
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly isSplit: boolean
  readonly reason: string | null
  readonly reasonCodes: readonly AwardReasonCode[]
  /** Σ approved by the source requests for the awarded quantity; null for a need */
  readonly sourceApprovedNet: string | null
  /** How much the award is above that (ABOVE_REQUEST); null when not above */
  readonly aboveRequestBy: string | null
  /** The comparison in short: every bid's amount before VAT, its rank and total when scored, the winners marked */
  readonly bids: ReadonlyArray<{ readonly supplierCode: string; readonly supplierName: string | null; readonly net: string; readonly rank: number | null; readonly totalBp: number | null; readonly lowest: boolean; readonly partial: boolean; readonly winner: boolean; readonly tags: readonly string[] }>
  readonly winners: ReadonlyArray<{
    readonly supplierCode: string
    readonly supplierName: string | null
    readonly net: string
    readonly vat: string
    readonly lineCount: number
    readonly foreign: boolean
    readonly vatRegistered: boolean
    readonly priceIncludesVat: boolean
    readonly registryFlag: string
    readonly requiredDocumentsOk: boolean
    readonly bidExpired: boolean
    readonly validUntil: string | null
    readonly risk: { readonly tier: string | null; readonly cleared: boolean } | null
  }>
  readonly priceFlags: ReadonlyArray<{ readonly lineNo: number; readonly supplierCode: string; readonly flag: string; readonly deviationBp: number | null }>
  readonly invited: number
  readonly submitted: number
  readonly evaluatorsAddedAfterClose: readonly MemberRefDto[]
  readonly requestingDepartment: DepartmentRefDto | null
  readonly sourceDepartments: readonly DepartmentRefDto[]
}

const amount = (v: bigint | null) => (v === null ? null : satangToAmount(v))

type UnnamedFacts = Omit<AwardFactsDto, 'evaluatorsAddedAfterClose' | 'requestingDepartment' | 'sourceDepartments'>
interface Facts {
  readonly facts: UnnamedFacts
  /** Named outside the transaction */
  readonly evaluatorIds: readonly string[]
  readonly requestingDepartmentId: string
  readonly sourceDepartmentIds: readonly string[]
}

/** The facts of an award as a DTO: from its snapshot once sent, from the plan while a draft */
async function factsOf(tx: TenantTx, ctx: Ctx, awardDecisionId: string): Promise<Facts | null> {
  const award = await tx.awardDecision.findFirst({
    where: { id: awardDecisionId },
    include: {
      rfxEvent: { select: { id: true, number: true, title: true, kind: true, scorecardId: true, sourceKind: true, requestingDepartmentId: true, sourceDepartmentIds: true } },
      lines: { select: { rfxLineId: true, bidId: true, supplierId: true, lineNetSatang: true, vatRateBp: true, rfxLine: { select: { lineNo: true } } } },
    },
  })
  if (!award) return null
  // a draft or a returned award is worked out live (its lines may have changed since a send); a sent one shows what was sent
  let snapshot: AwardSnapshot | null = award.status === 'DRAFT' || award.status === 'RETURNED' ? null : snapshotOf(award.rankingSnapshot)
  let plan: AwardPlan | null = null
  if (award.status === 'DRAFT' || award.status === 'RETURNED') {
    const planned = await planAward(tx, ctx, award.rfxEvent, award.lines, 'award.view')
    if ('lines' in planned) {
      plan = planned
      snapshot = planned.snapshot
    }
  }
  const supplierIds = [...new Set([...award.lines.map((l) => l.supplierId), ...(snapshot?.bids.map((b) => b.supplierId) ?? [])])]
  const suppliers = new Map((await tx.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, nameTh: true, payeeType: true } })).map((s) => [s.id, s]))
  const nameOf = (id: string) => {
    const s = suppliers.get(id)
    return s && s.payeeType !== 'INDIVIDUAL' ? s.nameTh : null
  }
  const codeOf = (id: string) => suppliers.get(id)?.code ?? '-'
  const winningBids = new Set(award.lines.map((l) => l.bidId))
  const perSupplier = new Map<string, { net: bigint; rate: number; lines: number }>()
  for (const l of award.lines) {
    const s = perSupplier.get(l.supplierId) ?? { net: 0n, rate: l.vatRateBp, lines: 0 }
    perSupplier.set(l.supplierId, { net: s.net + l.lineNetSatang, rate: s.rate, lines: s.lines + 1 })
  }
  const lineNoOf = new Map(award.lines.map((l) => [l.rfxLineId, l.rfxLine.lineNo]))
  const net = plan?.netSatang ?? award.netSatang
  const approved = plan ? plan.sourceApprovedNetSatang : award.sourceApprovedNetSatang
  const supplierOfBid = new Map((snapshot?.bids ?? []).map((b) => [b.bidId, b.supplierId]))
  const facts: UnnamedFacts = {
    awardDecisionId: award.id,
    number: award.number,
    status: award.status,
    // the column is set at the approval (award_decision_shape); before it, a winner who quoted with VAT means PENDING_PRICE
    poStatus: award.status === 'APPROVED' ? award.poStatus : plan ? (plan.pendingPrice ? 'PENDING_PRICE' : 'NOT_APPLICABLE') : snapshot?.winners.some((w) => w.priceIncludesVat) ? 'PENDING_PRICE' : 'NOT_APPLICABLE',
    rfx: { id: award.rfxEvent.id, number: award.rfxEvent.number, title: award.rfxEvent.title, kind: award.rfxEvent.kind },
    net: satangToAmount(net),
    vat: satangToAmount(plan?.vatSatang ?? award.vatSatang),
    gross: satangToAmount(plan?.grossSatang ?? award.grossSatang),
    isSplit: plan?.isSplit ?? award.isSplit,
    reason: award.reason,
    reasonCodes: (plan?.reasonCodes ?? award.reasonCodes) as AwardReasonCode[],
    sourceApprovedNet: amount(approved),
    aboveRequestBy: approved !== null && net > approved ? satangToAmount(net - approved) : null,
    bids: (snapshot?.bids ?? []).map((b) => ({ supplierCode: codeOf(b.supplierId), supplierName: nameOf(b.supplierId), net: b.net, rank: b.rank, totalBp: b.totalBp, lowest: b.lowest, partial: b.partial, winner: winningBids.has(b.bidId), tags: b.tags })),
    winners: (snapshot?.winners ?? []).map((w) => {
      const s = perSupplier.get(w.supplierId)
      const supplierNet = s?.net ?? 0n
      // VAT once per supplier on its own lines (BR-RFX-12)
      const vat = s ? vatFromNet(supplierNet, s.rate).vat : 0n
      return {
        supplierCode: codeOf(w.supplierId),
        supplierName: nameOf(w.supplierId),
        net: satangToAmount(supplierNet),
        vat: satangToAmount(vat),
        lineCount: s?.lines ?? 0,
        foreign: w.foreign,
        vatRegistered: w.vatRegistered,
        priceIncludesVat: w.priceIncludesVat,
        registryFlag: w.registryFlag,
        requiredDocumentsOk: w.requiredDocumentsOk,
        bidExpired: w.bidExpired,
        validUntil: w.validUntil,
        risk: w.risk ? { tier: w.risk.tier, cleared: w.risk.cleared } : null,
      }
    }),
    priceFlags: (snapshot?.priceFlags ?? []).map((f) => ({ lineNo: lineNoOf.get(f.rfxLineId) ?? 0, supplierCode: codeOf(supplierOfBid.get(f.bidId) ?? ''), flag: f.flag, deviationBp: f.deviationBp })),
    invited: snapshot?.invited ?? 0,
    submitted: snapshot?.submitted ?? 0,
  }
  return { facts, evaluatorIds: snapshot?.evaluatorsAddedAfterClose ?? [], requestingDepartmentId: award.rfxEvent.requestingDepartmentId, sourceDepartmentIds: award.rfxEvent.sourceDepartmentIds }
}

/** Fills in the names of the evaluators added after the close and of the departments */
async function named(ctx: Ctx, read: Facts): Promise<AwardFactsDto> {
  const db = forTenant(ctx.organizationId)
  const [members, departments] = await Promise.all([membersById(db, read.evaluatorIds), departmentsOf(db)])
  return {
    ...read.facts,
    evaluatorsAddedAfterClose: read.evaluatorIds.map((m) => members.get(m)).filter((m): m is MemberRefDto => !!m),
    requestingDepartment: departments.byId.get(read.requestingDepartmentId) ?? null,
    sourceDepartments: read.sourceDepartmentIds.map((d) => departments.byId.get(d)).filter((d): d is DepartmentRefDto => !!d),
  }
}

/**
 * What the approver of an award decides on (subject AWARD_DECISION). The page that shows it has already checked the
 * task is the reader's (getTaskAccess), as for every subject.
 */
export async function getAwardTaskView(ctx: Ctx, awardDecisionId: string): Promise<AwardFactsDto | null> {
  if (!isUuid(awardDecisionId)) return null
  const facts = await forTenant(ctx.organizationId).$transaction((tx) => factsOf(tx, ctx, awardDecisionId))
  return facts ? named(ctx, facts) : null
}

export type AwardRoutePreview =
  | { readonly kind: 'ROUTE'; readonly ruleCode: string; readonly escalatedFromRuleCode: string | null; readonly doa: { readonly code: string; readonly versionNo: number }; readonly approvers: readonly MemberRefDto[] }
  | { readonly kind: 'BLOCKED'; readonly code: string }

export interface AwardWorkspaceDto {
  readonly comparison: RfxComparison
  readonly rfx: { readonly id: string; readonly number: string | null; readonly title: string; readonly kind: string; readonly status: string; readonly scored: boolean; readonly revealed: boolean }
  /** The award of the RFx that is open or approved; null when none is (none made, or the last rejected or cancelled) */
  readonly award: {
    readonly id: string
    readonly version: number
    readonly status: string
    readonly reason: string | null
    readonly contractRef: string | null
    readonly lines: ReadonlyArray<{ readonly rfxLineId: string; readonly bidId: string }>
  } | null
  readonly facts: AwardFactsDto | null
  /** The route the award would take if sent now (a draft or a returned award of a member who may send it) */
  readonly route: AwardRoutePreview | null
  /** The reader may make, change, send and cancel awards (sourcing.award) */
  readonly canAward: boolean
  /**
   * S10-11: what the approved award made — its draft POs, the number of agreed prices of a need, and while a winner who
   * bid with VAT has not confirmed its prices before VAT (PENDING_PRICE · OQ-212) which winners did; null before approval
   */
  readonly after: {
    readonly poStatus: string
    readonly purchaseOrders: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly status: string; readonly supplierName: string; readonly gross: string }>
    readonly priceAgreements: number
    readonly winnersToConfirm: ReadonlyArray<{ readonly supplierName: string; readonly confirmed: boolean }>
  } | null
}

/** S10-11: what an approved award made, for its page */
async function afterOf(tx: TenantTx, award: { readonly id: string; readonly poStatus: string; readonly priceAgreementIds: unknown }): Promise<NonNullable<AwardWorkspaceDto['after']>> {
  const pos = await tx.purchaseOrder.findMany({ where: { awardDecisionId: award.id }, orderBy: [{ grossSatang: 'desc' }, { id: 'asc' }], select: { id: true, number: true, status: true, grossSatang: true, supplier: { select: { nameTh: true } } } })
  const vatIncluded = await tx.bid.findMany({ where: { priceIncludesVat: true, awardLines: { some: { awardDecisionId: award.id } } }, orderBy: { id: 'asc' }, select: { netPricesConfirmedAt: true, supplier: { select: { nameTh: true } } } })
  return {
    poStatus: award.poStatus,
    purchaseOrders: pos.map((p) => ({ id: p.id, number: p.number, status: p.status, supplierName: p.supplier.nameTh, gross: satangToAmount(p.grossSatang) })),
    priceAgreements: Array.isArray(award.priceAgreementIds) ? award.priceAgreementIds.length : 0,
    winnersToConfirm: award.poStatus === 'PENDING_PRICE' ? vatIncluded.map((b) => ({ supplierName: b.supplier.nameTh, confirmed: b.netPricesConfirmedAt !== null })) : [],
  }
}

/** The award page of an RFx: for a reader of its prices (rfxReading PRICES) */
export async function awardWorkspace(ctx: Ctx, rfxEventId: string): Promise<Result<AwardWorkspaceDto>> {
  if (!isUuid(rfxEventId)) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
  const loaded = await forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<Omit<AwardWorkspaceDto, 'facts'> & { facts: Facts | null; approverIds: string[] }>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, number: true, title: true, kind: true, status: true, scorecardId: true, sourceKind: true, requestingDepartmentId: true } })
    if (!rfx) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
    const may = await rfxReading(tx, ctx, rfxEventId)
    if (!may.ok) return may
    if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its prices', details: { reason: 'PRICES' } } }
    const comparison = await comparisonOf(tx, ctx.organizationId, rfxEventId, ctx.now)
    if (!comparison) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
    const card = rfx.scorecardId ? await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, select: { status: true } }) : null
    const canAward = (await authorize(tx, ctx, 'sourcing.award')).ok
    // the one open or approved award of the RFx (award_decision_one_open); after a rejection or a cancel a new one is made
    const award = await tx.awardDecision.findFirst({ where: { rfxEventId, status: { notIn: ['REJECTED', 'CANCELLED'] } }, include: { lines: { select: { rfxLineId: true, bidId: true } } } })
    const facts = award ? await factsOf(tx, ctx, award.id) : null
    const after = award?.status === 'APPROVED' ? await afterOf(tx, award) : null
    let route: AwardRoutePreview | null = null
    let approverIds: string[] = []
    const member = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (award && canAward && member && (award.status === 'DRAFT' || award.status === 'RETURNED')) {
      const plan = await planAward(tx, ctx, rfx, award.lines, 'award.view')
      if ('lines' in plan) {
        const resolved = resolveRoute(
          { documentType: 'RFX_AWARD', amount: { netSatang: plan.netSatang, vatSatang: plan.vatSatang }, requesterMemberId: member, chargedDepartmentId: rfx.requestingDepartmentId, conflictMemberIds: conflictsOf(member, await awardPeople(tx, rfx.id)), at: ctx.now },
          await loadRoutePolicy(tx),
        )
        if (resolved.ok) {
          approverIds = resolved.data.steps.map((s) => s.assigneeMemberId)
          route = { kind: 'ROUTE', ruleCode: resolved.data.ruleCode, escalatedFromRuleCode: resolved.data.escalatedFromRuleCode, doa: { code: resolved.data.doaCode, versionNo: resolved.data.versionNo }, approvers: [] }
        } else route = { kind: 'BLOCKED', code: resolved.error.code }
      } else route = { kind: 'BLOCKED', code: plan.error.code }
    }
    return {
      ok: true,
      data: {
        comparison,
        rfx: { id: rfx.id, number: rfx.number, title: rfx.title, kind: rfx.kind, status: rfx.status, scored: rfx.scorecardId !== null, revealed: card?.status === 'REVEALED' },
        award: award ? { id: award.id, version: award.version, status: award.status, reason: award.reason, contractRef: award.contractRef, lines: award.lines } : null,
        facts,
        route,
        approverIds,
        canAward,
        after,
      },
    }
  })
  if (!loaded.ok) return loaded
  const { approverIds, ...data } = loaded.data
  const approvers = await membersById(forTenant(ctx.organizationId), approverIds)
  return {
    ok: true,
    data: {
      ...data,
      facts: data.facts ? await named(ctx, data.facts) : null,
      route: data.route?.kind === 'ROUTE' ? { ...data.route, approvers: approverIds.map((id) => approvers.get(id)).filter((m): m is MemberRefDto => !!m) } : data.route,
    },
  }
}
