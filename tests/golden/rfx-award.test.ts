import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import type { BusinessCalendar } from '@/core/sla'
import {
  awardAmount,
  bidValidUntil,
  confirmedNetPriceCap,
  cycleMedianDays,
  earliestCloseAt,
  formatTenths,
  isBidExpired,
  isLateBid,
  minInvites,
  preferredInEffect,
  preferredWindow,
  priceAnomalyFlags,
  questionCutoffAt,
  savings,
  savingsTotal,
  scorecardReveal,
  validateCloseAt,
  type BaselinePart,
  type EvaluatorStatus,
  type PriceRefSource,
  type RfxKind,
  type SourcingTimeSettings,
} from '@/core/sourcing'
import { loadYaml } from './doa-fixtures'

// tests/golden/rfx-award.yaml (spec §7.23 · S10-03): GC-SRC-15 to 36 and 38 to 41, the times of an RFx on the business
// calendar, the award's amount, G-8, the preferred supplier's period, price flags, a bid's validity and the price cap of
// a bid with VAT (BR-RFX-01 BR-RFX-02 BR-RFX-07 BR-RFX-11 to BR-RFX-15). A supplier not registered for VAT is at rate 0.

interface Suite {
  vatRateBp: number
  calendar: BusinessCalendar
  settings: SourcingTimeSettings & { priceAnomalyBp: number }
  cases: Array<{ id: string; title: string; fn: string; input: Record<string, unknown>; expect: unknown }>
}

const suite = loadYaml<Suite>('rfx-award.yaml')
const cal = suite.calendar
const st = suite.settings
const money = (s: bigint) => satangToAmount(s)
const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z')
const minDays = (i: Record<string, unknown>) => (i.minOpenBusinessDays as number | undefined) ?? st.minOpenBusinessDays[i.kind as RfxKind]

function run(fn: string, i: Record<string, unknown>): unknown {
  switch (fn) {
    case 'earliestCloseAt':
      return iso(earliestCloseAt(new Date(i.openedAt as string), minDays(i), cal))
    case 'validateCloseAt':
      return (i.closesAt as string[]).map((at) => {
        const r = validateCloseAt(new Date(i.openedAt as string), new Date(at), minDays(i), cal)
        return r.ok ? { ok: true } : { ok: false, error: r.error.code, reason: r.error.details?.reason, earliest: iso(new Date(r.error.details?.earliest as string)) }
      })
    case 'questionCutoffAt':
      return iso(questionCutoffAt(new Date(i.closesAt as string), st.questionCutoffBusinessDays, cal))
    case 'isLateBid':
      return (i.submittedAt as string[]).map((at) => isLateBid(new Date(at), new Date(i.closesAt as string)))
    case 'minInvites':
      return (i.estimatedNets as string[]).map((n) => {
        const r = minInvites(amountToSatang(n), suite.vatRateBp, { thresholdGrossSatang: amountToSatang(i.thresholdGross as string), minInvitesAboveThreshold: i.minInvitesAboveThreshold as number })
        return { estimatedGross: money(r.estimatedGross), minInvites: r.minInvites }
      })
    case 'awardAmount': {
      const lines = i.lines as Array<{ ref: string; supplier: string; quantity: string; unitPrice: string; vatRegistered: boolean }>
      const r = awardAmount(lines.map((l) => ({ ref: l.ref, supplierId: l.supplier, quantity: l.quantity, unitPriceSatang: amountToSatang(l.unitPrice), vatRateBp: l.vatRegistered ? suite.vatRateBp : 0 })))
      return { net: money(r.net), vat: money(r.vat), gross: money(r.gross), isSplit: r.isSplit, perSupplier: Object.fromEntries(r.perSupplier.map((s) => [s.supplierId, { net: money(s.net), vat: money(s.vat) }])) }
    }
    case 'savings': {
      const parts = (i.baseline as Array<{ kind: 'QUOTATION' | 'ESTIMATE'; net?: string; gross?: string; includesVat?: boolean }>).map(
        (p): BaselinePart => (p.includesVat ? { kind: 'QUOTATION', grossSatang: amountToSatang(p.gross!), includesVat: true } : { kind: p.kind, netSatang: amountToSatang(p.net!) }),
      )
      const r = savings(parts, amountToSatang(i.awardedNet as string), suite.vatRateBp)
      return { baselineNet: money(r.baselineNet), baselineKind: r.baselineKind, savings: money(r.savings), savingsBp: r.savingsBp }
    }
    case 'savingsTotal': {
      const r = savingsTotal((i.items as Array<{ baselineNet: string; savings: string }>).map((x) => ({ baselineNet: amountToSatang(x.baselineNet), savings: amountToSatang(x.savings) })))
      return { baselineNet: money(r.baselineNet), savings: money(r.savings), savingsBp: r.savingsBp }
    }
    case 'cycleMedianDays': {
      const r = cycleMedianDays((i.awards as Array<{ openedAt: string; decidedAt: string }>).map((a) => ({ openedAt: new Date(a.openedAt), decidedAt: new Date(a.decidedAt) })), cal)
      return { days: r.days.map(formatTenths), median: r.median === null ? null : formatTenths(r.median) }
    }
    case 'preferredWindow': {
      const w = preferredWindow(new Date(i.approvedAt as string), st.preferredSupplierDays)
      return { ...w, inEffect: (i.checkDays as string[]).map((d) => preferredInEffect(w, d)) }
    }
    case 'priceAnomalyFlags': {
      const prices = Object.entries(i.unitPrices as Record<string, string>).map(([k, v]) => [k, { unitPriceSatang: amountToSatang(v) }] as const)
      const r = priceAnomalyFlags({ unitPriceSatang: amountToSatang(i.ref as string), source: i.refSource as PriceRefSource }, prices, st.priceAnomalyBp)
      return Object.fromEntries(r.map(([k, c]) => [k, { deviationBp: c.deviationBp, flag: c.flag }]))
    }
    case 'bidValidUntil': {
      const validUntil = bidValidUntil(new Date(i.submittedAt as string), st.bidValidityDays)
      return { validUntil, expired: (i.checkDays as string[]).map((d) => isBidExpired(validUntil, d)) }
    }
    case 'scorecardReveal':
      return scorecardReveal(
        i.minEvaluators as number,
        (i.evaluators as Array<{ member: string; status: EvaluatorStatus }>).map((e) => ({ memberId: e.member, status: e.status })),
      )
    case 'confirmedNetPriceCap':
      return (i.confirmedNetUnitPrices as string[]).map((p) =>
        confirmedNetPriceCap(i.vatRateBp as number, amountToSatang(i.quotedUnitPrice as string), amountToSatang(p)) ? { ok: true } : { ok: false, error: 'AWARD_PRICE_EXCEEDS_BID' },
      )
    default:
      throw new Error(`unknown fn ${fn}`)
  }
}

const IDS = [15, 16, 17, 18, 19, 20, 35, 36, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 38, 39, 40, 41].map((n) => `GC-SRC-${n}`)

describe('golden rfx-award.yaml', () => {
  it('has the cases of S10-03', () => expect(suite.cases.map((c) => c.id)).toEqual(IDS))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => expect(run(c.fn, c.input)).toEqual(c.expect))
  }
})
