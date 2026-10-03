import { latestSlot, localDay, parseCron } from '@/core/schedule'
import { MS_PER_DAY, MS_PER_MINUTE } from '@/lib/constants'
import { OrgSettingsSchema } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { isUuid, membersById, type MemberRefDto } from './requests'

// Read-only data of the procurement pool screen (spec §9.1 /procurement/pool, FR-P2P-001, FR-P2P-002): the suppliers
// and delivery sites to choose and filter by, when the next automatic consolidation round runs (settings
// consolidation.cron, OQ-13: business days only), the rounds that ran last and the draft POs each made. Queries never
// check permissions: the page reads the pool through listPool (procurement.pool.view) first, and only then these.

export interface OptionDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
}

/** Active suppliers and delivery sites, by code (the supplier to choose for pool lines, the filters) */
export async function poolOptions(ctx: Ctx): Promise<{ readonly suppliers: readonly OptionDto[]; readonly sites: readonly OptionDto[] }> {
  const db = forTenant(ctx.organizationId)
  const [suppliers, sites] = await Promise.all([
    db.supplier.findMany({ where: { status: 'ACTIVE' }, select: { id: true, code: true, nameTh: true }, orderBy: { code: 'asc' } }),
    db.deliverySite.findMany({ where: { active: true }, select: { id: true, code: true, nameTh: true }, orderBy: { code: 'asc' } }),
  ])
  return { suppliers, sites }
}

/** How far ahead the next round is looked for, in days: a week and a day covers a business-day cron across a long holiday */
const LOOK_AHEAD_DAYS = 8
const LOOK_AHEAD_MINUTES = (LOOK_AHEAD_DAYS * MS_PER_DAY) / MS_PER_MINUTE
const RECENT_ROUNDS = 5

export type NextRoundDto =
  | { readonly kind: 'AT'; readonly at: Date }
  /** settings.consolidation.cron cannot be read: no automatic round runs until an administrator fixes it */
  | { readonly kind: 'CRON_INVALID' }
  /** Nothing within the look-ahead (a cron that names no business day soon) */
  | { readonly kind: 'NONE' }

export interface RoundDto {
  readonly id: string
  readonly trigger: 'SCHEDULED' | 'MANUAL' | 'URGENT'
  readonly ranAt: Date
  readonly scheduledFor: Date | null
  readonly by: MemberRefDto | null
  /** The POs it drafted, with what tells two drafts of one supplier apart: the site and the kind */
  readonly drafts: ReadonlyArray<{ readonly id: string; readonly number: string | null; readonly status: string; readonly supplierName: string; readonly siteName: string | null; readonly kind: 'GOODS' | 'SERVICE' }>
}

/**
 * The next automatic round (the first whole minute after `now` that the organization's cron names, on a day that is not
 * a holiday of its calendar — the job skips holidays, FR-P2P-002 AC2) and the latest rounds with the POs they drafted.
 */
export async function consolidationSchedule(ctx: Ctx): Promise<{ readonly next: NextRoundDto; readonly recent: readonly RoundDto[] }> {
  const db = forTenant(ctx.organizationId)
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const parsed = OrgSettingsSchema.shape.consolidation.safeParse((org.settings as { consolidation?: unknown } | null)?.consolidation)
  const cron = parsed.success ? parseCron(parsed.data.cron) : null

  let next: NextRoundDto = cron ? { kind: 'NONE' } : { kind: 'CRON_INVALID' }
  if (cron) {
    const holidays = new Set((await db.holiday.findMany({ where: { date: { gte: new Date(ctx.now.getTime() - MS_PER_DAY) } }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)))
    const start = Math.floor(ctx.now.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE
    for (let i = 1; i <= LOOK_AHEAD_MINUTES; i++) {
      const candidate = new Date(start + i * MS_PER_MINUTE)
      // latestSlot with no look-back answers "does the cron name this very minute?"
      if (latestSlot(cron, candidate, null, 0)?.getTime() === candidate.getTime() && !holidays.has(localDay(cron, candidate))) {
        next = { kind: 'AT', at: candidate }
        break
      }
    }
  }

  const runs = await db.consolidationRun.findMany({ orderBy: [{ ranAt: 'desc' }, { id: 'desc' }], take: RECENT_ROUNDS, select: { id: true, trigger: true, ranAt: true, scheduledFor: true, triggeredById: true, createdPoIds: true } })
  const poIds = [...new Set(runs.flatMap((r) => r.createdPoIds))]
  const [pos, members] = await Promise.all([
    poIds.length
      ? db.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, number: true, status: true, kind: true, supplier: { select: { nameTh: true } }, deliverySite: { select: { nameTh: true } } } })
      : Promise.resolve([]),
    membersById(
      db,
      runs.map((r) => r.triggeredById),
    ),
  ])
  const poOf = new Map(pos.map((p) => [p.id, p]))
  return {
    next,
    recent: runs.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      ranAt: r.ranAt,
      scheduledFor: r.scheduledFor,
      by: r.triggeredById ? (members.get(r.triggeredById) ?? null) : null,
      drafts: r.createdPoIds.flatMap((id) => {
        const p = poOf.get(id)
        return p ? [{ id: p.id, number: p.number, status: p.status, supplierName: p.supplier.nameTh, siteName: p.deliverySite?.nameTh ?? null, kind: p.kind }] : []
      }),
    })),
  }
}

export interface DraftMadeDto {
  readonly id: string
  readonly supplierName: string
  readonly siteName: string | null
  readonly kind: 'GOODS' | 'SERVICE'
  readonly urgency: 'NORMAL' | 'URGENT'
  readonly lineCount: number
  readonly netSatang: bigint
  readonly requestNumbers: readonly string[]
}

/** The draft POs a round (or an urgent supplier choice) made, as the pool shows them after "รวมเป็นร่าง PO ตอนนี้" */
export async function draftsMade(ctx: Ctx, purchaseOrderIds: readonly string[]): Promise<DraftMadeDto[]> {
  const ids = purchaseOrderIds.filter(isUuid)
  if (ids.length === 0) return []
  const db = forTenant(ctx.organizationId)
  const pos = await db.purchaseOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      urgency: true,
      netSatang: true,
      supplier: { select: { nameTh: true } },
      deliverySite: { select: { nameTh: true } },
      lines: { select: { sources: { select: { requestLine: { select: { request: { select: { number: true } } } } } } } },
    },
  })
  const order = new Map(ids.map((id, i) => [id, i]))
  return pos
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    .map((p) => ({
      id: p.id,
      supplierName: p.supplier.nameTh,
      siteName: p.deliverySite?.nameTh ?? null,
      kind: p.kind,
      urgency: p.urgency,
      lineCount: p.lines.length,
      netSatang: p.netSatang,
      requestNumbers: [...new Set(p.lines.flatMap((l) => l.sources.map((s) => s.requestLine.request.number)).filter((n): n is string => Boolean(n)))].sort((a, b) =>
        a.localeCompare(b, 'en', { numeric: true }),
      ),
    }))
}
