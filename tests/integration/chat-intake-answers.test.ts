import { describe, expect, it } from 'vitest'
import { lineMessageProblems } from '@/integrations/line'
import { chatAnswerMessages } from '@/server/line/chat-intake'

// S17-06 · the answers in the chat (BR-LINE-15 · FR-LINE-301 AC1): within LINE's limits, Thai then English, the button
// opens the draft in LIFF through liffLink, and nothing comes from what the member typed (there is no input for it).

const LIFF_ID = '1650000003-AbCdEfGh'
const INTAKE = '01900000-0000-7000-8000-000000000001'
const REPLIES = ['INTAKE_LINK', 'INTAKE_LINK_SAME', 'ADD_IN_LIFF', 'TEXT_OR_PHOTO_HINT', 'LINK_PROMPT', 'RATE_LIMIT_NOTICE'] as const

describe('[FR-LINE-301/AC1] the answers of the chat', () => {
  it('every answer is within LINE’s limits, in Thai and English, with or without a LIFF app', () => {
    for (const reply of REPLIES) {
      for (const liffId of [LIFF_ID, null]) {
        const messages = chatAnswerMessages(reply, { liffId, intakeId: INTAKE })
        expect(messages).toHaveLength(1)
        expect(lineMessageProblems(messages)).toEqual([])
        const all = JSON.stringify(messages)
        expect(all).toMatch(/[฀-๿]/)
        expect(all).toMatch(/[A-Za-z]{4,}/)
      }
    }
    expect(chatAnswerMessages('NONE', { liffId: LIFF_ID, intakeId: INTAKE })).toEqual([])
  })

  it('the buttons open the draft in LIFF (or the link page); without a LIFF app the menu is named instead', () => {
    const uri = (reply: (typeof REPLIES)[number]) => JSON.stringify(chatAnswerMessages(reply, { liffId: LIFF_ID, intakeId: INTAKE }))
    for (const reply of ['INTAKE_LINK', 'INTAKE_LINK_SAME', 'ADD_IN_LIFF'] as const) expect(uri(reply)).toContain(`https://liff.line.me/${LIFF_ID}/requests/new?intake=${INTAKE}`)
    expect(uri('LINK_PROMPT')).toContain(`https://liff.line.me/${LIFF_ID}/link`)
    expect(JSON.stringify(chatAnswerMessages('INTAKE_LINK', { liffId: null, intakeId: INTAKE }))).toContain('ขอซื้อ')
  })
})
