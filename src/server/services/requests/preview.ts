import { z } from 'zod'
import { bandOf, resolveRoute, versionAt } from '@/core/doa'
import { amountToSatang, toMoneyDto, type MoneyDto } from '@/core/money/dto'
import { documentTotals } from '@/core/money/math'
import { err, ok, type Result } from '@/core/result'
import { rateFor, taxDateOf } from '@/core/vat'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant } from '@/server/db/tenant'
import { loadRoutePolicy } from '@/server/doa/policy'
import { budgetLineAvailability, type ScreenLocale } from '@/server/queries/request-form'

// What the requester sees before pressing "send for approval" (spec §9.9 principle 3): the totals from core/money, what
// is left on the budget line they chose (FR-INT-004 AC1, budget.view SELECTED_LINE_ONLY), and the approval route the DOA
// engine expects with its explanation (FR-DOA-003 AC2) — or, when the DOA cannot route the request, why, so the screen
// tells the requester to contact the organization's administrators (AC3). It runs resolveRoute on the current form
// without writing anything; the submit does it all again under lock. The request type is the draft's own when a draft
// is named, otherwise an active type with a published form — the same rule as the catalog and createDraft.

const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)
const Quantity = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)

export const PreviewInput = z.strictObject({
  requestTypeCode: z.string().min(1).max(50),
  /** The draft being edited: what it already reserves counts as available to it */
  requestId: z.uuid().nullish(),
  budgetLineId: z.uuid().nullish(),
  priceIncludesVat: z.boolean(),
  lines: z.array(z.strictObject({ quantity: Quantity, unitPrice: Baht, vatable: z.boolean() })).max(200),
})

export interface RouteStepPreviewDto {
  readonly stepNo: number
  readonly assigneeName: string
  /** The person the assignee acts for (delegation, BR-DLG-04) */
  readonly principalName: string | null
  /** Position code from the DOA rule (e.g. VP); null for a named member */
  readonly position: string | null
  readonly positionName: string | null
  readonly departmentName: string | null
}

export type RoutePreviewDto =
  /** A new-supplier request goes to the procurement queue without a DOA route (OQ-23) */
  | { readonly kind: 'NO_ROUTE' }
  /** No line with an amount yet */
  | { readonly kind: 'NEEDS_AMOUNT' }
  | {
      readonly kind: 'ROUTE'
      readonly doaCode: string
      readonly versionNo: number
      readonly ruleCode: string
      /** The rule the amount fell in when its approver is involved in the request (BR-DOA-06) */
      readonly escalatedFromRuleCode: string | null
      readonly amountBasis: 'GROSS' | 'NET'
      readonly basisAmount: MoneyDto | null
      /** The band of the rule the amount fell in: more than `over`, up to `upTo` */
      readonly band: { readonly over: MoneyDto | null; readonly upTo: MoneyDto | null } | null
      readonly steps: readonly RouteStepPreviewDto[]
      /** The engine's Thai explanation, kept with the route at submit (BR-DOA-10) */
      readonly explanationTh: string
    }
  | {
      readonly kind: 'BLOCKED'
      readonly code: string
      readonly ruleCode: string | null
      readonly position: string | null
      readonly positionName: string | null
      readonly departments: readonly string[]
    }

export type BudgetPreviewDto =
  | { readonly kind: 'NONE' }
  /** Not a line this requester may use (another department's without a grant, or no longer open) */
  | { readonly kind: 'NOT_USABLE' }
  | { readonly kind: 'LINE'; readonly budgetLineId: string; readonly available: MoneyDto; readonly need: MoneyDto; readonly enough: boolean; readonly shortfall: MoneyDto }

export interface RequestPreviewDto {
  readonly totals: { readonly net: MoneyDto; readonly vat: MoneyDto; readonly gross: MoneyDto; readonly vatRateBp: number } | null
  readonly budget: BudgetPreviewDto
  readonly route: RoutePreviewDto
}

const POSITION = /^POSITION:([^@]+)@(.+)$/

export async function previewRequest(ctx: Ctx, rawInput: z.input<typeof PreviewInput>, locale: ScreenLocale): Promise<Result<RequestPreviewDto>> {
  const parsed = PreviewInput.safeParse(rawInput)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid preview input', { field: parsed.error.issues[0]?.path.join('.') ?? '(input)' })
  const input = parsed.data
  const taxDate = taxDateOf(ctx.now)
  const rate = rateFor(taxDate, await listTaxRates())
  const totals = rate.ok
    ? documentTotals(
        input.lines.map((l) => ({ quantity: l.quantity, unitPriceSatang: amountToSatang(l.unitPrice), vatable: l.vatable })),
        rate.rateBp,
        input.priceIncludesVat,
      )
    : null

  const db = forTenant(ctx.organizationId)
  const loaded = await db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'request.create')
    if (!allowed.ok || allowed.data.kind !== 'member') return { kind: 'forbidden' as const }
    const memberId = allowed.data.memberId
    let documentType: 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'
    if (input.requestId) {
      // Editing a request: it must be the requester's own (request.create OWN), and its own type decides
      const request = await tx.request.findFirst({ where: { id: input.requestId }, select: { requesterMemberId: true, documentType: true } })
      if (!request) return { kind: 'missing' as const }
      const own = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
      if (!own.ok) return { kind: 'forbidden' as const }
      documentType = request.documentType
    } else {
      const type = await tx.requestType.findFirst({ where: { code: input.requestTypeCode, active: true, currentFormVersion: { is: { status: 'PUBLISHED' } } }, select: { documentType: true } })
      if (!type) return { kind: 'missing' as const }
      documentType = type.documentType
    }
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { primaryDepartmentId: true } })
    return { kind: 'ok' as const, memberId, documentType, primaryDepartmentId: member.primaryDepartmentId }
  })
  if (loaded.kind === 'forbidden') return err('FORBIDDEN', 'only the requester previews their request')
  if (loaded.kind === 'missing') return err('NOT_FOUND', 'unknown request or request type')

  const money = (s: bigint) => toMoneyDto(s)
  const totalsDto = totals && rate.ok ? { net: money(totals.net), vat: money(totals.vat), gross: money(totals.gross), vatRateBp: rate.rateBp } : null
  if (loaded.documentType === 'SUPPLIER_REQUEST') return ok({ totals: null, budget: { kind: 'NONE' }, route: { kind: 'NO_ROUTE' } })

  // BR-BUD-02/03: the request reserves its amount before VAT on the line it chose
  let budget: BudgetPreviewDto = { kind: 'NONE' }
  let chargedDepartmentId = loaded.primaryDepartmentId
  if (input.budgetLineId) {
    const line = await budgetLineAvailability(ctx, { budgetLineId: input.budgetLineId, day: taxDate, requestId: input.requestId ?? null })
    if (!line) budget = { kind: 'NOT_USABLE' }
    else {
      // BR-DOA-05: the department that owns the budget pays, so its approvers decide
      chargedDepartmentId = line.departmentId
      const available = amountToSatang(line.available.amount)
      const need = totals?.net ?? 0n
      budget = { kind: 'LINE', budgetLineId: line.budgetLineId, available: line.available, need: money(need), enough: need <= available, shortfall: money(need > available ? need - available : 0n) }
    }
  }

  if (!rate.ok || !totals) {
    return ok({ totals: null, budget, route: { kind: 'BLOCKED', code: 'TAX_RATE_NOT_CONFIGURED', ruleCode: null, position: null, positionName: null, departments: [] } })
  }
  if (totals.gross <= 0n) return ok({ totals: totalsDto, budget, route: { kind: 'NEEDS_AMOUNT' } })
  if (!chargedDepartmentId) {
    return ok({ totals: totalsDto, budget, route: { kind: 'BLOCKED', code: 'NO_DEPARTMENT', ruleCode: null, position: null, positionName: null, departments: [] } })
  }

  const route = await db.$transaction(async (tx) => {
    const policy = await loadRoutePolicy(tx)
    const resolved = resolveRoute(
      {
        documentType: 'PURCHASE_REQUEST',
        amount: { netSatang: totals.net, vatSatang: totals.vat },
        requesterMemberId: loaded.memberId,
        chargedDepartmentId,
        conflictMemberIds: [loaded.memberId],
        at: ctx.now,
      },
      policy,
    )
    const positions = await tx.position.findMany({ select: { code: true, nameTh: true, nameEn: true } })
    const departments = await tx.department.findMany({ select: { code: true, nameTh: true, nameEn: true } })
    const positionName = (code: string | null) => {
      const p = code ? positions.find((x) => x.code === code) : undefined
      return p ? ((locale === 'en' ? p.nameEn : null) ?? p.nameTh) : null
    }
    const departmentName = (code: string) => {
      const d = departments.find((x) => x.code === code)
      return d ? ((locale === 'en' ? d.nameEn : null) ?? d.nameTh) : code
    }
    if (!resolved.ok) {
      const d = resolved.error.details ?? {}
      const position = typeof d.position === 'string' ? d.position : null
      return {
        kind: 'BLOCKED' as const,
        code: resolved.error.code,
        ruleCode: typeof d.ruleCode === 'string' ? d.ruleCode : null,
        position,
        positionName: positionName(position),
        departments: Array.isArray(d.departments) ? d.departments.filter((x): x is string => typeof x === 'string').map(departmentName) : [],
      }
    }
    const r = resolved.data
    // Approvers by name in the reader's language (the DOA policy carries Thai names only)
    const ids = [...new Set(r.steps.flatMap((s) => (s.principalMemberId ? [s.assigneeMemberId, s.principalMemberId] : [s.assigneeMemberId])))]
    const people = await tx.member.findMany({ where: { id: { in: ids } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
    const nameOf = (id: string) => {
      const m = people.find((x) => x.id === id)
      return m ? ((locale === 'en' ? m.displayNameEn : null) ?? m.displayNameTh) : (policy.org.members.find((x) => x.id === id)?.displayNameTh ?? id)
    }
    const version = versionAt(policy.versions, ctx.now)
    const bandRule = version?.rules.find((x) => x.code === (r.escalatedFromRuleCode ?? r.ruleCode))
    const band = bandRule?.when.amount ? bandOf(bandRule.when.amount) : null
    return {
      kind: 'ROUTE' as const,
      doaCode: r.doaCode,
      versionNo: r.versionNo,
      ruleCode: r.ruleCode,
      escalatedFromRuleCode: r.escalatedFromRuleCode,
      amountBasis: r.amountBasis,
      basisAmount: r.basisAmountSatang === null ? null : money(r.basisAmountSatang),
      band: band ? { over: band.lower !== null && band.lower > 0n ? money(band.lower) : null, upTo: band.upper !== null ? money(band.upper) : null } : null,
      steps: r.steps.map((s) => {
        const at = POSITION.exec(s.resolvedFrom)
        return {
          stepNo: s.stepNo,
          assigneeName: nameOf(s.assigneeMemberId),
          principalName: s.principalMemberId ? nameOf(s.principalMemberId) : null,
          position: at ? at[1]! : null,
          positionName: at ? positionName(at[1]!) : null,
          departmentName: at ? departmentName(at[2]!) : null,
        }
      }),
      explanationTh: r.explanationTh,
    }
  })
  return ok({ totals: totalsDto, budget, route })
}
