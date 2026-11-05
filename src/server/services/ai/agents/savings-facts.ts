import { renderValue, type TextValue } from '@/core/ai-checks'
import { satangToAmount } from '@/core/money/dto'
import { savingsNoteInputText } from '@/lib/ai-schemas/agents'
import { MS_PER_DAY } from '@/lib/constants'
import type { SavingsItemDto } from '../../assistants/savings'
import { asDataValues } from '../data'

// The facts of one saving the AI explains (NEW-136 · ADR-084 item 5), by code and without the database, so the agent and
// the evaluation set (`pnpm ai:eval --agent insight`) give Claude exactly the same text for the same saving.

export type SavingsFacts = Readonly<Record<string, TextValue>>

const money = (satang: string): TextValue => ({ kind: 'money', value: satangToAmount(BigInt(satang)) })
const text = (value: string): TextValue => ({ kind: 'text', value })
const integer = (value: number): TextValue => ({ kind: 'integer', value })

/** The facts of one saving, by code (BR-AI-03): the AI writes placeholders of these keys only, in Thai */
export function savingsFacts(item: SavingsItemDto): SavingsFacts {
  switch (item.kind) {
    case 'PRICE_ABOVE_HISTORY':
      return {
        kind: { kind: 'enum', value: item.kind },
        stage: { kind: 'enum', value: item.line.request.stage },
        request: { kind: 'ref', value: item.line.request.number },
        line: integer(item.line.lineNo),
        description: text(item.line.description),
        quantity: text(`${item.line.quantity} ${item.line.uom}`),
        price: money(item.line.unitPriceSatang),
        reference: money(item.referenceSatang),
        lowest: money(item.minSatang),
        highest: money(item.maxSatang),
        deviation: { kind: 'bp', value: item.deviationBp },
        samples: integer(item.count),
        saving: money(item.savingSatang),
      }
    case 'OFF_AGREEMENT':
      return {
        kind: { kind: 'enum', value: item.kind },
        stage: { kind: 'enum', value: item.line.request.stage },
        request: { kind: 'ref', value: item.line.request.number },
        line: integer(item.line.lineNo),
        item: text(item.item.th),
        quantity: text(`${item.line.quantity} ${item.line.uom}`),
        price: money(item.line.unitPriceSatang),
        supplier: item.line.supplier ? text(item.line.supplier.th) : { kind: 'enum', value: 'NONE' },
        agreed: money(item.agreedSatang),
        agreedSupplier: text(item.agreements.find((a) => a.id === item.agreementId)?.supplier.th ?? ''),
        agreements: integer(item.agreements.length),
        ...(item.offAgreementReason ? { reason: text(item.offAgreementReason) } : {}),
        saving: money(item.savingSatang),
      }
    case 'SAME_ITEM_DEPARTMENTS':
      return {
        kind: { kind: 'enum', value: item.kind },
        description: text(item.description),
        departments: integer(item.departments),
        lines: integer(item.lines.length),
        lowest: money(item.lowestSatang),
        ...(item.site ? { site: text(item.site.th) } : {}),
        saving: money(item.savingSatang),
      }
    case 'AGREEMENT_EXPIRING':
      return {
        kind: { kind: 'enum', value: item.kind },
        item: text(item.item.th),
        supplier: text(item.agreement.supplier.th),
        price: money(item.agreement.unitPriceSatang),
        // the last day the price holds (validTo is not included, BR-PRC-06)
        lastDay: { kind: 'date', value: new Date(Date.parse(`${item.agreement.validTo}T00:00:00Z`) - MS_PER_DAY).toISOString().slice(0, 10) },
        daysLeft: integer(item.daysLeft),
        purchases: integer(item.count),
        spent: money(item.spentSatang),
      }
  }
}

/** The fact the explanation must name: the amount the code calculated (the spend when an agreement only ends) */
export const amountFactOf = (item: Pick<SavingsItemDto, 'kind'>): 'saving' | 'spent' => (item.kind === 'AGREEMENT_EXPIRING' ? 'spent' : 'saving')

/** The text the AI reads: each key with its value as the page shows it, written by others so fenced as data (BR-AI-18) */
export const savingsNoteText = (facts: SavingsFacts): string =>
  savingsNoteInputText(asDataValues(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))))
