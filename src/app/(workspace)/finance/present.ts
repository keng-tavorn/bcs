import type { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import type { Satang } from '@/core/money/math'
import type { RecordedInvoiceDto } from '@/server/queries/finance'
import type { NameDto } from '@/server/queries/requests'
import type { BudgetLineRefDto, InvoicePreviewDto, InvoicePoViewDto } from '@/server/services/invoices/view'
import type { InvoiceStateKind } from '@/ui/finance/invoice-list'
import type { BudgetMoveView, GiveBackView, InvoicePartView, InvoicePreviewView } from '@/ui/finance/types'
import { formatTaxId } from '@/ui/suppliers/model'
import { day, when, type Locale } from '../_tracking/present'

// Turns the finance services' read models into what the finance components show (S4-08, S4-17, S4-09): money as BigInt
// satang formatted with thousands separators and two decimals (FR-PLT-002 AC3), dates in the reader's language, names
// in the reader's language when the organization gave one — plain JSON a server action can hand to the browser.

export type FinanceT = Awaited<ReturnType<typeof getTranslations<'finance'>>>

export const money = (satang: Satang): string => formatSatang(satang)

/** An invoice's states in words with an icon each: last of its PO, where its values came from, exported or not */
export function invoiceStates(t: FinanceT, locale: Locale, inv: RecordedInvoiceDto): Array<{ kind: InvoiceStateKind; text: string }> {
  return [
    ...(inv.isFinal ? [{ kind: 'final' as const, text: t('invoiceState.final') }] : []),
    inv.parsedFrom === 'ETAX_XML' ? { kind: 'etax' as const, text: t('invoiceState.etax') } : { kind: 'typed' as const, text: t('invoiceState.typed') },
    inv.exportedAt ? { kind: 'exported' as const, text: t('invoiceState.exported', { time: when(locale, inv.exportedAt) }) } : { kind: 'notExported' as const, text: t('invoiceState.notExported') },
  ]
}
/** "6000.00" (an amount of a service error) → "6,000.00"; anything else as it is */
export const amountText = (amount: string | undefined): string | undefined => {
  if (amount === undefined) return undefined
  try {
    return formatSatang(amountToSatang(amount))
  } catch {
    return amount
  }
}
export const nameIn = (locale: Locale, name: NameDto): string => (locale === 'en' && name.en ? name.en : name.th)
export const budgetLineText = (line: BudgetLineRefDto): string => `${line.code} · ${line.name}`

/** A VAT rate in basis points as a percentage: 700 → "7", 750 → "7.5" */
export function vatRateText(rateBp: number | null): string | null {
  if (rateBp === null) return null
  const whole = Math.trunc(rateBp / 100)
  const rest = rateBp % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}

/** "0-9999-99000-01-2" or the raw value when it is not a Thai tax id */
export const taxIdText = (taxId: string | null): string | null => (taxId ? formatTaxId(taxId) : null)

export function movesOf(parts: ReadonlyArray<{ readonly budgetLine: BudgetLineRefDto; readonly netSatang: Satang }>): BudgetMoveView[] {
  const byLine = new Map<string, { line: BudgetLineRefDto; total: Satang }>()
  for (const p of parts) byLine.set(p.budgetLine.id, { line: p.budgetLine, total: (byLine.get(p.budgetLine.id)?.total ?? 0n) + p.netSatang })
  return [...byLine.values()].map((m) => ({ budgetLineId: m.line.id, budgetLine: budgetLineText(m.line), amount: money(m.total) }))
}

export function giveBackView(giveBack: { readonly when: 'NOW' | 'ON_CLOSE'; readonly amountSatang: Satang; readonly unsettledLines: number } | null): GiveBackView | null {
  return giveBack ? { when: giveBack.when, amount: money(giveBack.amountSatang), unsettledLines: giveBack.unsettledLines } : null
}

export function previewView(p: InvoicePreviewDto, locale: Locale): InvoicePreviewView {
  return {
    invoiceNo: p.invoiceNo,
    invoiceDate: day(locale, p.invoiceDate),
    net: money(p.netSatang),
    vat: money(p.vatSatang),
    gross: money(p.grossSatang),
    vatRate: vatRateText(p.vatRateBp),
    expectedVat: money(p.expectedVatSatang),
    vatWarning: p.vatWarning,
    parts: p.parts.map((part): InvoicePartView => ({ poLineId: part.poLineId, description: part.description, budgetLine: budgetLineText(part.budgetLine), amount: money(part.netSatang) })),
    moves: p.byBudgetLine.map((m) => ({ budgetLineId: m.budgetLine.id, budgetLine: budgetLineText(m.budgetLine), amount: money(m.netSatang) })),
    heldBefore: money(p.heldBeforeSatang),
    heldAfter: money(p.heldAfterSatang),
    isFinal: p.isFinal,
    giveBack: giveBackView(p.giveBack),
    source: p.source.parsedFrom,
    withFile: p.source.withFile,
  }
}

/** The parts of a recorded invoice, named by the PO's lines */
export function partsOf(po: InvoicePoViewDto, allocation: ReadonlyArray<{ readonly poLineId: string; readonly netSatang: Satang }>): Array<InvoicePartView & { readonly budgetLineRef: BudgetLineRefDto; readonly netSatang: Satang }> {
  return allocation.flatMap((a) => {
    const line = po.lines.find((l) => l.id === a.poLineId)
    return line ? [{ poLineId: a.poLineId, description: line.description, budgetLine: budgetLineText(line.budgetLine), amount: money(a.netSatang), budgetLineRef: line.budgetLine, netSatang: a.netSatang }] : []
  })
}
