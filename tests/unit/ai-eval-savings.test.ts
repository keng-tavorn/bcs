import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureKey } from '@/integrations/ai'
import { EVAL_GATES, PROMPT_VERSIONS } from '@/lib/ai-config'
import { SAVINGS_KINDS } from '@/core/savings'
import { savingsFacts, savingsNoteText } from '@/server/services/ai/agents/savings-facts'
import { AI_ANSWERS_DIR } from '../../scripts/lib/ai-eval-cases'
import { loadSavingsCases, type SavingsCase } from '../../scripts/ai-eval-savings'

// NEW-132 (BR-AI-11 · ADR-081 item 5): the evaluation cases of a saving's explanation are savings of every kind as the
// page's DTO, each sent to Claude as exactly the text the agent sends for it, with a recorded answer of the prompt that
// passed so fixture mode runs without a key.

let cases: SavingsCase[]
beforeAll(async () => {
  cases = await loadSavingsCases()
}, 60_000)

describe('[BR-AI-11] the evaluation cases of SAVINGS_NOTE', () => {
  it('[BR-AI-11] holds 24 savings, six of each kind, with ids of their own', () => {
    expect(cases).toHaveLength(24)
    for (const kind of SAVINGS_KINDS) expect(cases.filter((c) => c.item.kind === kind), kind).toHaveLength(6)
    expect(new Set(cases.map((c) => c.id)).size).toBe(24)
  })

  it('[BR-AI-11] each case is the text the agent sends for that saving, naming the amount the code calculated', () => {
    for (const c of cases) {
      expect(c.text, c.id).toBe(savingsNoteText(savingsFacts(c.item)))
      expect(Object.hasOwn(c.facts, c.mustMention), c.id).toBe(true)
      expect(c.mustMention, c.id).toBe(c.item.kind === 'AGREEMENT_EXPIRING' ? 'spent' : 'saving')
      // no case carries a saving of nothing: each one is worth explaining
      const amount = c.item.kind === 'AGREEMENT_EXPIRING' ? c.item.spentSatang : c.item.savingSatang
      expect(BigInt(amount), c.id).toBeGreaterThan(0n)
    }
  })

  it('[BR-AI-11] each case has the recorded answer of the gated prompt, and the gate names its report', () => {
    const gate = EVAL_GATES.find((g) => g.purpose === 'SAVINGS_NOTE')
    expect(gate?.promptVersion).toBe(PROMPT_VERSIONS.SAVINGS_NOTE)
    for (const c of cases) {
      const file = path.join(AI_ANSWERS_DIR, `${fixtureKey({ purpose: 'SAVINGS_NOTE', text: c.text })}.json`)
      expect(existsSync(file), c.id).toBe(true)
      expect((JSON.parse(readFileSync(file, 'utf8')) as { promptVersion: string }).promptVersion, c.id).toBe(PROMPT_VERSIONS.SAVINGS_NOTE)
    }
  })
})
