import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DECISION_ADVICE_WORDS } from '@/lib/ai-config'

// NEW-123 (FR-VIS-008 AC3 · BR-AI-27 DECISION_ADVICE): the savings page tells what was found and what it is compared
// with, never which way to decide. Every word it shows comes from these messages and the documents' own data, so none of
// the words the AI checker refuses (ai-config, compared ignoring case) is in either language.

type Tree = string | { readonly [key: string]: Tree }
const leaves = (t: Tree, at = ''): Array<[string, string]> => (typeof t === 'string' ? [[at, t]] : Object.entries(t).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k)))
const read = (locale: 'th' | 'en') => JSON.parse(readFileSync(path.join(process.cwd(), 'messages', 'src', locale, 'savings.json'), 'utf8')) as Tree

describe('[FR-VIS-008/AC3] the savings page never advises a decision', () => {
  it.each(['th', 'en'] as const)('no message of the page (%s) carries a word of DECISION_ADVICE', (locale) => {
    const words = leaves(read(locale))
    expect(words.length).toBeGreaterThan(20)
    const advising = words.filter(([, text]) => DECISION_ADVICE_WORDS.some((w) => text.toLowerCase().includes(w.toLowerCase())))
    expect(advising).toEqual([])
  })

  it('the checker would catch one: the list of words is not empty and is matched ignoring case', () => {
    expect(DECISION_ADVICE_WORDS.some((w) => 'ผู้ช่วยแนะนำ: ควรอนุมัติคำขอนี้'.toLowerCase().includes(w.toLowerCase()))).toBe(true)
    expect(DECISION_ADVICE_WORDS.some((w) => 'You SHOULD APPROVE it'.toLowerCase().includes(w.toLowerCase()))).toBe(true)
  })
})
