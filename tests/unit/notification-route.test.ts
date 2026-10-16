// S17-10 (BR-NOTI-05 to BR-NOTI-07, FR-PLT-301 AC1 AC2): the branches of src/core/notification-route the golden
// cases leave out, and every template of LINE_TEMPLATES has its push title in Thai and English (BR-NOTI-06).
import { describe, expect, it } from 'vitest'
import { DIGEST_TEMPLATE, goesByLine, goesByPush, planDelivery, pushAnswerAction, pushMessage, type PushAnswer } from '@/core/notification-route'
import { LINE_TEMPLATES } from '@/server/notifications/line-templates'
import { ownPushTitle, pushOf, pushTitleOf } from '@/server/notifications/push-message'

const everything = { lineLinked: true, lineActive: true, lineReachable: true, appPush: true, activeDevices: 1, bcsGo: true }
const notice = (templateKey: string, data: Record<string, unknown> = {}) => ({ templateKey, data, urgency: 'IMMEDIATE' as const })

describe('[FR-PLT-301/AC1] push goes first with the templates LINE takes (BR-NOTI-05)', () => {
  it('never pushes the daily summary, which still goes by LINE', () => {
    expect(planDelivery(notice(DIGEST_TEMPLATE), everything, LINE_TEMPLATES).channels).toEqual(['LINE', 'EMAIL'])
    expect(goesByPush(DIGEST_TEMPLATE, {}, LINE_TEMPLATES)).toBe(false)
    expect(goesByLine(DIGEST_TEMPLATE, {}, LINE_TEMPLATES)).toBe(true)
  })

  it('skips LINE that is off for the organization or no longer reaches the recipient, and keeps push', () => {
    expect(planDelivery(notice('task.assigned'), { ...everything, lineActive: false }, LINE_TEMPLATES).channels).toEqual(['PUSH', 'EMAIL'])
    expect(planDelivery(notice('task.assigned'), { ...everything, lineReachable: false }, LINE_TEMPLATES).channels).toEqual(['PUSH', 'EMAIL'])
  })

  it('a task escalated to the co-assignee goes by push; to the administrators by e-mail only', () => {
    expect(planDelivery(notice('task.escalated', { role: 'CO_ASSIGNEE' }), everything, LINE_TEMPLATES).channels).toEqual(['PUSH', 'LINE', 'EMAIL'])
    expect(goesByPush('task.escalated', { role: 'ADMIN' }, LINE_TEMPLATES)).toBe(false)
  })

  it('pushes nothing outside the LINE list, even with every switch on', () => {
    expect(planDelivery(notice('admin.module_changed'), everything, LINE_TEMPLATES)).toEqual({ channels: ['EMAIL'], digest: false })
  })
})

describe('[FR-PLT-301/AC1] what a push shows on a locked screen (BR-NOTI-06)', () => {
  it('carries the number and the page only, and the notification id when given', () => {
    expect(pushMessage({ title: 'มีงานรออนุมัติ', data: { number: 'PO-2569-00012', title: 'ปูน', amount: '150000' }, path: '/procurement/pos/p1', notificationId: 'n1' })).toEqual({
      title: 'มีงานรออนุมัติ',
      body: 'PO-2569-00012',
      data: { notificationId: 'n1', path: '/procurement/pos/p1' },
    })
  })

  it('leaves out a number that is missing, not text, or does not look like a document number', () => {
    for (const number of [undefined, 31, '', '2,642,900.00', 'PR 2569 00031', 'x'.repeat(80)]) {
      expect(pushMessage({ title: 't', data: { number }, path: null }).body, String(number)).toBeNull()
    }
  })

  it('every template that goes by LINE, but the daily summary, has its own push title in Thai and English', () => {
    const missing = [...LINE_TEMPLATES].filter((key) => key !== DIGEST_TEMPLATE).flatMap((key) => (['th', 'en'] as const).filter((locale) => ownPushTitle(key, locale) === null).map((locale) => `${key} (${locale})`))
    expect(missing).toEqual([])
  })

  it('a template without one gets the general words, in the recipient organization language', () => {
    expect(pushTitleOf('example.no_title_key', 'th')).toBe('มีการแจ้งเตือนใหม่')
    expect(pushTitleOf('example.no_title_key', 'en')).toBe('New notification')
    expect(pushTitleOf('task.assigned', 'en')).toBe('Waiting for your approval')
    // A key that names a group of titles, not a title, is no title
    expect(ownPushTitle('task', 'th')).toBeNull()
    expect(ownPushTitle('toString', 'th')).toBeNull()
  })

  it('builds the push of a notification from its template and link', () => {
    expect(pushOf({ id: 'n9', templateKey: 'request.approved', data: { number: 'PR-2569-00009', requestId: 'r9' }, href: '/requests/r9' }, 'th')).toEqual({
      title: 'คำขออนุมัติแล้ว',
      body: 'PR-2569-00009',
      data: { notificationId: 'n9', path: '/requests/r9' },
    })
  })
})

describe('[FR-PLT-301/AC2] what each device answer means (BR-NOTI-07)', () => {
  it('a sent push is done', () => {
    expect(pushAnswerAction('SENT')).toBe('DONE')
  })
  it('covers every answer', () => {
    const answers: PushAnswer[] = ['SENT', 'UNREGISTERED', 'INVALID_TOKEN', 'AUTH_401', 'AUTH_403', 'QUOTA_429', 'SERVER_503', 'NETWORK']
    expect(answers.map(pushAnswerAction)).toEqual(['DONE', 'REVOKE_DEVICE_TRY_NEXT', 'REVOKE_DEVICE_TRY_NEXT', 'ALERT_NEXT_CHANNEL', 'ALERT_NEXT_CHANNEL', 'RETRY', 'RETRY', 'RETRY'])
  })
})
