import { amountToSatang, satangToAmount } from '../money/dto'

// The check of text an AI wrote (BR-AI-27, golden ai-text, ADR-144): every value is a placeholder {{v:<key>}} of a fact
// or a tool's result, filled in by code. Sentence by sentence, in order, the first reason found: a key that is not there
// (UNKNOWN_VALUE) · an Arabic or Thai digit outside the placeholders (DIGIT_OUTSIDE_PLACEHOLDER) · advice to decide
// (DECISION_ADVICE, the words of ai-config, any case) · more sentences than the profile (TOO_MANY_SENTENCES) · a sentence
// longer than the profile, in code points after the values are filled in (SENTENCE_TOO_LONG). A text that fails is
// thrown away whole and the facts are shown alone.

export type TextValue =
  | { readonly kind: 'money'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'bp'; readonly value: number }
  | { readonly kind: 'date'; readonly value: string }
  | { readonly kind: 'text' | 'enum' | 'ref'; readonly value: string }

export interface TextProfile {
  readonly maxSentences: number
  readonly maxChars: number
}

export type TextReason = 'UNKNOWN_VALUE' | 'DIGIT_OUTSIDE_PLACEHOLDER' | 'DECISION_ADVICE' | 'TOO_MANY_SENTENCES' | 'SENTENCE_TOO_LONG'
export type TextCheck = { readonly ok: true; readonly rendered: readonly string[] } | { readonly ok: false; readonly reason: TextReason; readonly sentence: number }

const PLACEHOLDER = /\{\{v:([^}]+)\}\}/g
const DIGIT = /[0-9๐-๙]/
const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'] as const
const BE_OFFSET = 543
const BP_PER_PERCENT = 100

/** A value as the text shows it: money with thousands and 2 decimals, bp as a percent, a date in the Thai calendar */
export function renderValue(v: TextValue): string {
  switch (v.kind) {
    case 'money': {
      const [whole, fraction] = satangToAmount(amountToSatang(v.value)).split('.')
      return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
    }
    case 'bp': {
      const whole = Math.trunc(v.value / BP_PER_PERCENT)
      const rest = String(Math.abs(v.value % BP_PER_PERCENT)).padStart(2, '0').replace(/0+$/, '')
      return `${v.value < 0 && whole === 0 ? '-' : ''}${whole}${rest ? `.${rest}` : ''}%`
    }
    case 'date': {
      const [y, m, d] = v.value.split('-').map(Number) as [number, number, number]
      return `${d} ${THAI_MONTHS[m - 1]} ${y + BE_OFFSET}`
    }
    case 'integer':
      return String(v.value)
    default:
      return v.value
  }
}

export function checkAiText(sentences: readonly string[], values: Readonly<Record<string, TextValue>>, profile: TextProfile, adviceWords: readonly string[]): TextCheck {
  const rendered: string[] = []
  const advice = adviceWords.map((w) => w.toLowerCase())
  for (const [i, sentence] of sentences.entries()) {
    const keys = [...sentence.matchAll(PLACEHOLDER)].map((m) => m[1]!)
    if (keys.some((k) => !Object.hasOwn(values, k))) return { ok: false, reason: 'UNKNOWN_VALUE', sentence: i }
    if (DIGIT.test(sentence.replace(PLACEHOLDER, ''))) return { ok: false, reason: 'DIGIT_OUTSIDE_PLACEHOLDER', sentence: i }
    const lower = sentence.toLowerCase()
    if (advice.some((w) => lower.includes(w))) return { ok: false, reason: 'DECISION_ADVICE', sentence: i }
    if (i >= profile.maxSentences) return { ok: false, reason: 'TOO_MANY_SENTENCES', sentence: i }
    const text = sentence.replace(PLACEHOLDER, (_, k: string) => renderValue(values[k]!))
    if ([...text].length > profile.maxChars) return { ok: false, reason: 'SENTENCE_TOO_LONG', sentence: i }
    rendered.push(text)
  }
  return { ok: true, rendered }
}
