import { z } from 'zod'
import { CHAT_INTAKE_MAX_HOURLY_LIMIT, CHAT_INTAKE_MAX_TEXT_CHARS, CHAT_INTAKE_MAX_WINDOW_MINUTES } from './constants'

// Organization.settings.chatIntake and .bcsGo (S17-01 · docs/sub-specs/S17.md "Entity และ migration"): asking through
// the LINE chat (BR-LINE-10, BR-LINE-11, BR-LINE-15) and the copies and queue of the BCS Go app (BR-APP-04, BR-APP-10).
// Every key is optional and a missing one reads as its default, so an organization saved before S17 (staging, the demo
// seed) parses as it is and keeps asking through the chat switched off. The phase-1 workbook sets them from sheet
// Settings (src/server/seed/settings-s17.ts) and scripts/validate_inputs.py checks the same bounds.

/** The highest value of each key: the CHECKs of the S17 migration (2000 code points, 10 images) and BR-APP-10 (30 days) */
export const S17_SETTING_LIMITS = {
  windowMinutes: CHAT_INTAKE_MAX_WINDOW_MINUTES,
  maxImages: 10,
  maxTextChars: CHAT_INTAKE_MAX_TEXT_CHARS,
  hourlyLimit: CHAT_INTAKE_MAX_HOURLY_LIMIT,
  expireHours: 168,
  textRetentionDays: 30,
  offlineRetentionDays: 30,
  maxPreparedPos: 200,
} as const

const upTo = (max: number) => z.number().int().min(1).max(max).optional()
const L = S17_SETTING_LIMITS

export const ChatIntakeSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    windowMinutes: upTo(L.windowMinutes),
    maxImages: upTo(L.maxImages),
    maxTextChars: upTo(L.maxTextChars),
    hourlyLimit: upTo(L.hourlyLimit),
    expireHours: upTo(L.expireHours),
    textRetentionDays: upTo(L.textRetentionDays),
  })
  .strict()

export const BcsGoSettingsSchema = z
  .object({
    offlineRetentionDays: upTo(L.offlineRetentionDays),
    maxPreparedPos: upTo(L.maxPreparedPos),
  })
  .strict()

export interface ChatIntakeSettings {
  /** BR-LINE-10: off = the chat answers as before S17 */
  readonly enabled: boolean
  /** A message within this many minutes of the last one adds to the same open draft */
  readonly windowMinutes: number
  readonly maxImages: number
  /** Code points, as char_length of the CHECK counts them */
  readonly maxTextChars: number
  /** Messages a member may send in an hour before the chat stops taking them */
  readonly hourlyLimit: number
  /** An open draft not used for this many hours expires */
  readonly expireHours: number
  /** BR-LINE-11: the typed text is cleared this many days after the draft closes */
  readonly textRetentionDays: number
}

export interface BcsGoSettings {
  /** BR-APP-04, BR-APP-10: a copy older than this cannot start a new receipt, and an unsent item expires */
  readonly offlineRetentionDays: number
  /** BR-APP-04: how many POs a phone may keep ready for offline receiving */
  readonly maxPreparedPos: number
}

export const CHAT_INTAKE_DEFAULTS: ChatIntakeSettings = {
  enabled: false,
  windowMinutes: 30,
  maxImages: 10,
  maxTextChars: CHAT_INTAKE_MAX_TEXT_CHARS,
  hourlyLimit: 20,
  expireHours: 24,
  textRetentionDays: 7, // TODO(OQ-162)
}

export const BCS_GO_DEFAULTS: BcsGoSettings = {
  offlineRetentionDays: 7, // TODO(OQ-169)
  maxPreparedPos: 50, // TODO(OQ-169)
}

/** Each key of `stored` that parses, over the defaults: a missing or broken key reads its default, never a guess */
function withDefaults<T extends object>(schema: z.ZodObject, stored: unknown, defaults: T): T {
  const s = stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  const out = { ...defaults } as Record<string, unknown>
  for (const key of Object.keys(defaults)) {
    const parsed = (schema.shape[key] as z.ZodType).safeParse(s[key])
    if (parsed.success && parsed.data !== undefined) out[key] = parsed.data
  }
  return out as T
}

const sectionOf = (settings: unknown, key: string): unknown =>
  settings !== null && typeof settings === 'object' ? (settings as Record<string, unknown>)[key] : undefined

/** settings.chatIntake of stored settings, each missing key read as its default (off unless the organization turned it on) */
export function chatIntakeSettingsOf(settings: unknown): ChatIntakeSettings {
  return withDefaults(ChatIntakeSettingsSchema, sectionOf(settings, 'chatIntake'), CHAT_INTAKE_DEFAULTS)
}

/** settings.bcsGo of stored settings, each missing key read as its default */
export function bcsGoSettingsOf(settings: unknown): BcsGoSettings {
  return withDefaults(BcsGoSettingsSchema, sectionOf(settings, 'bcsGo'), BCS_GO_DEFAULTS)
}
