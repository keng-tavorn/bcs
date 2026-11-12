import { describe, expect, it } from 'vitest'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { rfxDraftFromLines } from '@/core/sourcing'
import { loadGolden } from './support'

// tests/golden/ai-rfx-draft.yaml (spec §12.6 · BR-AI-31 · S10-16): what code decides of a draft RFx before the Sourcing
// Agent writes its words — one draft per category, its kind, its estimate and minInvites.

interface Input {
  vatRateBp: number
  minInvitesThresholdGross: string
  minInvitesAboveThreshold: number
  lines: Array<{ ref: string; category: string; isService: boolean; quantity: string; refUnitPrice: string | null }>
}

describe('[BR-AI-31] golden ai-rfx-draft.yaml', () => {
  const suite = loadGolden('ai-rfx-draft') as unknown as { cases: Array<{ id: string; title?: string; input: Input; expect: unknown }> }
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const drafts = rfxDraftFromLines(
        c.input.lines.map((l) => ({ ref: l.ref, category: l.category, isService: l.isService, quantity: l.quantity, refUnitPriceSatang: l.refUnitPrice === null ? null : amountToSatang(l.refUnitPrice) })),
        c.input.vatRateBp,
        { thresholdGrossSatang: amountToSatang(c.input.minInvitesThresholdGross), minInvitesAboveThreshold: c.input.minInvitesAboveThreshold },
      )
      expect({
        drafts: drafts.map((d) => ({ category: d.category, kind: d.kind, lines: d.lines, estimatedNet: satangToAmount(d.estimatedNetSatang), estimatedGross: satangToAmount(d.estimatedGrossSatang), minInvites: d.minInvites })),
      }).toEqual(c.expect)
    })
  }
})
