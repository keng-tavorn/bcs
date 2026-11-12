import { amountToSatang } from '@/core/money/dto'
import { formatScore, rfxDraftFromLines, type RfxDraftPlan } from '@/core/sourcing'
import { rateFor, taxDateOf } from '@/core/vat'
import type { Result } from '@/core/result'
import { sourcingSettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import type { TenantTx } from '@/server/db/tenant'
import { registerAssistSubject } from '../ai/assist-contract'
import { requireModule } from '../modules'
import { rfxReading } from './access'
import { bidSpread, type RfxBidFacts } from './bid-spread'
import { comparisonFacts, comparisonOf } from './comparison'
import { rankingOf } from './ranking'

// The RFx as the Sourcing Agent sees it (S10-16 · FR-AI-305 · BR-AI-31 BR-AI-32 · ADR-209). This file never calls the AI
// (INV-AI-05: src/server/services/sourcing does not import src/integrations/ai); the agent of the AI module asks it.
//
// RFX_DRAFT (L1): a draft RFx is a subject of the AI-assist contract. What the agent proposes goes into it only through
// rfx.update with aiAssist, by procurement (BR-AI-17): the kind (decided by code · rfxDraftFromLines · GC-AI-99), the
// title and description in Thai and English, and each line's English description and unit, at the paths below. A draft
// may keep fields waiting (final: false); rfx.open asks assertNoPendingAiReview (AI_REVIEW_PENDING).
//
// BID_SUMMARY NEGOTIATION_POINTS (L0): after the close only (sealed until then · BR-RFX-06), for a reader of the RFx's
// prices; the facts are comparisonFacts — numbers and codes, an individual by code, no supplier's free text or contact —
// with the spread and the incumbent's gap in bp of the lowest, and the scores once revealed.

export const RFX_ASSIST_TYPE = 'RFX_EVENT'
/** The paths of an RFx the agent may fill, a line by its number (lines.<lineNo>.descriptionEn) */
export const RFX_ASSIST_FIELDS = ['kind', 'title', 'titleEn', 'description', 'descriptionEn'] as const
/** Confirmed one by one (BR-AI-31): the kind and each line's English description */
export const isRfxRequiredPath = (path: string): boolean => path === 'kind' || /^lines\.\d+\.descriptionEn$/.test(path)

async function readRfxForAssist(tx: TenantTx, id: string): Promise<Readonly<Record<string, string>> | null> {
  const rfx = await tx.rfxEvent.findUnique({ where: { id }, select: { kind: true, title: true, titleEn: true, description: true, descriptionEn: true } })
  if (!rfx) return null
  const out: Record<string, string> = {}
  for (const field of RFX_ASSIST_FIELDS) {
    const value = rfx[field]
    if (value !== null && value !== '') out[field] = value
  }
  const lines = await tx.rfxLine.findMany({ where: { rfxEventId: id }, select: { lineNo: true, descriptionEn: true, uomEn: true } })
  for (const l of lines) {
    if (l.descriptionEn) out[`lines.${l.lineNo}.descriptionEn`] = l.descriptionEn
    if (l.uomEn) out[`lines.${l.lineNo}.uomEn`] = l.uomEn
  }
  return out
}

registerAssistSubject(RFX_ASSIST_TYPE, { purposes: ['RFX_DRAFT'], final: false, read: readRfxForAssist })

// ---------- RFX_DRAFT: what the agent reads, and the part code decides ----------

export interface RfxDraftSource {
  readonly rfxEventId: string
  readonly kind: 'RFQ' | 'RFP' | 'RFI'
  readonly categoryCode: string
  readonly lines: readonly { readonly lineNo: number; readonly description: string; readonly uom: string }[]
  /** Code's plan for the RFx's lines (one category, so one draft): the kind it would be and its minInvites */
  readonly plan: RfxDraftPlan | null
}

/**
 * A DRAFT RFx procurement may have drafted: module SOURCING, sourcing.manage, status DRAFT, one line at least. Nothing
 * of a supplier or a price goes to the agent; the reference prices only decide the kind, by code.
 */
export async function rfxDraftSource(tx: TenantTx, ctx: Ctx, rfxEventId: string): Promise<Result<RfxDraftSource>> {
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return on
  const may = await authorize(tx, ctx, 'sourcing.manage')
  if (!may.ok) return may
  const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, kind: true, status: true, categoryCode: true } })
  if (!rfx) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
  if (rfx.status !== 'DRAFT') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'only a draft RFx is drafted', details: { from: rfx.status, command: 'rfx.update' } } }
  const lines = await tx.rfxLine.findMany({ where: { rfxEventId }, orderBy: { lineNo: 'asc' }, select: { id: true, lineNo: true, description: true, uom: true, quantity: true, refUnitPriceSatang: true, catalogItemId: true } })
  if (lines.length === 0) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'an RFx is drafted from its lines', details: { field: 'rfxEventId', reason: 'NO_LINES' } } }
  const items = [...new Set(lines.map((l) => l.catalogItemId).filter((x): x is string => x !== null))]
  const service = new Set(items.length ? (await tx.catalogItem.findMany({ where: { id: { in: items }, isService: true }, select: { id: true } })).map((i) => i.id) : [])
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const settings = sourcingSettingsOf(org.settings)
  const rate = rateFor(taxDateOf(ctx.now), await listTaxRates())
  const plan = rate.ok
    ? rfxDraftFromLines(
        lines.map((l) => ({ ref: l.id, category: rfx.categoryCode, isService: l.catalogItemId !== null && service.has(l.catalogItemId), quantity: l.quantity.toString(), refUnitPriceSatang: l.refUnitPriceSatang })),
        rate.rateBp,
        { thresholdGrossSatang: amountToSatang(settings.minInvitesThresholdGross), minInvitesAboveThreshold: settings.minInvitesAboveThreshold },
      )[0] ?? null
    : null
  return { ok: true, data: { rfxEventId: rfx.id, kind: rfx.kind, categoryCode: rfx.categoryCode, lines: lines.map((l) => ({ lineNo: l.lineNo, description: l.description, uom: l.uom })), plan } }
}

// ---------- BID_SUMMARY NEGOTIATION_POINTS: the facts of the bids ----------

export { bidSpread, type RfxBidFacts } from './bid-spread'

/** The statuses after the close (BR-RFX-06: the envelope is open) */
const CLOSED_OR_LATER = new Set(['CLOSED', 'EVALUATING', 'AWARDED', 'CONCLUDED'])

/** The facts of an RFx's bids from code (BR-AI-32), for a reader of its prices (rfxReading) after the close */
export async function rfxBidFacts(tx: TenantTx, ctx: Ctx, rfxEventId: string, options: { readonly system?: boolean } = {}): Promise<Result<RfxBidFacts>> {
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return on
  const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, number: true, status: true, kind: true, scorecardId: true } })
  if (!rfx) return { ok: false, error: { code: 'NOT_FOUND', message: 'RFx not found' } }
  // the job of the system writes ahead for the readers; a member reads the prices or nothing (BR-RFX-16)
  if (!options.system) {
    const may = await rfxReading(tx, ctx, rfxEventId)
    if (!may.ok) return may
    if (may.data !== 'PRICES') return { ok: false, error: { code: 'FORBIDDEN', message: 'a requester sees the RFx, not its prices', details: { reason: 'PRICES' } } }
  }
  if (rfx.kind === 'RFI' || !CLOSED_OR_LATER.has(rfx.status)) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'the bids are summarized after the close', details: { from: rfx.status, command: 'rfx.summarize', reason: 'NOT_CLOSED' } } }
  const table = await comparisonOf(tx, ctx.organizationId, rfxEventId, ctx.now)
  if (!table || table.sealed) return { ok: false, error: { code: 'FORBIDDEN', message: 'sealed until the close', details: { reason: 'SEALED' } } }
  const facts = comparisonFacts(table)
  const { spreadBp, incumbent } = bidSpread(facts)
  let scores: RfxBidFacts['scores'] = []
  if (rfx.scorecardId) {
    const card = await tx.scorecard.findUnique({ where: { id: rfx.scorecardId }, select: { status: true } })
    if (card?.status === 'REVEALED') {
      const ranking = await rankingOf(tx, rfx.scorecardId)
      const codeOf = new Map(table.bids.map((b) => [b.bidId, b.supplierCode]))
      scores = ranking.rows.map((r) => ({ supplierCode: codeOf.get(r.bidId) ?? '', rank: r.rank, total: formatScore(r.totalBp), criteria: Object.fromEntries(Object.entries(r.criteria).map(([code, bp]) => [code, formatScore(bp)])) }))
    }
  }
  return { ok: true, data: { rfxEventId, number: rfx.number, status: rfx.status, table: facts, spreadBp, incumbent, scores } }
}

/** Whether the RFx is past its close and priced (the buttons BID_SUMMARY NEGOTIATION_POINTS show then only) */
export const rfxSummarizable = (rfx: { readonly kind: string; readonly status: string }): boolean => rfx.kind !== 'RFI' && CLOSED_OR_LATER.has(rfx.status)
