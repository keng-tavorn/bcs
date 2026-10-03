import { EmailSendError, getEmailProvider } from '@/integrations/email-provider'
import { getEnv } from '@/lib/env'
import { forTenant } from '@/server/db/tenant'
import { emailLinkPath } from '@/server/tokens/action-tokens'
import { renderNotification } from './templates'

// Delivering an IMMEDIATE notification (spec §4.7 rule 2, FR-NOTI-002 AC1): by LINE when the recipient linked LINE,
// the organization has the LINE channel and LINE still reaches them, otherwise by e-mail. The LINE channel comes in
// S5, so until then every immediate notification goes by e-mail. A task.assigned e-mail carries the task's action
// link (/a/<token>, BR-TOK-03) beside the link into the workspace. Sending state is delivery bookkeeping on the
// Notification row, like the outbox's: a run claims the row first, so a job that runs twice sends once; a provider
// that refused the message for good marks it FAILED, one that could not be reached frees it for the job's retry.

export type DeliveryOutcome = { readonly status: 'SENT' | 'FAILED'; readonly channel: 'EMAIL'; readonly code?: string } | { readonly status: 'SKIPPED'; readonly why: string }

export async function deliverNotification(organizationId: string, notificationId: string, now: Date): Promise<DeliveryOutcome> {
  const db = forTenant(organizationId)
  const n = await db.notification.findFirst({
    where: { id: notificationId },
    select: { id: true, templateKey: true, data: true, urgency: true, status: true, subjectType: true, subjectId: true, recipientMemberId: true, recipient: { select: { email: true, status: true } } },
  })
  if (!n) return { status: 'SKIPPED', why: 'NOT_FOUND' }
  if (n.urgency !== 'IMMEDIATE' || n.status !== 'PENDING') return { status: 'SKIPPED', why: n.status }
  // Claim: one run sends it
  const claimed = await db.notification.updateMany({ where: { id: n.id, status: 'PENDING', sentChannel: null }, data: { sentChannel: 'EMAIL' } })
  if (claimed.count !== 1) return { status: 'SKIPPED', why: 'CLAIMED' }
  if (n.recipient.status !== 'ACTIVE') {
    await db.notification.update({ where: { id: n.id }, data: { status: 'FAILED', error: 'MEMBER_INACTIVE' } })
    return { status: 'FAILED', channel: 'EMAIL', code: 'MEMBER_INACTIVE' }
  }

  const appUrl = getEnv().APP_URL.replace(/\/$/, '')
  const th = renderNotification(n, 'th')
  const en = renderNotification(n, 'en')
  const data = (n.data ?? {}) as Record<string, unknown>
  // FR-NOTI-002 AC1: an approval task's e-mail decides with its link (one use, 72 hours, BR-TOK-01)
  const token =
    n.templateKey === 'task.assigned' && typeof data.taskId === 'string'
      ? await db.actionToken.findFirst({ where: { taskId: data.taskId, memberId: n.recipientMemberId, channel: 'EMAIL', usedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { id: true } })
      : null
  const workspace = th.href ? `${appUrl}${th.href}` : appUrl
  const action = token ? `${appUrl}${emailLinkPath(token.id)}` : null
  const text = [
    th.title,
    ...(th.body ? [th.body] : []),
    '',
    ...(action ? [`พิจารณาจากลิงก์นี้ (ใช้ได้ครั้งเดียว): ${action}`] : []),
    `เปิดในระบบ: ${workspace}`,
    '',
    en.title,
    ...(en.body ? [en.body] : []),
    ...(action ? [`Decide with this link (one use): ${action}`] : []),
    `Open in BCS: ${workspace}`,
    '',
  ].join('\n')
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const link = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}</a>`
  const html = [
    '<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6">',
    `<p><strong>${escape(th.title)}</strong></p>`,
    ...(th.body ? [`<p>${escape(th.body)}</p>`] : []),
    ...(action ? [`<p>${link(action, 'พิจารณาจากลิงก์นี้')} (ใช้ได้ครั้งเดียว)</p>`] : []),
    `<p>${link(workspace, 'เปิดในระบบ')}</p>`,
    '<hr style="border: none; border-top: 1px solid #ddd">',
    `<p style="color: #555">${escape(en.title)}${en.body ? ` — ${escape(en.body)}` : ''}</p>`,
    ...(action ? [`<p style="color: #555">${link(action, 'Decide with this link')} (one use)</p>`] : []),
    `<p style="color: #555">${link(workspace, 'Open in BCS')}</p>`,
    '</div>',
  ].join('\n')

  try {
    await getEmailProvider().send({ to: n.recipient.email, subject: th.title, text, html })
  } catch (error) {
    if (error instanceof EmailSendError && error.permanent) {
      await db.notification.update({ where: { id: n.id }, data: { status: 'FAILED', error: error.code } })
      return { status: 'FAILED', channel: 'EMAIL', code: error.code }
    }
    // Not reached: free the claim so the job's retry sends it
    await db.notification.update({ where: { id: n.id }, data: { sentChannel: null } })
    throw error
  }
  await db.notification.update({ where: { id: n.id }, data: { status: 'SENT', sentAt: now } })
  return { status: 'SENT', channel: 'EMAIL' }
}
