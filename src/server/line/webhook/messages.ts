import type { LineMessage } from '@/integrations/line'

// The texts the webhook answers with (§10.3: short, polite, neutral), in Thai then English: the sender's language is not
// known (an unlinked user has no member, and a member has no language setting yet). Templates live in code (§4.7 rule 5);
// they carry no personal data (BR-NOTI-01). §4.7 rule 5 names src/server/notifications/templates as their place; these
// two replies are not notifications (no Notification row, answered with the reply token of the event) and stay next to
// the webhook until the owner of that folder takes them (S5-08), as the ADR of S5-02 records.

/**
 * A page of the LIFF app (§9.4: one app at /liff, sub-pages as paths) opened from LINE: https://liff.line.me/<LIFF ID> and
 * the path, which LINE appends to the app's endpoint URL.
 * TODO(OQ-16): the default of OQ-16 is a LINE MINI App channel; check with the real channel of D-03 whether its links
 * should use LINE MINI App's own address instead, and keep the one helper of §9.4 for every deep link (cards, rich menus).
 */
export function liffLink(liffId: string, path: string): string {
  return `https://liff.line.me/${encodeURIComponent(liffId)}${path.startsWith('/') ? path : `/${path}`}`
}

const text = (lines: readonly string[]): LineMessage => ({ type: 'text', text: lines.join('\n') })

/** A user who is not linked yet added the account: how to link (FR-LINE-001, the UNLINKED rich menu of §9.5) */
export function linkPromptMessages(linkUrl: string | null): LineMessage[] {
  return [
    text([
      'ยินดีต้อนรับสู่ BCS ระบบจัดซื้อขององค์กร',
      `ผูกบัญชี BCS กับ LINE เพื่อรับงานอนุมัติและการแจ้งเตือนที่นี่ โดยแตะ "ผูกบัญชี" ที่เมนูด้านล่าง${linkUrl ? ` หรือเปิด ${linkUrl}` : ''}`,
      '',
      'Welcome to BCS, your organization’s procurement system.',
      `Link your BCS account to receive approvals and notifications here: tap "Link account" in the menu below${linkUrl ? ` or open ${linkUrl}` : ''}.`,
    ]),
  ]
}

/** A linked member added the account again (or for the first time after linking) */
export function welcomeBackMessages(): LineMessage[] {
  return [
    text([
      'ยินดีต้อนรับกลับสู่ BCS คุณจะได้รับงานอนุมัติและการแจ้งเตือนทาง LINE อีกครั้ง',
      '',
      'Welcome back to BCS. You will receive approvals and notifications on LINE again.',
    ]),
  ]
}
