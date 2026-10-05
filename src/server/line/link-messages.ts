import type { LineMessage } from '@/integrations/line'

// What BCS says in the chat about the link itself (FR-LINE-001, §10.3: short, polite, neutral words), in Thai then
// English like the webhook's replies (src/server/line/webhook/messages.ts): the reader's language setting is not known
// in LINE. No personal data (BR-NOTI-01): not the member's name, not the organization, nothing of their work.
// The welcome is a confirmation of the member's own action, pushed once right after the link, not a notification (no
// Notification row, no e-mail fallback): it stays next to the link rather than in src/server/notifications/templates
// (§4.7 rule 5), as the webhook's replies do, until the owner of that folder takes it.
// Unlinking from LINE is done in the LIFF app (unlinkMyLine with a LIFF session), not from the chat: a chat button
// would be a postback without an action token, which BR-TOK-02 does not allow.

const text = (lines: readonly string[]): LineMessage => ({ type: 'text', text: lines.join('\n') })

/** Pushed once a member linked this LINE account (§9.2 step 2: "ส่งข้อความต้อนรับ") */
export function lineLinkedMessages(): LineMessage[] {
  return [
    text([
      'ผูกบัญชี BCS กับ LINE นี้แล้ว คุณจะได้รับงานอนุมัติและการแจ้งเตือนที่นี่',
      'ใช้เมนูด้านล่างเพื่อขอซื้อ ดูงานรออนุมัติ และติดตามสถานะคำขอ',
      '',
      'Your BCS account is now linked to this LINE account. Approvals and notifications will come here.',
      'Use the menu below to make a request, see the tasks waiting for you and track your requests.',
    ]),
  ]
}
