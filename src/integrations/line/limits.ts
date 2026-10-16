import { BYTES_PER_KIB, MAX_UPLOAD_BYTES, MS_PER_MINUTE } from '@/lib/constants'

// The limits of the LINE Messaging API that BCS runs into (BR-LINE-09: Messaging API only; §4.7 rule 5: one constant per
// limit, dated from LINE's docs), in one place, with where each one comes from. Checked on LINE Developers on 2026-10-03:
//  - line/line-openapi messaging-api.yml (the source of the Messaging API reference): push and reply take 1 to 5 message
//    objects; the retry key is a UUID
//  - Flex Message elements and its news entry: the JSON of a bubble is at most 30 KB, of a carousel at most 50 KB;
//    altText of a Flex Message is at most 400 characters
//  - Character counting in a text: LINE counts UTF-16 code units, which is what String.prototype.length counts
//    ('🍎'.length === 2 and LINE counts 2)
// Taken from the Messaging API reference without a fresh look on that date (check them again with the real channel of
// D-03): postback action data and displayText at most 300 characters each (spec §9.3 says the same of data), a
// carousel at most 12 bubbles, a reply token used once and within one minute, a rich menu with at most 20 areas and a
// chat bar text of at most 14 characters.
// LINE writes "KB" without saying 1,000 or 1,024 bytes. The sizes here stay under the stricter reading (1,000 bytes), so
// a card that passes this check also passes LINE under either reading (check it with the real channel in D-03). Cards
// of BCS carry a summary only (BR-LINE-06, §9.3) and stay far below both. tests/unit/line-limits.test.ts pins every
// value: when LINE changes one, change it here with the date and the page it came from.

export const LINE_LIMITS_CHECKED_ON = '2026-10-03'

/** Message objects in one push or reply request */
export const LINE_MESSAGES_PER_REQUEST_MAX = 5
/** altText of a Flex or template message, in UTF-16 code units */
export const LINE_ALT_TEXT_MAX_LENGTH = 400
/** `data` of a postback action, in UTF-16 code units (§9.3: `v=1&a=approve&k=<tokenId>` fits easily) */
export const LINE_POSTBACK_DATA_MAX_LENGTH = 300
/** `displayText` of a postback action, in UTF-16 code units */
export const LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH = 300
/**
 * JSON of one Flex bubble, in UTF-8 bytes. LINE's "30 KB" read the strict way is 30,000 bytes; this is the largest whole
 * number of KiB under it (29 × 1,024 = 29,696), since src/lib/constants.ts has no decimal kilobyte yet.
 */
export const LINE_FLEX_BUBBLE_MAX_BYTES = 29 * BYTES_PER_KIB
/** JSON of one Flex carousel, in UTF-8 bytes: under LINE's "50 KB" read the strict way, 50,000 (48 × 1,024 = 49,152) */
export const LINE_FLEX_CAROUSEL_MAX_BYTES = 48 * BYTES_PER_KIB
/** Bubbles in one Flex carousel */
export const LINE_FLEX_CAROUSEL_MAX_BUBBLES = 12
/** A reply token works once and only this long after the webhook arrived (BR-LINE-07: reply before push) */
export const LINE_REPLY_TOKEN_TTL_MS = MS_PER_MINUTE
/** Tappable areas of one rich menu (§9.5 uses 2 and 4) */
export const LINE_RICH_MENU_AREAS_MAX = 20
/** Users one bulk link or bulk unlink of rich menus takes (POST /v2/bot/richmenu/bulk/link · bulk/unlink) */
export const LINE_RICH_MENU_BULK_USERS_MAX = 500
/** Bytes of a message's content BCS reads from LINE (S17-06 · NFR-SEC-08: a picture of a request is at most 20 MB) */
export const LINE_MESSAGE_CONTENT_MAX_BYTES = MAX_UPLOAD_BYTES
/** The text on the chat bar under a rich menu, in grapheme clusters */
export const LINE_RICH_MENU_CHAT_BAR_TEXT_MAX_LENGTH = 14

/** One message object as LINE takes it: `type` plus the fields of that type (built by the card code of S5-05). */
export type LineMessage = { readonly type: string } & Readonly<Record<string, unknown>>

export type LineLimitName = 'MESSAGE_COUNT' | 'ALT_TEXT' | 'POSTBACK_DATA' | 'POSTBACK_DISPLAY_TEXT' | 'FLEX_BUBBLE_BYTES' | 'FLEX_CAROUSEL_BYTES' | 'FLEX_CAROUSEL_BUBBLES'

/** A value over one of LINE's limits: where it is (`messages[0].contents.footer…`), how big it is and what LINE allows. */
export interface LineLimitProblem {
  readonly limit: LineLimitName
  readonly path: string
  readonly actual: number
  readonly max: number
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Size of a value as LINE receives it: its JSON in UTF-8 bytes. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/** Every postback action anywhere inside a message: Flex buttons, template actions, quick replies. */
function postbackProblems(value: unknown, path: string, out: LineLimitProblem[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => postbackProblems(item, `${path}[${i}]`, out))
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'postback') {
    const over = (limit: LineLimitName, field: 'data' | 'displayText', max: number) => {
      const text = value[field]
      if (typeof text === 'string' && text.length > max) out.push({ limit, path: `${path}.${field}`, actual: text.length, max })
    }
    over('POSTBACK_DATA', 'data', LINE_POSTBACK_DATA_MAX_LENGTH)
    over('POSTBACK_DISPLAY_TEXT', 'displayText', LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH)
  }
  for (const [key, child] of Object.entries(value)) postbackProblems(child, `${path}.${key}`, out)
}

function flexProblems(contents: unknown, path: string, out: LineLimitProblem[]): void {
  if (!isRecord(contents)) return
  const bytes = jsonByteLength(contents)
  if (contents.type === 'bubble' && bytes > LINE_FLEX_BUBBLE_MAX_BYTES) out.push({ limit: 'FLEX_BUBBLE_BYTES', path, actual: bytes, max: LINE_FLEX_BUBBLE_MAX_BYTES })
  if (contents.type === 'carousel') {
    if (bytes > LINE_FLEX_CAROUSEL_MAX_BYTES) out.push({ limit: 'FLEX_CAROUSEL_BYTES', path, actual: bytes, max: LINE_FLEX_CAROUSEL_MAX_BYTES })
    const bubbles = Array.isArray(contents.contents) ? contents.contents : []
    if (bubbles.length > LINE_FLEX_CAROUSEL_MAX_BUBBLES) out.push({ limit: 'FLEX_CAROUSEL_BUBBLES', path: `${path}.contents`, actual: bubbles.length, max: LINE_FLEX_CAROUSEL_MAX_BUBBLES })
    bubbles.forEach((bubble, i) => {
      const size = jsonByteLength(bubble)
      if (size > LINE_FLEX_BUBBLE_MAX_BYTES) out.push({ limit: 'FLEX_BUBBLE_BYTES', path: `${path}.contents[${i}]`, actual: size, max: LINE_FLEX_BUBBLE_MAX_BYTES })
    })
  }
}

/**
 * What LINE would refuse in one push or reply: too many messages, an altText, postback or Flex over its limit. Empty
 * when everything fits. The LINE client checks this before it sends, so a card over a limit fails here, by name,
 * instead of as a 400 from LINE.
 */
export function lineMessageProblems(messages: readonly LineMessage[]): LineLimitProblem[] {
  const out: LineLimitProblem[] = []
  if (messages.length === 0 || messages.length > LINE_MESSAGES_PER_REQUEST_MAX) {
    out.push({ limit: 'MESSAGE_COUNT', path: 'messages', actual: messages.length, max: LINE_MESSAGES_PER_REQUEST_MAX })
  }
  messages.forEach((message, i) => {
    const path = `messages[${i}]`
    if ((message.type === 'flex' || message.type === 'template') && typeof message.altText === 'string' && message.altText.length > LINE_ALT_TEXT_MAX_LENGTH) {
      out.push({ limit: 'ALT_TEXT', path: `${path}.altText`, actual: message.altText.length, max: LINE_ALT_TEXT_MAX_LENGTH })
    }
    if (message.type === 'flex') flexProblems(message.contents, `${path}.contents`, out)
    postbackProblems(message, path, out)
  })
  return out
}

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' })

/**
 * `text` cut to at most `max` UTF-16 code units, at a grapheme boundary so a Thai vowel or tone mark, an emoji or a
 * surrogate pair is never split, ending with "…" when something was cut. For altText and other limited texts.
 */
export function truncateForLine(text: string, max: number): string {
  if (text.length <= max) return text
  const ellipsis = '…'
  if (max < ellipsis.length) return ''
  let out = ''
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length + ellipsis.length > max) break
    out += segment
  }
  return out + ellipsis
}
