import { evaluateCondition, type Condition } from '../forms'
import { amountToSatang } from '../money/dto'

// The purchase channel the Intake Agent suggests, computed by code, never by the AI (BR-AI-19, golden ai-intake-channel,
// FR-INT-101 FR-INT-102): CATALOG when every line is a catalogue item with a price agreement in force on the day
// (validFrom inclusive, validTo exclusive); otherwise REORDER when every line is an item the requester themself asked
// for within the lookback (their own requests only: another member's never count and are never named); otherwise
// STANDARD, with the attachment rules the amount brings (BR-FORM-04).

export interface ChannelAgreement {
  readonly supplier: string
  readonly unitPrice: string
  /** YYYY-MM-DD, first day */
  readonly validFrom: string
  /** YYYY-MM-DD, the day it no longer applies; null = open-ended */
  readonly validTo: string | null
}

export interface ChannelContext {
  /** The Thai date the suggestion is for (YYYY-MM-DD) */
  readonly asOf: string
  readonly rules: readonly { readonly id: string; readonly when: Condition }[]
  readonly catalog: readonly { readonly itemCode: string; readonly agreements: readonly ChannelAgreement[] }[]
  /** The requester's own requests: an item they asked for, the request's number and how many days ago */
  readonly pastRequests: readonly { readonly itemCode: string; readonly number: string; readonly daysAgo: number }[]
  readonly reorderLookbackDays: number
}

export interface ChannelSuggestion {
  readonly channel: 'CATALOG' | 'REORDER' | 'STANDARD'
  /** REORDER: the requester's most recent request with these items */
  readonly reorderFrom?: string
  /** STANDARD: the attachment rules the amount brings */
  readonly requiredRules: readonly string[]
}

const inForce = (a: ChannelAgreement, day: string) => a.validFrom <= day && (a.validTo === null || day < a.validTo)

export function suggestChannel(input: { readonly lines: readonly { readonly itemCode: string | null }[]; readonly amountGross: string }, ctx: ChannelContext): ChannelSuggestion {
  const codes = input.lines.map((l) => l.itemCode)
  const known = codes.length > 0 && codes.every((c): c is string => c !== null)
  if (known && codes.every((c) => ctx.catalog.some((i) => i.itemCode === c && i.agreements.some((a) => inForce(a, ctx.asOf))))) return { channel: 'CATALOG', requiredRules: [] }
  const recent = ctx.pastRequests.filter((p) => p.daysAgo <= ctx.reorderLookbackDays)
  if (known && codes.every((c) => recent.some((p) => p.itemCode === c))) {
    const latest = [...recent].filter((p) => codes.includes(p.itemCode)).sort((a, b) => a.daysAgo - b.daysAgo)[0]!
    return { channel: 'REORDER', reorderFrom: latest.number, requiredRules: [] }
  }
  const gross = amountToSatang(input.amountGross)
  const form = { fields: {}, attachments: {}, variables: { $amountGross: gross, $amountNet: gross, $requestType: '' } }
  return { channel: 'STANDARD', requiredRules: ctx.rules.filter((r) => evaluateCondition(r.when, form)).map((r) => r.id) }
}
