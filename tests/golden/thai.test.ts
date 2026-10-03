import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { bahtText } from '@/core/thai/baht-text'
import { isValidThaiTaxId } from '@/core/thai/taxid'
import { loadYaml } from './doa-fixtures'

// tests/golden/thai.yaml (spec §7.2, BR-THAI-01: amount in Thai words) and taxid.yaml (BR-THAI-02: tax ID mod-11).

type Case<I, E> = { id: string; title?: string; fn?: string; input: I; expect: E }

describe('golden thai.yaml and taxid.yaml', () => {
  for (const c of loadYaml<{ cases: Case<string, string>[] }>('thai.yaml').cases) {
    it(`[${c.id}]`, () => expect(bahtText(amountToSatang(c.input))).toBe(c.expect))
  }
  for (const c of loadYaml<{ cases: Case<string, boolean>[] }>('taxid.yaml').cases) {
    it(`[${c.id}]`, () => expect(isValidThaiTaxId(c.input)).toBe(c.expect))
  }
})

