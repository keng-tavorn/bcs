import { describe, expect, it } from 'vitest'
import {
  LINE_ALT_TEXT_MAX_LENGTH,
  LINE_FLEX_BUBBLE_MAX_BYTES,
  LINE_FLEX_CAROUSEL_MAX_BUBBLES,
  LINE_FLEX_CAROUSEL_MAX_BYTES,
  LINE_LIMITS_CHECKED_ON,
  LINE_MESSAGES_PER_REQUEST_MAX,
  LINE_POSTBACK_DATA_MAX_LENGTH,
  LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH,
  LINE_REPLY_TOKEN_TTL_MS,
  LINE_RICH_MENU_AREAS_MAX,
  LINE_RICH_MENU_CHAT_BAR_TEXT_MAX_LENGTH,
  lineMessageProblems,
  truncateForLine,
  type LineMessage,
} from '@/integrations/line'

// BR-LINE-09 · §4.7 rule 5 · §9.3: one module holds LINE's limits with the date they were taken from LINE's docs. The
// values are pinned here, so a change is a deliberate edit of both; the checks refuse a card before LINE would. These are
// building blocks of the cards of S5-05: they carry the rule they check, not an AC of FR-LINE-002, whose tests come with
// the cards.

const bubble = (extra: Record<string, unknown> = {}) => ({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'PR-2569-00012' }] }, ...extra })
const flex = (contents: unknown, altText = 'งานอนุมัติ PR-2569-00012'): LineMessage => ({ type: 'flex', altText, contents })
const postbackButton = (data: string, displayText = 'อนุมัติ PR-2569-00012') => ({ type: 'button', action: { type: 'postback', label: 'อนุมัติ', data, displayText } })

describe("[BR-LINE-09] LINE's limits for cards live in one module with their source date (§4.7 rule 5)", () => {
  it('pins every value as LINE documents it', () => {
    expect(LINE_LIMITS_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect({
      messages: LINE_MESSAGES_PER_REQUEST_MAX,
      altText: LINE_ALT_TEXT_MAX_LENGTH,
      postbackData: LINE_POSTBACK_DATA_MAX_LENGTH,
      displayText: LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH,
      bubbleBytes: LINE_FLEX_BUBBLE_MAX_BYTES,
      carouselBytes: LINE_FLEX_CAROUSEL_MAX_BYTES,
      carouselBubbles: LINE_FLEX_CAROUSEL_MAX_BUBBLES,
      replyTokenMs: LINE_REPLY_TOKEN_TTL_MS,
      richMenuAreas: LINE_RICH_MENU_AREAS_MAX,
      chatBarText: LINE_RICH_MENU_CHAT_BAR_TEXT_MAX_LENGTH,
    }).toEqual({
      messages: 5,
      altText: 400,
      postbackData: 300,
      displayText: 300,
      // Under LINE's "30 KB" and "50 KB" read the strict way (30,000 and 50,000 bytes) until D-03 checks them
      bubbleBytes: 29 * 1024,
      carouselBytes: 48 * 1024,
      carouselBubbles: 12,
      replyTokenMs: 60_000,
      richMenuAreas: 20,
      chatBarText: 14,
    })
  })

  it('accepts a summary card and refuses more than 5 messages or none', () => {
    const card = flex(bubble({ footer: { type: 'box', layout: 'vertical', contents: [postbackButton('v=1&a=approve&k=0198c6d2-0000-7000-8000-000000000001')] } }))
    expect(lineMessageProblems([card])).toEqual([])
    expect(lineMessageProblems(Array.from({ length: 5 }, () => card))).toEqual([])
    expect(lineMessageProblems(Array.from({ length: 6 }, () => card))).toEqual([{ limit: 'MESSAGE_COUNT', path: 'messages', actual: 6, max: 5 }])
    expect(lineMessageProblems([])).toEqual([{ limit: 'MESSAGE_COUNT', path: 'messages', actual: 0, max: 5 }])
  })

  it('counts altText in UTF-16 code units as LINE does: 400 fit, 401 do not, an emoji counts 2', () => {
    expect(lineMessageProblems([flex(bubble(), 'ก'.repeat(400))])).toEqual([])
    expect(lineMessageProblems([flex(bubble(), 'ก'.repeat(401))])).toEqual([{ limit: 'ALT_TEXT', path: 'messages[0].altText', actual: 401, max: 400 }])
    expect(lineMessageProblems([flex(bubble(), `${'a'.repeat(399)}🍎`)])).toEqual([{ limit: 'ALT_TEXT', path: 'messages[0].altText', actual: 401, max: 400 }])
  })

  it('refuses a bubble over 30 KB and a carousel over 50 KB or 12 bubbles', () => {
    const big = (bytes: number) => bubble({ body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'x'.repeat(bytes) }] } })
    expect(lineMessageProblems([flex(big(LINE_FLEX_BUBBLE_MAX_BYTES - 200))])).toEqual([])
    expect(lineMessageProblems([flex(big(LINE_FLEX_BUBBLE_MAX_BYTES))]).map((p) => [p.limit, p.path])).toEqual([['FLEX_BUBBLE_BYTES', 'messages[0].contents']])
    // Between the two readings of "30 KB" (30,000 and 30,720 bytes): refused here, so it can never fail at LINE
    expect(LINE_FLEX_BUBBLE_MAX_BYTES).toBeLessThanOrEqual(30_000)
    expect(LINE_FLEX_CAROUSEL_MAX_BYTES).toBeLessThanOrEqual(50_000)
    const between = flex(big(30_400))
    const bytes = Buffer.byteLength(JSON.stringify(between.contents), 'utf8')
    expect(bytes).toBeGreaterThan(30_000)
    expect(bytes).toBeLessThanOrEqual(30 * 1024)
    expect(lineMessageProblems([between]).map((p) => p.limit)).toEqual(['FLEX_BUBBLE_BYTES'])
    const carousel = (bubbles: unknown[]) => flex({ type: 'carousel', contents: bubbles })
    expect(lineMessageProblems([carousel(Array.from({ length: 12 }, () => bubble()))])).toEqual([])
    expect(lineMessageProblems([carousel(Array.from({ length: 13 }, () => bubble()))]).map((p) => p.limit)).toEqual(['FLEX_CAROUSEL_BUBBLES'])
    const heavy = Array.from({ length: 3 }, () => big(20 * 1024))
    expect(lineMessageProblems([carousel(heavy)]).map((p) => p.limit)).toEqual(['FLEX_CAROUSEL_BYTES'])
  })

  it('truncates Thai text at a grapheme boundary and never splits an emoji', () => {
    expect(truncateForLine('สั้น', 10)).toBe('สั้น')
    const cut = truncateForLine('ที่ปรึกษาฝ่ายจัดซื้อ', 6)
    expect(cut.length).toBeLessThanOrEqual(6)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).toBe('ที่ป…')
    expect(truncateForLine('🍎🍎🍎', 4)).toBe('🍎…')
    expect(truncateForLine('abc', 0)).toBe('')
  })
})

describe('[BR-LINE-09] the approve postback of §9.3 fits LINE: data and displayText at most 300 characters', () => {
  it('accepts the §9.3 postback and refuses data or displayText over 300 wherever the action sits', () => {
    const data = 'v=1&a=approve&k=0198c6d2-0000-7000-8000-000000000001'
    expect(data.length).toBeLessThan(LINE_POSTBACK_DATA_MAX_LENGTH)
    expect(lineMessageProblems([flex(bubble({ footer: { type: 'box', layout: 'vertical', contents: [postbackButton('d'.repeat(300))] } }))])).toEqual([])
    const tooLong = flex(bubble({ footer: { type: 'box', layout: 'vertical', contents: [postbackButton('d'.repeat(301), 't'.repeat(301))] } }))
    expect(lineMessageProblems([tooLong])).toEqual([
      { limit: 'POSTBACK_DATA', path: 'messages[0].contents.footer.contents[0].action.data', actual: 301, max: 300 },
      { limit: 'POSTBACK_DISPLAY_TEXT', path: 'messages[0].contents.footer.contents[0].action.displayText', actual: 301, max: 300 },
    ])
    // A quick reply carries actions too
    const quick: LineMessage = { type: 'text', text: 'ok', quickReply: { items: [{ type: 'action', action: { type: 'postback', label: 'x', data: 'q'.repeat(301) } }] } }
    expect(lineMessageProblems([quick]).map((p) => p.path)).toEqual(['messages[0].quickReply.items[0].action.data'])
  })
})
