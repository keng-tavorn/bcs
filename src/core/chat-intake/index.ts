import { MS_PER_MINUTE } from '../money/constants'

// Asking through the LINE chat (BR-LINE-10 to BR-LINE-12, BR-LINE-15 · FR-LINE-301 · golden chat-intake). Pure: the
// service reads the organization's settings, the sender's link, their open draft and their messages of the last hour,
// and passes them in with the time; this module says what to do with one message and what to answer, cuts text and
// titles at a whole character, and says which drafts have expired. The chat never sends a request: a draft becomes a
// request draft only when its owner picks a type in LIFF.

/** Settings the router reads (settings.chatIntake · src/lib/s17-settings.ts) */
export interface ChatRouteSettings {
  readonly enabled: boolean
  readonly windowMinutes: number
  readonly maxImages: number
  /** Code points, as the CHECK of ChatIntake.text counts them */
  readonly maxTextChars: number
  readonly hourlyLimit: number
}

export interface OpenIntakeFacts {
  readonly lastMessageAt: Date
  readonly images: number
  /** Code points of the text kept so far */
  readonly textChars: number
  /** A reply or push already carried the button that opens LIFF (BR-LINE-15) */
  readonly linkSent: boolean
}

export interface ChatMessageFacts {
  readonly settings: ChatRouteSettings
  /** user = a 1:1 chat */
  readonly source: 'user' | 'group' | 'room' | 'other'
  readonly mode: 'active' | 'standby' | 'other'
  /** LINKED_ACTIVE: linked to an ACTIVE member under the channel's provider */
  readonly sender: 'LINKED_ACTIVE' | 'UNLINKED'
  /** LINE's message type: text, image, sticker, … */
  readonly messageType: string
  /** Code points of a text message */
  readonly textChars: number
  readonly now: Date
  /** The member's latest OPEN draft, if any */
  readonly openIntake: OpenIntakeFacts | null
  /** Messages the member sent in the hour before this one */
  readonly sentLastHour: number
  /** The notice that they send too often went out within the last hour already */
  readonly limitNoticeSentThisHour: boolean
  /** The reply token is past LINE_REPLY_TOKEN_TTL_MS (or there is none): only a push can answer */
  readonly replyTokenExpired: boolean
}

export type ChatAction = 'OPEN_NEW' | 'APPEND' | 'LIMIT_IMAGES' | 'UNSUPPORTED' | 'LINK_PROMPT' | 'RATE_LIMITED' | 'IGNORE'
export type ChatReply = 'INTAKE_LINK' | 'INTAKE_LINK_SAME' | 'ADD_IN_LIFF' | 'TEXT_OR_PHOTO_HINT' | 'LINK_PROMPT' | 'RATE_LIMIT_NOTICE' | 'NONE'

export interface ChatRoute {
  readonly action: ChatAction
  readonly reply: ChatReply
  /** How the answer goes: the reply token, or one push of the LIFF button for a draft that never had it */
  readonly via: 'REPLY' | 'PUSH' | null
  /** Text: the code points of this message that are kept (all of them unless the draft reached maxTextChars) */
  readonly keptChars?: number
  readonly textTruncated?: boolean
}

const route = (action: ChatAction, reply: ChatReply, via: ChatRoute['via'] = reply === 'NONE' ? null : 'REPLY'): ChatRoute => ({ action, reply, via })

/** What to do with one message and what to answer (BR-LINE-10, BR-LINE-15) */
export function routeChatMessage(f: ChatMessageFacts): ChatRoute {
  // Off, a group or a room, or another channel answering this chat (standby): as before S17, nothing
  if (!f.settings.enabled || f.source !== 'user' || f.mode !== 'active') return route('IGNORE', 'NONE')
  // Answers other than the LIFF button are never pushed (BR-LINE-15): a reply only, or nothing
  const answer = (action: ChatAction, reply: ChatReply): ChatRoute => (f.replyTokenExpired ? route(action, 'NONE') : route(action, reply))
  if (f.sender !== 'LINKED_ACTIVE') return answer('LINK_PROMPT', 'LINK_PROMPT')
  if (f.sentLastHour >= f.settings.hourlyLimit) return f.limitNoticeSentThisHour ? route('RATE_LIMITED', 'NONE') : answer('RATE_LIMITED', 'RATE_LIMIT_NOTICE')
  if (f.messageType !== 'text' && f.messageType !== 'image') return answer('UNSUPPORTED', 'TEXT_OR_PHOTO_HINT')

  const open = f.openIntake && f.now.getTime() - f.openIntake.lastMessageAt.getTime() < f.settings.windowMinutes * MS_PER_MINUTE ? f.openIntake : null
  if (open && f.messageType === 'image' && open.images >= f.settings.maxImages) return answer('LIMIT_IMAGES', 'ADD_IN_LIFF')
  const action: ChatAction = open ? 'APPEND' : 'OPEN_NEW'
  // The button: by reply while the token works; by one push for a draft that never had it; else nothing
  const link: Pick<ChatRoute, 'reply' | 'via'> = !f.replyTokenExpired
    ? { reply: open ? 'INTAKE_LINK_SAME' : 'INTAKE_LINK', via: 'REPLY' }
    : !open || !open.linkSent
      ? { reply: open ? 'INTAKE_LINK_SAME' : 'INTAKE_LINK', via: 'PUSH' }
      : { reply: 'NONE', via: null }
  if (f.messageType === 'image') return { action, ...link }
  const before = open?.textChars ?? 0
  const room = Math.max(0, f.settings.maxTextChars - before)
  return f.textChars > room ? { action, ...link, keptChars: room, textTruncated: true } : { action, ...link }
}

const segmenter = new Intl.Segmenter('th', { granularity: 'grapheme' })
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (s) => s.segment)

/** Code points of a text, as Postgres char_length counts them */
export const codePoints = (text: string): number => Array.from(text).length

/** The longest start of `text` of whole characters (graphemes: a Thai consonant with its vowels and tone marks) within `max` code points */
export function clipCodePoints(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const g of graphemes(text)) {
    const n = codePoints(g)
    if (used + n > max) break
    out += g
    used += n
  }
  return out
}

/** A draft's title cut to fit DraftInput.title (BR-LINE-12): at most this many UTF-16 code units */
export const CHAT_TITLE_MAX_CODE_UNITS = 200

/** The title of a request drafted from the chat: its first line that is not blank, trimmed, cut at a whole character within 200 UTF-16 code units */
export function titleFromText(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  let out = ''
  for (const g of graphemes(line)) {
    if (out.length + g.length > CHAT_TITLE_MAX_CODE_UNITS) break
    out += g
  }
  return out
}

/** The OPEN drafts nobody used for expireHours (BR-LINE-10): exactly that long ago expires */
export function expiredIntakeIds(now: Date, expireHours: number, intakes: ReadonlyArray<{ readonly id: string; readonly status: string; readonly lastMessageAt: Date }>): string[] {
  return intakes.filter((i) => i.status === 'OPEN' && now.getTime() - i.lastMessageAt.getTime() >= expireHours * 60 * MS_PER_MINUTE).map((i) => i.id)
}
