import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fieldScore } from '@/core/ai-checks'
import { fixtureKey } from '@/integrations/ai'
import { PROMPTS } from '@/integrations/ai/prompts'
import { AWAITING_EVALUATION, EVAL_GATES, modelForPurpose, PROMPT_VERSIONS, type AiPurposeName } from '@/lib/ai-config'
import { BriefText, RfxDraftText } from '@/lib/ai-schemas/agents'
import { AI_ANSWERS_DIR, ROOT } from '../../scripts/lib/ai-eval-cases'
import {
  draftHeadFilled,
  englishDescriptionCorrect,
  englishUnitCorrect,
  inventedNumbers,
  loadSourcingCases,
  scoreSummary,
  SOURCING_CASES_FILE,
  SOURCING_FLOORS,
  truthDraft,
  truthSummary,
  type SourcingCase,
} from '../../scripts/ai-eval-sourcing'

// S10-19 (FR-AI-305 AC5 · OQ-209): the evaluation set of the Sourcing Agent, demo tier — 10 synthetic RFx (6 RFQ, 4 RFP)
// whose texts are the ones the app sends (rfxDraftInputText, sourcingFacts over compareBids priceAnomaly bidSpread), each
// with the answers Claude gave when the gated prompts and model ran on the real API (recorded LIVE), and those answers
// meet every floor of OQ-209: the gates of src/lib/ai-config.ts name a report that is in the repository.

const cases = loadSourcingCases()
const PURPOSES = ['RFX_DRAFT', 'BID_SUMMARY', 'NEGOTIATION_POINTS'] as const satisfies readonly AiPurposeName[]

function answerOf(purpose: AiPurposeName, text: string): { promptVersion: string; model: string; recorded?: string; output: unknown } | null {
  const file = path.join(AI_ANSWERS_DIR, `${fixtureKey({ purpose, text })}.json`)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { promptVersion: string; model: string; recorded?: string; output: unknown }) : null
}

/** Adds up a metric the way pnpm ai:eval does, and says whether it meets its floor */
class Floors {
  private readonly t = new Map<string, { correct: number; total: number; threshold: number }>()
  add(key: string, field: keyof typeof SOURCING_FLOORS, ok: boolean) {
    const x = this.t.get(key) ?? { correct: 0, total: 0, threshold: SOURCING_FLOORS[field] }
    x.total++
    if (ok) x.correct++
    this.t.set(key, x)
  }
  expectAllPass() {
    expect(this.t.size).toBeGreaterThan(0)
    for (const [key, x] of this.t) expect(fieldScore({ correct: x.correct, total: x.total, thresholdBp: x.threshold, missed: 0, critical: false }).pass, `${key}: ${x.correct}/${x.total}`).toBe(true)
  }
}

describe('[FR-AI-305/AC5] the evaluation set of the Sourcing Agent, demo tier', () => {
  it('[FR-AI-305/AC5] holds 10 synthetic RFx, 6 RFQ and 4 RFP, with bids with VAT, from suppliers not registered, partial, from abroad, an individual and price flags', () => {
    expect(cases).toHaveLength(10)
    expect(new Set(cases.map((c) => c.id)).size).toBe(10)
    expect(cases.filter((c) => c.expect.kind === 'RFQ')).toHaveLength(6)
    expect(cases.filter((c) => c.expect.kind === 'RFP')).toHaveLength(4)
    const bids = cases.flatMap((c) => c.bids)
    expect(bids.filter((b) => b.priceIncludesVat).length).toBeGreaterThanOrEqual(3)
    expect(bids.filter((b) => b.vatRegistered === false).length).toBeGreaterThanOrEqual(3)
    expect(bids.some((b) => b.foreign)).toBe(true)
    expect(bids.some((b) => b.individual)).toBe(true)
    expect(cases.filter((c) => c.bids.some((b) => Object.values(b.prices).includes(null))).length).toBeGreaterThanOrEqual(2)
    const flags = cases.flatMap((c) => c.expectFlags)
    expect(new Set(flags.map((f) => f.flag))).toEqual(new Set(['ABOVE_AGREEMENT', 'HIGH', 'LOW']))
    // a set with no flag shows a summary is not scored on flags it does not have
    expect(cases.some((c) => c.expectFlags.length === 0)).toBe(true)
  })

  it('[FR-AI-305/AC5] code works out the flags a person worked out by hand, and a case that disagrees is refused', () => {
    for (const c of cases) {
      const coded = c.facts.flagCount
      expect(coded, c.id).toEqual({ kind: 'integer', value: c.expectFlags.length })
    }
    const raw = readFileSync(SOURCING_CASES_FILE, 'utf8')
    const wrong = path.join(mkdtempSync(path.join(tmpdir(), 'ai-rfx-')), 'cases.yaml')
    writeFileSync(wrong, raw.replace('- { supplierCode: SP0103, lineNo: 3, flag: HIGH }', '- { supplierCode: SP0103, lineNo: 3, flag: LOW }'))
    expect(() => loadSourcingCases(wrong)).toThrow(/RFX-01: code flags SP0103:3:HIGH/)
  })

  it('[FR-AI-305/AC5] the facts carry no free text of a supplier and name an individual by code (BR-AI-32)', () => {
    const individual = cases.find((c) => c.id === 'RFX-03')!
    expect(individual.factsText).toContain('ผู้ขายบุคคลธรรมดา SP0302')
    expect(individual.factsText).not.toContain('สมชาย')
    for (const c of cases) for (const l of c.lines) expect(c.factsText, `${c.id} line ${l.lineNo}`).not.toContain(l.description)
  })

  it('[FR-AI-305/AC5] the gates are SYNTHETIC for the prompts and model in use, nothing awaits evaluation, and the report is in the repository', () => {
    expect(AWAITING_EVALUATION).toEqual([])
    for (const purpose of PURPOSES) {
      const gate = EVAL_GATES.find((g) => g.purpose === purpose)
      expect(gate, purpose).toMatchObject({ agent: 'SOURCING', promptVersion: PROMPT_VERSIONS[purpose], model: modelForPurpose(purpose, {}), tier: 'SYNTHETIC' })
      expect(PROMPTS[purpose].version).toBe(PROMPT_VERSIONS[purpose])
      expect(existsSync(path.join(ROOT, 'docs', 'reports', 'ai-eval', gate!.report)), gate!.report).toBe(true)
    }
  })

  it('[FR-AI-305/AC5] every RFx has the answers Claude gave with the gated prompts and model, and they meet every floor of OQ-209', () => {
    const floors = new Floors()
    const recorded = (c: SourcingCase, purpose: AiPurposeName) => {
      const a = answerOf(purpose, purpose === 'RFX_DRAFT' ? c.draftText : c.factsText)
      expect(a, `${c.id} ${purpose}: a recorded answer`).not.toBeNull()
      expect(a!.recorded, `${c.id} ${purpose}`).toBe('LIVE')
      expect(a!.promptVersion).toBe(PROMPT_VERSIONS[purpose])
      expect(a!.model).toBe(modelForPurpose(purpose, {}))
      return a!.output
    }
    for (const c of cases) {
      floors.add('RFX_DRAFT kind', 'kind', c.plannedKind === c.expect.kind)
      const draft = RfxDraftText.parse(recorded(c, 'RFX_DRAFT'))
      floors.add('RFX_DRAFT head', 'head', draftHeadFilled(draft))
      floors.add('RFX_DRAFT noInventedNumber', 'noInventedNumber', inventedNumbers(c, draft).length === 0)
      for (const line of c.lines) {
        const got = draft.lines.find((l) => l.lineNo === line.lineNo)
        floors.add('RFX_DRAFT descriptionEn', 'descriptionEn', englishDescriptionCorrect(line, got?.descriptionEn))
        floors.add('RFX_DRAFT uomEn', 'uomEn', englishUnitCorrect(line, got?.uomEn))
      }
      for (const purpose of ['BID_SUMMARY', 'NEGOTIATION_POINTS'] as const) {
        const s = scoreSummary(c, BriefText.parse(recorded(c, purpose)).sentences)
        floors.add(`${purpose} text`, 'text', s.text)
        floors.add(`${purpose} noDecisionAdvice`, 'noDecisionAdvice', s.noAdvice)
        if (purpose === 'BID_SUMMARY') for (const f of s.flags) floors.add('BID_SUMMARY flags', 'flags', f)
      }
    }
    floors.expectAllPass()
  })

  it('[FR-AI-305/AC5] the scorer reads an answer the way a person checks it: the truth passes; a missing word, a unit of another kind, a made-up count, advice or a missed flag does not', () => {
    const steel = cases.find((c) => c.id === 'RFX-01')!
    const [rebar, , wire] = steel.lines
    expect(englishDescriptionCorrect(rebar!, 'Deformed steel bar DB16 SD40, 10 m long')).toBe(true)
    expect(englishDescriptionCorrect(rebar!, 'Deformed bar DB 16 grade SD-40')).toBe(true)
    expect(englishDescriptionCorrect(rebar!, 'Steel bar SD40, 10 m')).toBe(false)
    expect(englishUnitCorrect(rebar!, 'Pieces')).toBe(true)
    expect(englishUnitCorrect(wire!, 'kgs.')).toBe(true)
    expect(englishUnitCorrect(wire!, 'roll')).toBe(false)
    const truth = truthDraft(steel)
    expect(draftHeadFilled(truth)).toBe(true)
    expect(inventedNumbers(steel, truth)).toEqual([])
    expect(inventedNumbers(steel, { ...truth, description: 'เหล็กข้ออ้อย DB16 ยาว 10 ม. จำนวน 1 รายการ' })).toContain('จำนวน 1')
    expect(inventedNumbers(steel, { ...truth, descriptionEn: 'One lot of rebar, delivered within 7 days' })).toEqual(expect.arrayContaining(['7', 'one']))
    expect(inventedNumbers(steel, { ...truth, descriptionEn: 'Line 3 is tie wire No. 18' })).toEqual([])
    // Thai words that hold a number word inside them are not counts
    expect(inventedNumbers(steel, { ...truth, description: 'ผู้เสนอราคาสามารถเสนอราคาต่อรายการ เหล็กสี่เหลี่ยม จากห้างร้าน' })).toEqual([])
    expect(inventedNumbers(steel, { ...truth, description: 'เหล็กข้ออ้อยจำนวนสามเส้น' })).toEqual(['จำนวนสามเส้น'])

    const ok = scoreSummary(steel, truthSummary(steel))
    expect(ok).toEqual({ text: true, reason: null, noAdvice: true, flags: [true] })
    const advice = scoreSummary(steel, ['ควรมอบงานให้ {{v:lowest.supplierName}}'])
    expect(advice.noAdvice).toBe(false)
    expect(advice.text).toBe(false)
    expect(scoreSummary(steel, ['ได้รับข้อเสนอ 3 ใบ']).reason).toBe('DIGIT_OUTSIDE_PLACEHOLDER')
    expect(scoreSummary(steel, ['ได้รับข้อเสนอ {{v:bidCount}} ใบ']).flags).toEqual([false])
  })
})
