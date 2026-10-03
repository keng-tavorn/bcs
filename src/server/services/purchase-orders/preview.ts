import { bandOf, resolveRoute, versionAt } from '@/core/doa'
import { documentTotals, type Satang } from '@/core/money/math'
import { err, ok, type AppError, type Result } from '@/core/result'
import { rateFor, taxDateOf } from '@/core/vat'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant } from '@/server/db/tenant'
import { loadRoutePolicy } from '@/server/doa/policy'
import { approverRoles, isUuid, membersById, type ApproverRoleDto, type DoaRefDto, type MemberRefDto } from '@/server/queries/requests'

// What PROCUREMENT sees before pressing "ส่งขออนุมัติ" on a draft PO (spec §9.9 principle 3, FR-P2P-004 AC1, BR-BUD-05):
// the totals with today's VAT rate (the rate the PO takes when it is sent, §6.4), the route the DOA engine expects for
// a PURCHASE_ORDER of that amount — with the same input submitPo gives it: the sender as the PO's creator, the requesters
// of its PRs as conflicts (BR-SOD-01, BR-SOD-03), the department of its first budget line — and what the PO reserves on
// top of what its requests reserve when its lines cost more than their share of the requests. Nothing is written; the
// submit does it all again under lock and may still refuse (an empty budget line, an approver who left).

export type PoRoutePreviewDto =
  | {
      readonly kind: 'ROUTE'
      readonly doa: Omit<DoaRefDto, 'versionId'> & { readonly versionId: string }
      readonly escalatedFromRuleCode: string | null
      readonly amountBasis: 'GROSS' | 'NET'
      readonly basisSatang: Satang | null
      /** The amount band of the rule the amount fell into: (lower, upper] in satang, for the sentence in English */
      readonly band: { readonly lowerSatang: Satang | null; readonly upperSatang: Satang | null } | null
      /** The engine's Thai explanation, kept with the route at submit (BR-DOA-10) */
      readonly explanationTh: string
      readonly steps: ReadonlyArray<{ readonly stepNo: number; readonly approver: MemberRefDto | null; readonly onBehalfOf: MemberRefDto | null; readonly role: ApproverRoleDto }>
    }
  /** The engine refuses (DOA_NOT_CONFIGURED, APPROVER_NOT_FOUND, NO_HIGHER_AUTHORITY, TAX_RATE_NOT_CONFIGURED …) */
  | { readonly kind: 'BLOCKED'; readonly code: string; readonly ruleCode: string | null }

export interface PoSubmitPreviewDto {
  readonly totals: { readonly netSatang: Satang; readonly vatSatang: Satang; readonly grossSatang: Satang; readonly vatRateBp: number } | null
  readonly route: PoRoutePreviewDto
  /** BR-BUD-05: reserved for the PO at submit, Σ over its lines of max(0, line amount − what its sources give back) */
  readonly extraReserveSatang: Satang
  /** §6.4: only an active supplier's PO is sent for approval */
  readonly supplierActive: boolean
}

export async function previewPoSubmit(ctx: Ctx, poId: string): Promise<Result<PoSubmitPreviewDto>> {
  if (!isUuid(poId)) return err('NOT_FOUND', 'purchase order not found')
  const db = forTenant(ctx.organizationId)
  const taxDate = taxDateOf(ctx.now)
  const rate = rateFor(taxDate, await listTaxRates())
  const refused = (error: AppError) => ({ kind: 'refused' as const, error })
  const loaded = await db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'po.submit')
    if (!allowed.ok) return refused(allowed.error)
    if (allowed.data.kind !== 'member') return refused({ code: 'FORBIDDEN', message: 'members only' })
    const actor = allowed.data.memberId
    const po = await tx.purchaseOrder.findFirst({
      where: { id: poId },
      select: {
        id: true,
        status: true,
        createdById: true,
        supplier: { select: { status: true } },
        lines: { orderBy: { lineNo: 'asc' }, select: { quantity: true, unitPriceSatang: true, vatable: true, netSatang: true, budgetLineId: true, sources: { select: { releasableSatang: true } } } },
      },
    })
    if (!po) return refused({ code: 'NOT_FOUND', message: 'purchase order not found' })
    if (po.status !== 'DRAFT') return refused({ code: 'INVALID_STATE_TRANSITION', message: 'only a draft is sent for approval', details: { from: po.status, command: 'po.submit' } })
    const totals = rate.ok
      ? documentTotals(
          po.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
          rate.rateBp,
          false,
        )
      : null
    const extraReserveSatang = po.lines.reduce((sum, l) => {
      const delta = l.netSatang - l.sources.reduce((s, src) => s + src.releasableSatang, 0n)
      return delta > 0n ? sum + delta : sum
    }, 0n)
    const supplierActive = po.supplier.status === 'ACTIVE'
    if (!totals || !rate.ok) return { kind: 'blocked' as const, totals: null, rateBp: null, code: 'TAX_RATE_NOT_CONFIGURED', extraReserveSatang, supplierActive }
    if (po.lines.length === 0) return { kind: 'blocked' as const, totals, rateBp: rate.rateBp, code: 'NO_LINES', extraReserveSatang, supplierActive }
    // The same route input as submitPo: whoever sends it owns it when the round drafted it
    const creator = po.createdById ?? actor
    const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } })
    const chargedDepartmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: po.lines[0]!.budgetLineId }, select: { departmentId: true } })).departmentId
    const policy = await loadRoutePolicy(tx)
    const resolved = resolveRoute(
      {
        documentType: 'PURCHASE_ORDER',
        amount: { netSatang: totals.net, vatSatang: totals.vat },
        requesterMemberId: creator,
        chargedDepartmentId,
        conflictMemberIds: [...new Set([creator, ...requests.map((r) => r.requesterMemberId)])],
        at: ctx.now,
      },
      policy,
    )
    // The band of the rule the amount fell into (before an escalation), as the route's own page shows it
    const bandRule = resolved.ok ? versionAt(policy.versions, ctx.now)?.rules.find((x) => x.code === (resolved.data.escalatedFromRuleCode ?? resolved.data.ruleCode)) : undefined
    const band = bandRule?.when.amount ? bandOf(bandRule.when.amount) : null
    return { kind: 'resolved' as const, totals, rateBp: rate.rateBp, resolved, band, extraReserveSatang, supplierActive }
  })
  if (loaded.kind === 'refused') return { ok: false, error: loaded.error }

  const totals = loaded.totals && loaded.rateBp !== null ? { netSatang: loaded.totals.net, vatSatang: loaded.totals.vat, grossSatang: loaded.totals.gross, vatRateBp: loaded.rateBp } : null
  if (loaded.kind === 'blocked') return ok({ totals, route: { kind: 'BLOCKED', code: loaded.code, ruleCode: null }, extraReserveSatang: loaded.extraReserveSatang, supplierActive: loaded.supplierActive })
  const resolved = loaded.resolved
  if (!resolved.ok) {
    const ruleCode = resolved.error.details?.ruleCode
    return ok({ totals, route: { kind: 'BLOCKED', code: resolved.error.code, ruleCode: typeof ruleCode === 'string' ? ruleCode : null }, extraReserveSatang: loaded.extraReserveSatang, supplierActive: loaded.supplierActive })
  }
  const r = resolved.data
  const [members, roleOf] = await Promise.all([membersById(db, r.steps.flatMap((s) => [s.assigneeMemberId, s.principalMemberId])), approverRoles(db)])
  return ok({
    totals,
    route: {
      kind: 'ROUTE',
      doa: { versionId: r.doaVersionId, code: r.doaCode, versionNo: r.versionNo, ruleCode: r.ruleCode },
      escalatedFromRuleCode: r.escalatedFromRuleCode,
      amountBasis: r.amountBasis,
      basisSatang: r.basisAmountSatang,
      band: loaded.band ? { lowerSatang: loaded.band.lower, upperSatang: loaded.band.upper } : null,
      explanationTh: r.explanationTh,
      steps: r.steps.map((s) => ({
        stepNo: s.stepNo,
        approver: members.get(s.assigneeMemberId) ?? null,
        onBehalfOf: s.principalMemberId ? (members.get(s.principalMemberId) ?? null) : null,
        role: roleOf(s.resolvedFrom),
      })),
    },
    extraReserveSatang: loaded.extraReserveSatang,
    supplierActive: loaded.supplierActive,
  })
}
