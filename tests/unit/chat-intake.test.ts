import { describe, expect, it } from 'vitest'
import { clipCodePoints, codePoints, expiredIntakeIds, routeChatMessage, titleFromText, type ChatMessageFacts } from '@/core/chat-intake'

// S17-06 · src/core/chat-intake beyond the golden cases (tests/golden/chat-intake.yaml · BR-LINE-10 BR-LINE-15): answers
// other than the LIFF button are never pushed, the button goes once by push to a draft that never had it, text that
// fills a new draft, whole characters when text is cut, and the title of lines that are blank or end in CR LF.

const base: ChatMessageFacts = {
  settings: { enabled: true, windowMinutes: 30, maxImages: 10, maxTextChars: 2000, hourlyLimit: 20 },
  source: 'user',
  mode: 'active',
  sender: 'LINKED_ACTIVE',
  messageType: 'text',
  textChars: 10,
  now: new Date('2026-11-02T03:00:00Z'),
  openIntake: null,
  sentLastHour: 0,
  limitNoticeSentThisHour: false,
  replyTokenExpired: false,
}
const open = { lastMessageAt: new Date('2026-11-02T02:59:00Z'), images: 0, textChars: 10, linkSent: false }

describe('[FR-LINE-301/AC3] [BR-LINE-15] only the LIFF button is ever pushed, once per draft', () => {
  it('with the reply token gone, hints and prompts are not sent at all', () => {
    const late = { ...base, replyTokenExpired: true }
    expect(routeChatMessage({ ...late, sender: 'UNLINKED' })).toEqual({ action: 'LINK_PROMPT', reply: 'NONE', via: null })
    expect(routeChatMessage({ ...late, messageType: 'sticker' })).toEqual({ action: 'UNSUPPORTED', reply: 'NONE', via: null })
    expect(routeChatMessage({ ...late, sentLastHour: 20 })).toEqual({ action: 'RATE_LIMITED', reply: 'NONE', via: null })
    expect(routeChatMessage({ ...late, messageType: 'image', openIntake: { ...open, images: 10 } })).toEqual({ action: 'LIMIT_IMAGES', reply: 'NONE', via: null })
  })

  it('a draft that never had the button gets it by push when the token is gone; one that had it, nothing', () => {
    expect(routeChatMessage({ ...base, replyTokenExpired: true, openIntake: open })).toEqual({ action: 'APPEND', reply: 'INTAKE_LINK_SAME', via: 'PUSH' })
    expect(routeChatMessage({ ...base, replyTokenExpired: true, openIntake: { ...open, linkSent: true } })).toEqual({ action: 'APPEND', reply: 'NONE', via: null })
    // With the token, every message is answered by reply, whatever was sent before
    expect(routeChatMessage({ ...base, openIntake: { ...open, linkSent: true } })).toEqual({ action: 'APPEND', reply: 'INTAKE_LINK_SAME', via: 'REPLY' })
  })
})

describe('[FR-LINE-301/AC1] [BR-LINE-10] text up to maxTextChars code points per draft', () => {
  it('a first message longer than the limit keeps the limit; a draft at the limit keeps nothing more', () => {
    expect(routeChatMessage({ ...base, textChars: 2500 })).toEqual({ action: 'OPEN_NEW', reply: 'INTAKE_LINK', via: 'REPLY', keptChars: 2000, textTruncated: true })
    expect(routeChatMessage({ ...base, textChars: 1, openIntake: { ...open, textChars: 2000 } })).toMatchObject({ action: 'APPEND', keptChars: 0, textTruncated: true })
    expect(routeChatMessage({ ...base, textChars: 1990, openIntake: open })).toEqual({ action: 'APPEND', reply: 'INTAKE_LINK_SAME', via: 'REPLY' })
  })

  it('cuts at a whole character, counting code points as Postgres char_length does', () => {
    expect(codePoints('🧱🧱')).toBe(2)
    expect('🧱🧱'.length).toBe(4)
    // ที่ is one character of three code points: two do not hold it
    expect(clipCodePoints('ที่ดิน', 2)).toBe('')
    expect(clipCodePoints('ที่ดิน', 3)).toBe('ที่')
    // ดิ is one character of two: four code points still end after ที่
    expect(clipCodePoints('ที่ดิน', 4)).toBe('ที่')
    expect(clipCodePoints('ที่ดิน', 5)).toBe('ที่ดิ')
    expect(clipCodePoints('abc', 10)).toBe('abc')
  })
})

describe('[FR-LINE-301/AC4] [BR-LINE-12] the title of a request drafted from the chat', () => {
  it('the first line that is not blank, trimmed, whatever the line ends', () => {
    expect(titleFromText('\r\n   \r\n  ปูน 10 ถุง  \r\nส่งไซต์ A')).toBe('ปูน 10 ถุง')
    expect(titleFromText('')).toBe('')
    expect(titleFromText(' \n \n')).toBe('')
  })
})

describe('[FR-LINE-301/AC7] drafts that expire', () => {
  it('only OPEN drafts, at expireHours or later', () => {
    const now = new Date('2026-11-02T03:00:00Z')
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000)
    expect(
      expiredIntakeIds(now, 24, [
        { id: 'a', status: 'OPEN', lastMessageAt: ago(25) },
        { id: 'b', status: 'DISMISSED', lastMessageAt: ago(48) },
        { id: 'c', status: 'OPEN', lastMessageAt: ago(1) },
      ]),
    ).toEqual(['a'])
  })
})
