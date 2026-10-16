import type { getTranslations } from 'next-intl/server'
import type { TransferDto } from '@/server/services/budget/transfer-view'

// Turns a budget transfer (TransferDto) into the words of its screens (S6-15 · FR-BUD-103): its label — the BT number,
// or "ร่าง" while it has none — and where the money goes, "จาก FIN-OPEX ไป CON-OPEX" in words, never an arrow (§9.9).

export type TransferT = Awaited<ReturnType<typeof getTranslations<'budgetTransfer'>>>

type LineRef = TransferDto['from']

export const lineText = (l: NonNullable<LineRef>): string => `${l.code} · ${l.nameTh}`

/** The number, or the words of a draft that has none yet */
export const transferLabel = (t: TransferT, d: Pick<TransferDto, 'number'>): string => d.number ?? t('list.draft')

/** Where the money goes: from a line to another, or the one line of an adjustment */
export function routeText(t: TransferT, d: Pick<TransferDto, 'from' | 'to'>, text: (l: NonNullable<LineRef>) => string = (l) => l.code): string {
  if (d.from && d.to) return t('list.fromTo', { from: text(d.from), to: text(d.to) })
  if (d.from) return t('list.from', { from: text(d.from) })
  if (d.to) return t('list.to', { to: text(d.to) })
  return ''
}
