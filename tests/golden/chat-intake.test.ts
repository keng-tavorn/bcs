import { describe, expect, it } from 'vitest'
import { expiredIntakeIds, routeChatMessage, titleFromText, type ChatMessageFacts } from '@/core/chat-intake'
import { loadGolden } from './support'

// tests/golden/chat-intake.yaml (spec §7.20 · BR-LINE-10 BR-LINE-12 BR-LINE-15 · FR-LINE-301): what one chat message does
// (open a draft, add to the open one, or not) and what it is answered and how; the title of a request drafted from the
// chat; the drafts that expired. Settings of the suite's comment: windowMinutes 30, maxImages 10, maxTextChars 2000,
// hourlyLimit 20, expireHours 24; `now` 2026-11-02T03:00:00Z when not given; `via` REPLY when not given and the reply
// is not NONE.

const SETTINGS = { enabled: true, windowMinutes: 30, maxImages: 10, maxTextChars: 2000, hourlyLimit: 20 }
const NOW = '2026-11-02T03:00:00Z'
const EXPIRE_HOURS = 24

type TextSpec = string | { repeat: string; times: number } | { concat: TextSpec[] }
const textOf = (t: TextSpec): string => (typeof t === 'string' ? t : 'repeat' in t ? t.repeat.repeat(t.times) : t.concat.map(textOf).join(''))
const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' })

interface Case {
  id: string
  title?: string
  input: Record<string, unknown>
  expect: Record<string, unknown>
}

function facts(i: Record<string, unknown>): ChatMessageFacts {
  const open = i.openIntake as { lastMessageAt: string; images: number; textChars: number; linkSent?: boolean } | null
  return {
    settings: { ...SETTINGS, enabled: i.enabled as boolean },
    source: i.source as ChatMessageFacts['source'],
    mode: i.mode as ChatMessageFacts['mode'],
    sender: i.sender as ChatMessageFacts['sender'],
    messageType: i.messageType as string,
    textChars: (i.textChars as number | undefined) ?? 0,
    now: new Date((i.now as string | undefined) ?? NOW),
    openIntake: open ? { lastMessageAt: new Date(open.lastMessageAt), images: open.images, textChars: open.textChars, linkSent: open.linkSent === true } : null,
    sentLastHour: i.sentLastHour as number,
    limitNoticeSentThisHour: i.limitNoticeSentThisHour === true,
    replyTokenExpired: i.replyTokenExpired === true,
  }
}

describe('[FR-LINE-301/AC1] golden chat-intake.yaml', () => {
  const suite = loadGolden('chat-intake') as unknown as { cases: Case[] }
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const i = c.input
      if ('text' in i) {
        const title = titleFromText(textOf(i.text as TextSpec))
        const want = c.expect as { title: TextSpec; graphemes?: number; codeUnits?: number }
        expect(title).toBe(textOf(want.title))
        if (want.graphemes !== undefined) expect([...segmenter.segment(title)]).toHaveLength(want.graphemes)
        if (want.codeUnits !== undefined) expect(title.length).toBe(want.codeUnits)
        return
      }
      if ('intakes' in i) {
        const intakes = (i.intakes as Array<{ id: string; status: string; lastMessageAt: string }>).map((x) => ({ ...x, lastMessageAt: new Date(x.lastMessageAt) }))
        expect({ expire: expiredIntakeIds(new Date(i.now as string), EXPIRE_HOURS, intakes) }).toEqual(c.expect)
        return
      }
      const want = { ...c.expect, via: c.expect.via ?? (c.expect.reply === 'NONE' ? null : 'REPLY') }
      expect(routeChatMessage(facts(i))).toEqual(want)
    })
  }
})
