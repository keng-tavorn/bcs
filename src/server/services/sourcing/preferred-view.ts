import { z } from 'zod'
import { agreementDay } from '@/core/pricing'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { authorize, isAllowed, scopesFor } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { requireModule } from '../modules'
import { supplierAccess } from '../suppliers/access'
import { PREFERRED_EXPIRY_WARNING_DAYS, PREFERRED_RISK_FLAGS, PREFERRED_RISK_STATUSES, riskOn, type PreferredRisk } from './preferred'
import { supplierRiskStatus } from './risk-link'

// The page /suppliers/preferred (S10-13 · BR-RFX-14 · ADR-207 · docs/sub-specs/S10.md "หน้าจอ"): the preferred suppliers
// per category as procurement keeps them — where each came from (the award AWD-… with its RFx, or MANUAL with its
// reason), its period as its first and last day (validTo is not included), where it stands today (in effect, ending
// within the warning days, still to come, ended early with its reason, over), and with RISK on the supplier's risk and
// whether a requester steering clear of it is asked why (riskExempt, the rule of preferred.ts). Every member reads it
// (supplier.view: names and periods are basic fields; procurement's words — why it set one, why it ended one — only for
// whoever reads the register in full: PROCUREMENT FINANCE AUDITOR); procurement sets one (only while SOURCING is on, BR-RFX-16) and
// ends one (sourcing.preferred.manage) — the commands in ./preferred.ts check both again. Read only, in one transaction.

/** Where a row stands on the page's Thai calendar day */
export type PreferredRowStatus = 'IN_EFFECT' | 'ENDING_SOON' | 'UPCOMING' | 'ENDED' | 'EXPIRED'

export interface PreferredRowDto {
  readonly id: string
  readonly categoryCode: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: { readonly th: string; readonly en: string | null }
  /** An inactive supplier is never filled into a request, whatever its period (preferredInEffect) */
  readonly supplierActive: boolean
  readonly source: 'SOURCING' | 'MANUAL'
  /** SOURCING: the award it came from, and its RFx for the link to the award page */
  readonly award: { readonly number: string | null; readonly rfxEventId: string } | null
  /** MANUAL: why procurement prefers it; null for a reader of the basic details only */
  readonly note: string | null
  /** YYYY-MM-DD, included */
  readonly validFrom: string
  /** YYYY-MM-DD: the last day it applies, included (validTo − 1 day) */
  readonly lastDay: string
  /** YYYY-MM-DD, not included */
  readonly validTo: string
  readonly status: PreferredRowStatus
  /** Days from today to validTo while it runs (1 = today is its last day); null once ended, over or still to come */
  readonly daysLeft: number | null
  /** Ended early: when (ISO) and why (the why null for a reader of the basic details only) */
  readonly ended: { readonly at: string; readonly reason: string | null } | null
  /** With RISK on: the supplier's tier and assessment status (S11) and its registry flag; null with RISK off */
  readonly risk: PreferredRisk | null
  /** BR-RFX-14: with RISK on, a requester who chooses another supplier is not asked why */
  readonly riskExempt: boolean
  /** "สิ้นสุด" may be offered: sourcing.preferred.manage, not ended, not over */
  readonly canEnd: boolean
}

export interface PreferredSupplierPageDto {
  /** YYYY-MM-DD: the Thai calendar day the statuses are read on */
  readonly today: string
  readonly show: 'current' | 'all'
  readonly category: string | null
  readonly rows: readonly PreferredRowDto[]
  /** More rows matched than PREFERRED_PAGE_LIMIT */
  readonly limited: boolean
  /** The categories procurement may set one for (catalogue items and RFx: what preferredSupplier.create accepts) */
  readonly categories: readonly string[]
  /** The categories to filter by: those and the ones of rows set before */
  readonly filterCategories: readonly string[]
  /** The ACTIVE suppliers to choose from (only for a reader who may set one) */
  readonly suppliers: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null }>
  /** sourcing.preferred.manage */
  readonly canManage: boolean
  /** SOURCING is on: a new one may be set (ending one does not need it) */
  readonly sourcingOn: boolean
  /** The award numbers link to their award page: SOURCING on and every RFx readable (sourcing.view ORG) */
  readonly awardLinks: boolean
  /** The period a set one gets when its last day is left blank (organization setting preferredSupplierDays) */
  readonly defaultDays: number
  readonly riskOn: boolean
  readonly warningDays: number
}

export const PREFERRED_PAGE_LIMIT = 500

const Filter = z.strictObject({ category: z.string().trim().max(50).optional(), show: z.enum(['current', 'all']) })

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`)
const daysBetween = (from: string, to: string) => Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / MS_PER_DAY)

/** Where a row stands on `today`: ended early first, then over, still to come, and in effect (ending soon within the warning days) */
export function preferredRowStatus(row: { readonly validFrom: string; readonly validTo: string; readonly endedAt: Date | null }, today: string): { status: PreferredRowStatus; daysLeft: number | null } {
  if (row.endedAt) return { status: 'ENDED', daysLeft: null }
  if (row.validTo <= today) return { status: 'EXPIRED', daysLeft: null }
  if (row.validFrom > today) return { status: 'UPCOMING', daysLeft: null }
  const daysLeft = daysBetween(today, row.validTo)
  return { status: daysLeft <= PREFERRED_EXPIRY_WARNING_DAYS ? 'ENDING_SOON' : 'IN_EFFECT', daysLeft }
}

const exemptBy = (risk: PreferredRisk | null): boolean =>
  risk !== null && ((PREFERRED_RISK_STATUSES as readonly string[]).includes(risk.status ?? '') || (PREFERRED_RISK_FLAGS as readonly string[]).includes(risk.registryFlag))

async function distinctCategories(tx: TenantTx): Promise<{ create: string[]; filter: string[] }> {
  const [items, rfx, rows] = await Promise.all([
    tx.catalogItem.findMany({ distinct: ['categoryCode'], select: { categoryCode: true } }),
    tx.rfxEvent.findMany({ distinct: ['categoryCode'], select: { categoryCode: true } }),
    tx.preferredSupplier.findMany({ distinct: ['categoryCode'], select: { categoryCode: true } }),
  ])
  const sorted = (codes: Iterable<string>) => [...new Set([...codes].filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const create = sorted([...items, ...rfx].map((r) => r.categoryCode))
  return { create, filter: sorted([...create, ...rows.map((r) => r.categoryCode)]) }
}

/** /suppliers/preferred: the rows of the filter, with what the reader may do; FORBIDDEN without supplier.view */
export async function preferredSupplierPage(ctx: Ctx, filter: { readonly category?: string; readonly show: 'current' | 'all' }): Promise<Result<PreferredSupplierPageDto>> {
  const parsed = Filter.safeParse(filter)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the filter is not one the page offers', { field: String(parsed.error.issues[0]?.path[0] ?? 'filter') })
  const category = parsed.data.category ? parsed.data.category : null
  const show = parsed.data.show
  const today = agreementDay(ctx.now)
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<PreferredSupplierPageDto>> => {
    const principal = await authorize(tx, ctx, 'supplier.view')
    if (!principal.ok) return err(principal.error.code, principal.error.message, principal.error.details)
    const canManage = isAllowed(principal.data, 'sourcing.preferred.manage')
    const full = supplierAccess(principal.data)?.level === 'FULL'
    const sourcingOn = (await requireModule(ctx, 'SOURCING', tx)).ok
    const awardLinks = sourcingOn && scopesFor(principal.data, 'sourcing.view').has('ORG')
    const withRisk = await riskOn(tx, ctx)
    const found = await tx.preferredSupplier.findMany({
      where: { ...(category ? { categoryCode: category } : {}), ...(show === 'current' ? { endedAt: null, validTo: { gt: dateOf(today) } } : {}) },
      // current: per category, the row the form fills first on top (latest validFrom, BR-FORM-12); all: newest first
      orderBy: show === 'current' ? [{ categoryCode: 'asc' }, { validFrom: 'desc' }, { createdAt: 'desc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PREFERRED_PAGE_LIMIT + 1,
      select: {
        id: true,
        categoryCode: true,
        supplierId: true,
        source: true,
        note: true,
        validFrom: true,
        validTo: true,
        endedAt: true,
        endReason: true,
        supplier: { select: { code: true, nameTh: true, nameEn: true, status: true, registryFlag: true } },
        awardDecision: { select: { number: true, rfxEventId: true } },
      },
    })
    const rows = found.slice(0, PREFERRED_PAGE_LIMIT)
    const risks = new Map<string, PreferredRisk>()
    if (withRisk) {
      for (const r of rows) {
        if (risks.has(r.supplierId)) continue
        const status = await supplierRiskStatus(tx, ctx.organizationId, r.supplierId, ctx.now)
        risks.set(r.supplierId, { tier: status?.tier ?? null, status: status?.status ?? null, registryFlag: r.supplier.registryFlag })
      }
    }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const [categories, suppliers] = await Promise.all([
      distinctCategories(tx),
      canManage && sourcingOn
        ? tx.supplier.findMany({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' }, select: { id: true, code: true, nameTh: true, nameEn: true } })
        : Promise.resolve([]),
    ])
    return ok({
      today,
      show,
      category,
      rows: rows.map((r): PreferredRowDto => {
        const validFrom = dayOf(r.validFrom)
        const validTo = dayOf(r.validTo)
        const { status, daysLeft } = preferredRowStatus({ validFrom, validTo, endedAt: r.endedAt }, today)
        const risk = risks.get(r.supplierId) ?? null
        return {
          id: r.id,
          categoryCode: r.categoryCode,
          supplierId: r.supplierId,
          supplierCode: r.supplier.code,
          supplierName: { th: r.supplier.nameTh, en: r.supplier.nameEn },
          supplierActive: r.supplier.status === 'ACTIVE',
          source: r.source,
          award: r.awardDecision ? { number: r.awardDecision.number, rfxEventId: r.awardDecision.rfxEventId } : null,
          note: full ? r.note : null,
          validFrom,
          lastDay: dayOf(new Date(r.validTo.getTime() - MS_PER_DAY)),
          validTo,
          status,
          daysLeft,
          ended: r.endedAt ? { at: r.endedAt.toISOString(), reason: full ? r.endReason : null } : null,
          risk,
          riskExempt: exemptBy(risk),
          canEnd: canManage && status !== 'ENDED' && status !== 'EXPIRED',
        }
      }),
      limited: found.length > PREFERRED_PAGE_LIMIT,
      categories: categories.create,
      filterCategories: categories.filter,
      suppliers,
      canManage,
      sourcingOn,
      awardLinks,
      defaultDays: sourcingSettingsOf(org.settings).preferredSupplierDays,
      riskOn: withRisk,
      warningDays: PREFERRED_EXPIRY_WARNING_DAYS,
    })
  })
}

/**
 * Whether the supplier register links to /suppliers/preferred: while SOURCING is on, or when rows set before still fill
 * the request form after it was switched off (BR-RFX-16) — never a link to a page of a module the organization never had
 * (§9.9 · NG-13). Every member may open the page (supplier.view), so this asks no capability.
 */
export async function preferredSuppliersLinked(ctx: Ctx): Promise<boolean> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => (await requireModule(ctx, 'SOURCING', tx)).ok || (await tx.preferredSupplier.findFirst({ select: { id: true } })) !== null)
}
