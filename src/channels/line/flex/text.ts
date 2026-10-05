import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai'
import type { CardLocale } from './types'

// Text helpers of the LINE builders. Every text a card or notice carries is cut to a length of its own here, so a long
// title or name can never push a message over LINE's limits (§4.7 rule 5; the limits themselves are pinned in
// src/integrations/line/limits.ts and checked by the tests of these builders). Lengths count UTF-16 code units, as LINE
// counts them.

/** A document's number or title on a card */
export const CARD_LABEL_MAX_LENGTH = 60
/** A person's or a department's name, a request type */
export const CARD_NAME_MAX_LENGTH = 60
/**
 * The label of a button. LINE allows 20 characters on the actions of a template message and more on a Flex button;
 * the cards keep to 20 so a label is never cut on any LINE app.
 */
export const ACTION_LABEL_MAX_LENGTH = 20
/** The first line of a short notice */
export const NOTICE_TITLE_MAX_LENGTH = 200
/** The rest of a short notice (a daily summary is the longest, a few hundred); LINE takes 5,000 characters in a text */
export const NOTICE_BODY_MAX_LENGTH = 900

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' })
const ELLIPSIS = '…'

/** One line: control characters (line breaks included) turned into spaces, trimmed */
const oneLine = (text: string) => text.replace(/\p{Cc}+/gu, ' ').trim()

/** `clean` cut to at most `max` code units at a grapheme boundary, ending with "…" */
function cut(clean: string, max: number): string {
  if (max < ELLIPSIS.length) return ''
  let out = ''
  for (const { segment } of graphemes.segment(clean)) {
    if (out.length + segment.length + ELLIPSIS.length > max) break
    out += segment
  }
  return out + ELLIPSIS
}

/**
 * `text` on one line (control characters become spaces), cut to at most `max` UTF-16 code units at a grapheme boundary
 * (a Thai vowel or tone mark, an emoji or a surrogate pair is never split), ending with "…" when something was cut.
 */
export function clip(text: string, max: number): string {
  const clean = oneLine(text)
  return clean.length <= max ? clean : cut(clean, max)
}

/** Like clip, but keeps the line breaks (a summary has one item per line); what does not fit is left out after "…" */
export function clipLines(text: string, max: number): string {
  const out: string[] = []
  let used = 0
  for (const raw of text.split('\n')) {
    const separator = out.length > 0 ? 1 : 0
    const room = max - used - separator
    if (room <= 0) break
    const line = oneLine(raw)
    if (line.length > room) {
      out.push(cut(line, room))
      break
    }
    out.push(line)
    used += separator + line.length
  }
  return out.join('\n')
}

/** "12,840.00 บาท" / "12,840.00 baht" from satang (no floating point, §17.3) */
export function bahtOf(satang: bigint, locale: CardLocale): string {
  return `${formatSatang(satang)} ${locale === 'th' ? 'บาท' : 'baht'}`
}

/** "6 ต.ค. 2569 17:30 น." / "6 Oct 2569 17:30" in Thai time, the Buddhist-era year in both languages (FR-PLT-002 AC3) */
export function dateTimeOf(at: Date | string, locale: CardLocale): string {
  return locale === 'th' ? formatThaiDateTime(at) : formatEnglishBeDateTime(at)
}
