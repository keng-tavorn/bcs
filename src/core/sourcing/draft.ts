import { lineNet, type Satang } from '../money/math'
import { minInvites } from './award'

// The parts of a draft RFx that code decides, never the AI (BR-AI-31 · BR-AI-03 · GC-AI-99): lines of a pool are split into
// one draft per category (an RFx takes one category · BR-RFX-01), in the order the categories first appear; a draft is an
// RFQ when every line is goods with a reference price, else an RFP (a service, or goods nobody priced yet, is asked for a
// proposal); its estimate before VAT is Σ quantity × reference price, and minInvites follows BR-RFX-01. The Sourcing
// Agent only writes the words of each draft.

export interface DraftLineInput {
  readonly ref: string
  readonly category: string
  readonly isService: boolean
  readonly quantity: string
  /** The reference price before VAT, or null when there is none */
  readonly refUnitPriceSatang: Satang | null
}

export interface RfxDraftPlan {
  readonly category: string
  readonly kind: 'RFQ' | 'RFP'
  readonly lines: readonly string[]
  readonly estimatedNetSatang: Satang
  readonly estimatedGrossSatang: Satang
  readonly minInvites: number
}

export function rfxDraftFromLines(
  lines: readonly DraftLineInput[],
  vatRateBp: number,
  settings: { readonly thresholdGrossSatang: Satang; readonly minInvitesAboveThreshold: number },
): RfxDraftPlan[] {
  const byCategory = new Map<string, DraftLineInput[]>()
  for (const l of lines) byCategory.set(l.category, [...(byCategory.get(l.category) ?? []), l])
  return [...byCategory].map(([category, group]) => {
    const net = group.reduce((sum, l) => sum + (l.refUnitPriceSatang === null ? 0n : lineNet(l.quantity, l.refUnitPriceSatang)), 0n)
    const rfq = group.every((l) => !l.isService && l.refUnitPriceSatang !== null && l.refUnitPriceSatang > 0n)
    const invites = minInvites(net, vatRateBp, settings)
    return { category, kind: rfq ? 'RFQ' : 'RFP', lines: group.map((l) => l.ref), estimatedNetSatang: net, estimatedGrossSatang: invites.estimatedGross, minInvites: invites.minInvites }
  })
}
