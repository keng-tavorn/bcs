// What the decision of an e-mail link returns to its form (spec BR-TOK-03, BR-TOK-04, FR-NOTI-002 AC2, §9.9 rule 7):
// success, or the error code with what the page needs to say what happened — never the raw message. TOKEN_USED: the
// task was decided already — with this link, on the web, in LIFF, from the chat, or by the other approver of an escalated
// step (BR-SLA-04) — and the page says when, and by whom in the reader's language, as the LINE button and the decision
// page do (§9.3 "ดำเนินการแล้วโดย … เมื่อ …", §14.2 TOKEN_USED, FR-DOA-004 AC2). Only a member signed in as the one the
// link was sent to is told who: when the organization lets a link decide without signing in
// (email.actionLinksRequireLogin off), whoever holds a forwarded link hears when the task was decided, never another
// approver's name (ADR-050 item 4 waits for the user). The service refuses anybody else's link before it reads a name.

export type ActionLinkOutcome =
  | { readonly ok: true; readonly decision: 'APPROVE' | 'REJECT' }
  | {
      readonly ok: false
      readonly code: string
      /** TOKEN_USED: who decided the task, in the reader's language — told only to the signed-in member of the link */
      readonly name?: string
      /** TOKEN_USED: when the task was decided (ISO 8601) */
      readonly time?: string
    }

export type ActionLinkFailure = Extract<ActionLinkOutcome, { ok: false }>

/** Who reads the answer: signed in as the member the link was sent to, or holding the link alone; and their language */
export interface LinkReader {
  readonly signedIn: boolean
  readonly locale: string
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

/**
 * The refusal of a link's decision, for its page: the code; and for TOKEN_USED when the task was decided and — to a
 * signed-in reader — by whom, by the English name for an English reader (the service gives the Thai name as stored and
 * the English one, the Thai one when there is none)
 */
export function linkRefusal(error: { readonly code: string; readonly details?: Readonly<Record<string, unknown>> }, reader: LinkReader): ActionLinkFailure {
  if (error.code !== 'TOKEN_USED') return { ok: false, code: error.code }
  const d = error.details ?? {}
  const time = text(d.time)
  const name = reader.signedIn ? (reader.locale === 'en' ? (text(d.nameEn) ?? text(d.name)) : text(d.name)) : undefined
  return { ok: false, code: 'TOKEN_USED', ...(name ? { name } : {}), ...(time ? { time } : {}) }
}
