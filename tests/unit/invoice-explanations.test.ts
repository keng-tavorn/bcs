import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAYMENT_FLAGS } from '@/core/payment'
import { MatchExceptionType } from '@/server/db/generated/enums'

// NEW-116: every difference the match can raise and every flag a payment run can carry says what it means, in Thai and in
// English, so a new code without its words fails here rather than showing its bare name on a screen.

const words = (lang: string, file: string) => JSON.parse(readFileSync(path.resolve(`messages/src/${lang}/${file}.json`), 'utf8')) as Record<string, Record<string, Record<string, string>>>

describe.each(['th', 'en'])('the explanations in %s', (lang) => {
  it('[FR-AP-103/AC5] every type of difference has its name and what it means', () => {
    const { exceptions } = words(lang, 'apInvoice')
    for (const type of Object.values(MatchExceptionType)) {
      expect(exceptions!.type![type], type).toBeTruthy()
      expect(exceptions!.explain![type], type).toBeTruthy()
    }
    expect(Object.keys(exceptions!.explain!).sort()).toEqual(Object.values(MatchExceptionType).sort())
  })

  it('[FR-PAY-101/AC13] every flag of a payment run has its name and what it means', () => {
    const { task } = words(lang, 'payRun')
    for (const flag of PAYMENT_FLAGS) {
      expect(task!.flag![flag], flag).toBeTruthy()
      expect(task!.flagExplain![flag], flag).toBeTruthy()
    }
    expect(Object.keys(task!.flagExplain!).sort()).toEqual([...PAYMENT_FLAGS].sort())
  })
})
