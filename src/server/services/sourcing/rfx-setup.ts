import { satangToAmount } from '@/core/money/dto'
import type { Result } from '@/core/result'
import { earliestCloseAt, questionCutoffAt, type RfxKind } from '@/core/sourcing'
import { formatQuantity } from '@/core/receiving'
import { SOURCING_CATALOG_MAX, SOURCING_CHOICES_MAX } from '@/lib/constants'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { authorize, loadPrincipal, scopesFor } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { isUuid } from '@/server/queries/requests'
import { requireModule } from '../modules'
import { freeLines } from '../procurement/pool'
import type { SupplierSnapshot } from './invites'
import { scoringConflicts } from './rfx'

// What the internal sourcing screens read (S10-12 · docs/sub-specs/S10.md "หน้าจอ"): the list of RFx at /sourcing, the
// pool lines a new RFx starts from at /sourcing/new, and everything the step-by-step form of /sourcing/[id]/edit shows
// (the RFx, its lines, its invites and the suppliers and applications that may be invited, its scorecard and the members
// who may score it, and when it may close). Reads only; every change goes through the commands of rfx.ts, which check
// SOURCING, sourcing.manage, the state machine and the version again (BR-AUTH-05).
// Who sees which RFx in the list: sourcing.view at ORG (PROCUREMENT FINANCE EXECUTIVE AUDITOR) sees every one; anyone
// else only those rfxReading would let them open — the RFx they evaluate or whose award they approve (ASSIGNED) and
// those holding a line they requested (OWN). Never a price here: the list counts invites and bids, nothing more.

export interface RfxListRow {
  readonly id: string
  readonly number: string | null
  readonly kind: string
  readonly status: string
  readonly title: string
  readonly titleEn: string | null
  readonly categoryCode: string
  readonly closesAt: string | null
  readonly inviteCount: number
  readonly bidCount: number
  readonly createdBy: { readonly th: string; readonly en: string | null }
  readonly createdAt: string
}

export interface RfxListFilter {
  readonly status?: string
  readonly kind?: string
  readonly category?: string
}

export interface RfxListDto {
  readonly rows: readonly RfxListRow[]
  /** Every category of an RFx the reader sees, for the filter */
  readonly categories: readonly string[]
  readonly canManage: boolean
}

const STATUSES = ['DRAFT', 'OPEN', 'CLOSED', 'EVALUATING', 'AWARDED', 'CONCLUDED', 'CANCELLED'] as const
const KINDS = ['RFQ', 'RFP', 'RFI'] as const
const LIVE_INVITE = ['INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN', 'EXPIRED'] as const

const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** The ids of the RFx a member without ORG reach may open: evaluated by them, awaiting their approval, or holding their lines */
async function reachable(tx: TenantTx, memberId: string): Promise<string[]> {
  const [cards, tasks, sources] = await Promise.all([
    tx.scorecardEvaluator.findMany({ where: { memberId }, select: { scorecard: { select: { rfxEventId: true } } } }),
    tx.approvalTask.findMany({ where: { OR: [{ assigneeMemberId: memberId }, { principalMemberId: memberId }], step: { route: { subjectType: 'AWARD_DECISION' } } }, select: { step: { select: { route: { select: { subjectId: true } } } } } }),
    tx.rfxLineSource.findMany({ where: { requestLine: { request: { requesterMemberId: memberId } } }, select: { rfxLine: { select: { rfxEventId: true } } } }),
  ])
  const awards = tasks.length ? await tx.awardDecision.findMany({ where: { id: { in: tasks.map((t) => t.step.route.subjectId) } }, select: { rfxEventId: true } }) : []
  return [...new Set([...cards.map((c) => c.scorecard.rfxEventId), ...awards.map((a) => a.rfxEventId), ...sources.map((s) => s.rfxLine.rfxEventId)])]
}

export async function rfxList(ctx: Ctx, filter: RfxListFilter = {}): Promise<Result<RfxListDto>> {
  const member = memberOf(ctx)
  if (!member) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<RfxListDto>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const principal = await loadPrincipal(tx, ctx)
    const everyOne = scopesFor(principal, 'sourcing.view').has('ORG')
    const ids = everyOne ? null : await reachable(tx, member)
    const scope = ids === null ? {} : { id: { in: ids } }
    const status = (STATUSES as readonly string[]).includes(filter.status ?? '') ? { status: filter.status as (typeof STATUSES)[number] } : {}
    const kind = (KINDS as readonly string[]).includes(filter.kind ?? '') ? { kind: filter.kind as (typeof KINDS)[number] } : {}
    const category = filter.category ? { categoryCode: filter.category } : {}
    const [rows, categories] = await Promise.all([
      tx.rfxEvent.findMany({
        where: { ...scope, ...status, ...kind, ...category },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
        select: {
          id: true,
          number: true,
          kind: true,
          status: true,
          title: true,
          titleEn: true,
          categoryCode: true,
          closesAt: true,
          createdAt: true,
          createdBy: { select: { displayNameTh: true, displayNameEn: true } },
          _count: { select: { invites: { where: { status: { in: [...LIVE_INVITE] } } }, bids: { where: { status: 'SUBMITTED' } } } },
        },
      }),
      tx.rfxEvent.findMany({ where: scope, distinct: ['categoryCode'], orderBy: { categoryCode: 'asc' }, select: { categoryCode: true } }),
    ])
    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          number: r.number,
          kind: r.kind,
          status: r.status,
          title: r.title,
          titleEn: r.titleEn,
          categoryCode: r.categoryCode,
          closesAt: r.closesAt?.toISOString() ?? null,
          inviteCount: r._count.invites,
          bidCount: r._count.bids,
          createdBy: { th: r.createdBy.displayNameTh, en: r.createdBy.displayNameEn },
          createdAt: r.createdAt.toISOString(),
        })),
        categories: categories.map((c) => c.categoryCode),
        canManage: (await authorize(tx, ctx, 'sourcing.manage')).ok,
      },
    }
  })
}

// ---------- /sourcing/new ----------

export interface NewRfxLineDto {
  readonly requestLineId: string
  readonly requestNo: string
  readonly lineNo: number
  readonly description: string
  readonly categoryCode: string | null
  readonly quantity: string
  readonly uom: string
}

export interface NewRfxDto {
  /** The pool lines asked for (empty for an RFx of a need) */
  readonly lines: readonly NewRfxLineDto[]
  /** Pool lines asked for that are not free lines of the pool any more (ordered, in an RFx, gone) */
  readonly missing: number
  /** The categories of the catalogue, for an RFx of a need */
  readonly categories: readonly string[]
  /** The catalogue items of every category, with their reference price before VAT (baht text) */
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly code: string; readonly name: string; readonly uom: string; readonly categoryCode: string; readonly refUnitPrice: string | null }>
  /** OQ-212: the organization takes bids with VAT included */
  readonly vatInclusiveAllowed: boolean
}

/** What /sourcing/new shows: the pool lines it starts from, or the catalogue for a need. sourcing.manage only. */
export async function newRfxContext(ctx: Ctx, requestLineIds: readonly string[]): Promise<Result<NewRfxDto>> {
  const ids = [...new Set(requestLineIds.filter(isUuid))].slice(0, 200)
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<NewRfxDto>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'sourcing.manage')
    if (!may.ok) return may
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const free = ids.length ? await freeLines(tx, { requestIds: await requestsOf(tx, ids) }) : []
    const asked = new Set(ids)
    const lines = free.filter((l) => asked.has(l.requestLineId))
    const items = ids.length
      ? []
      : await tx.catalogItem.findMany({ where: { active: true }, orderBy: [{ categoryCode: 'asc' }, { code: 'asc' }], take: SOURCING_CATALOG_MAX, select: { id: true, code: true, nameTh: true, uom: true, categoryCode: true, refUnitPriceSatang: true } })
    return {
      ok: true,
      data: {
        lines: lines.map((l) => ({ requestLineId: l.requestLineId, requestNo: l.requestNo, lineNo: l.lineNo, description: l.description, categoryCode: l.categoryCode, quantity: formatQuantity(l.free), uom: l.uom })),
        missing: ids.length - lines.length,
        categories: [...new Set(items.map((i) => i.categoryCode))],
        catalog: items.map((i) => ({ id: i.id, code: i.code, name: i.nameTh, uom: i.uom, categoryCode: i.categoryCode, refUnitPrice: i.refUnitPriceSatang > 0n ? satangToAmount(i.refUnitPriceSatang) : null })),
        vatInclusiveAllowed: sourcingSettingsOf(org.settings).allowVatInclusiveBids,
      },
    }
  })
}

async function requestsOf(tx: TenantTx, requestLineIds: readonly string[]): Promise<string[]> {
  const rows = await tx.requestLine.findMany({ where: { id: { in: [...requestLineIds] } }, select: { requestId: true } })
  return [...new Set(rows.map((r) => r.requestId))]
}

// ---------- /sourcing/[id]/edit ----------

export interface SetupInvite {
  readonly id: string
  readonly owner: 'SUPPLIER' | 'APPLICATION'
  readonly code: string | null
  readonly name: string
  readonly status: string
  readonly vatRegistered: boolean
  readonly foreign: boolean
  readonly registryFlag: string | null
  readonly documentsOk: boolean | null
  readonly risk: { readonly tier: string | null; readonly blocked: boolean } | null
}

export interface SetupSupplierChoice {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly sameCategory: boolean
  readonly foreign: boolean
  /** Why the service would refuse the invite, or null */
  readonly refusal: 'PORTAL_NOT_ENABLED' | 'SUPPLIER_FLAGGED' | null
}

export interface SetupMemberChoice {
  readonly id: string
  readonly name: { readonly th: string; readonly en: string | null }
  /** BR-SOD-14: who may not score this RFx, and why */
  readonly conflict: 'CREATOR' | 'REQUESTER' | null
}

export interface RfxSetupDto {
  readonly rfx: {
    readonly id: string
    readonly number: string | null
    readonly kind: RfxKind
    readonly status: string
    readonly version: number
    readonly title: string
    readonly titleEn: string | null
    readonly description: string
    readonly descriptionEn: string | null
    readonly categoryCode: string
    readonly sourceKind: string
    readonly sealed: boolean
    readonly allowPartialBids: boolean
    readonly allowVatInclusiveBids: boolean
    readonly bidValidityDays: number
    readonly minInvites: number
    /** Σ quantity × reference price before VAT (baht text), or null */
    readonly estimatedNet: string | null
    readonly closesAt: string | null
  }
  readonly lines: ReadonlyArray<{ readonly id: string; readonly lineNo: number; readonly description: string; readonly descriptionEn: string | null; readonly quantity: string; readonly uom: string; readonly uomEn: string | null; readonly site: string | null; readonly refUnitPrice: string | null; readonly refSource: string | null; readonly fromRequests: readonly string[] }>
  readonly invites: readonly SetupInvite[]
  readonly supplierChoices: readonly SetupSupplierChoice[]
  readonly applicationChoices: ReadonlyArray<{ readonly id: string; readonly name: string; readonly status: string }>
  readonly scorecard: {
    readonly status: string
    readonly criteria: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly weightBp: number; readonly kind: 'PRICE' | 'QUALITY' }>
    readonly evaluatorIds: readonly string[]
    readonly minEvaluators: number
  } | null
  /** The organization's default weights of this kind (settings.sourcing.defaultWeightsBp · OQ-206) */
  readonly defaultWeights: Readonly<Record<string, number>>
  readonly minEvaluators: number
  readonly memberChoices: readonly SetupMemberChoice[]
  /** When an RFx opened now may close at the earliest (BR-RFX-02), and the business days of that rule */
  readonly earliestCloseAt: string
  readonly openBusinessDays: number
  readonly cutoffBusinessDays: number
  /** The close asked for on the review step, with the question cut-off it gives, or null */
  readonly schedule: { readonly closesAt: string; readonly questionCutoffAt: string; readonly tooSoon: boolean } | null
  readonly vatInclusiveAllowed: boolean
  /** An RFx of a need: the catalogue items of its category, to add a line from */
  readonly catalog: ReadonlyArray<{ readonly id: string; readonly code: string; readonly name: string; readonly uom: string; readonly refUnitPrice: string | null }>
  readonly canManage: boolean
}

const OPEN_APPLICATION = ['INVITED', 'DRAFT', 'SUBMITTED', 'RETURNED', 'PENDING_APPROVAL'] as const

/** The step-by-step form of one RFx: sourcing.manage reads it; the close is checked against now (rfx.open checks again) */
export async function rfxSetup(ctx: Ctx, rfxEventId: string, options: { readonly closesAt?: string | null } = {}): Promise<Result<RfxSetupDto>> {
  if (!isUuid(rfxEventId)) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<RfxSetupDto>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'sourcing.manage')
    if (!may.ok) return may
    const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId } })
    if (!rfx) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const settings = sourcingSettingsOf(org.settings)
    const kind = rfx.kind as RfxKind
    const [lines, invites, card, suppliers, applications, members, conflicts, calendar] = await Promise.all([
      tx.rfxLine.findMany({
        where: { rfxEventId },
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true, description: true, descriptionEn: true, quantity: true, uom: true, uomEn: true, refUnitPriceSatang: true, refSource: true, deliverySiteId: true, sources: { where: { active: true }, select: { requestLine: { select: { request: { select: { number: true } } } } } } },
      }),
      tx.rfxInvite.findMany({ where: { rfxEventId, status: { not: 'REMOVED' } }, orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }], select: { id: true, supplierId: true, applicationId: true, status: true, supplierSnapshot: true } }),
      tx.scorecard.findFirst({ where: { rfxEventId }, select: { status: true, minEvaluators: true, criteria: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { code: true, nameTh: true, nameEn: true, weightBp: true, kind: true } }, evaluators: { where: { status: { not: 'RECUSED' } }, select: { memberId: true } } } }),
      tx.supplier.findMany({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' }, take: SOURCING_CHOICES_MAX, select: { id: true, code: true, nameTh: true, category: true, isForeign: true, portalEnabled: true, registryFlag: true } }),
      tx.supplierApplication.findMany({ where: { kind: 'NEW', status: { in: [...OPEN_APPLICATION] } }, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, nameTh: true, status: true } }),
      tx.member.findMany({ where: { status: 'ACTIVE' }, orderBy: { displayNameTh: 'asc' }, take: SOURCING_CHOICES_MAX, select: { id: true, displayNameTh: true, displayNameEn: true } }),
      scoringConflicts(tx, rfx),
      loadBusinessCalendar(tx, ctx.organizationId),
    ])
    const items =
      rfx.sourceKind === 'NEED' && rfx.status === 'DRAFT'
        ? await tx.catalogItem.findMany({ where: { active: true, categoryCode: rfx.categoryCode }, orderBy: { code: 'asc' }, take: SOURCING_CATALOG_MAX, select: { id: true, code: true, nameTh: true, uom: true, refUnitPriceSatang: true } })
        : []
    const sites = await tx.deliverySite.findMany({ where: { id: { in: [...new Set(lines.flatMap((l) => (l.deliverySiteId ? [l.deliverySiteId] : [])))] } }, select: { id: true, nameTh: true } })
    const siteOf = new Map(sites.map((s) => [s.id, s.nameTh]))
    const codes = await tx.supplier.findMany({ where: { id: { in: invites.flatMap((i) => (i.supplierId ? [i.supplierId] : [])) } }, select: { id: true, code: true } })
    const codeOf = new Map(codes.map((s) => [s.id, s.code]))
    const invited = new Set(invites.flatMap((i) => [i.supplierId, i.applicationId].filter((x): x is string => x !== null)))
    const creators = new Set(conflicts.rfxCreatorMemberIds)
    const requesters = new Set(conflicts.sourceRequesterMemberIds)
    const earliest = earliestCloseAt(ctx.now, settings.minOpenBusinessDays[kind], calendar)
    let schedule: RfxSetupDto['schedule'] = null
    const asked = options.closesAt ? new Date(options.closesAt) : null
    if (asked && !Number.isNaN(asked.getTime())) {
      schedule = { closesAt: asked.toISOString(), questionCutoffAt: questionCutoffAt(asked, settings.questionCutoffBusinessDays, calendar).toISOString(), tooSoon: asked.getTime() < earliest.getTime() }
    }
    const weights: Record<string, number> = kind === 'RFI' ? {} : { ...settings.defaultWeightsBp[kind] }
    return {
      ok: true,
      data: {
        rfx: {
          id: rfx.id,
          number: rfx.number,
          kind,
          status: rfx.status,
          version: rfx.version,
          title: rfx.title,
          titleEn: rfx.titleEn,
          description: rfx.description,
          descriptionEn: rfx.descriptionEn,
          categoryCode: rfx.categoryCode,
          sourceKind: rfx.sourceKind,
          sealed: rfx.sealed,
          allowPartialBids: rfx.allowPartialBids,
          allowVatInclusiveBids: rfx.allowVatInclusiveBids,
          bidValidityDays: rfx.bidValidityDays,
          minInvites: rfx.minInvites,
          estimatedNet: rfx.estimatedNetSatang === null ? null : satangToAmount(rfx.estimatedNetSatang),
          closesAt: rfx.closesAt?.toISOString() ?? null,
        },
        lines: lines.map((l) => ({
          id: l.id,
          lineNo: l.lineNo,
          description: l.description,
          descriptionEn: l.descriptionEn,
          uomEn: l.uomEn,
          quantity: l.quantity.toString(),
          uom: l.uom,
          site: l.deliverySiteId ? (siteOf.get(l.deliverySiteId) ?? null) : null,
          refUnitPrice: l.refUnitPriceSatang === null ? null : satangToAmount(l.refUnitPriceSatang),
          refSource: l.refSource,
          fromRequests: [...new Set(l.sources.flatMap((s) => (s.requestLine.request.number ? [s.requestLine.request.number] : [])))],
        })),
        invites: invites.map((i) => {
          const snap = (i.supplierSnapshot ?? {}) as Partial<SupplierSnapshot>
          return {
            id: i.id,
            owner: i.supplierId ? 'SUPPLIER' : 'APPLICATION',
            code: i.supplierId ? (codeOf.get(i.supplierId) ?? null) : null,
            name: snap.name ?? '',
            status: i.status,
            vatRegistered: snap.isVatRegistered ?? true,
            foreign: snap.isForeign ?? false,
            registryFlag: snap.registryFlag ?? null,
            documentsOk: snap.requiredDocumentsOk ?? null,
            risk: snap.risk ?? null,
          }
        }),
        supplierChoices: suppliers
          .filter((s) => !invited.has(s.id))
          .map((s) => ({
            id: s.id,
            code: s.code,
            name: s.nameTh,
            sameCategory: s.category === rfx.categoryCode,
            foreign: s.isForeign,
            refusal: s.registryFlag === 'CEASED' || s.registryFlag === 'VAT_CANCELLED' ? ('SUPPLIER_FLAGGED' as const) : !s.portalEnabled ? ('PORTAL_NOT_ENABLED' as const) : null,
          }))
          .sort((a, b) => Number(b.sameCategory) - Number(a.sameCategory) || a.code.localeCompare(b.code, 'en', { numeric: true })),
        applicationChoices: applications.filter((a) => !invited.has(a.id)).map((a) => ({ id: a.id, name: a.nameTh, status: a.status })),
        scorecard: card
          ? { status: card.status, criteria: card.criteria.map((c) => ({ ...c, kind: c.kind as 'PRICE' | 'QUALITY' })), evaluatorIds: card.evaluators.map((e) => e.memberId), minEvaluators: card.minEvaluators }
          : null,
        defaultWeights: weights,
        minEvaluators: settings.minEvaluators,
        memberChoices: members.map((m) => ({ id: m.id, name: { th: m.displayNameTh, en: m.displayNameEn }, conflict: creators.has(m.id) ? 'CREATOR' : requesters.has(m.id) ? 'REQUESTER' : null })),
        earliestCloseAt: earliest.toISOString(),
        openBusinessDays: settings.minOpenBusinessDays[kind],
        cutoffBusinessDays: settings.questionCutoffBusinessDays,
        schedule,
        vatInclusiveAllowed: settings.allowVatInclusiveBids,
        catalog: items.map((i) => ({ id: i.id, code: i.code, name: i.nameTh, uom: i.uom, refUnitPrice: i.refUnitPriceSatang > 0n ? satangToAmount(i.refUnitPriceSatang) : null })),
        canManage: true,
      },
    }
  })
}
