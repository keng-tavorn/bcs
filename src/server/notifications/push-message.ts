import { pushMessage, type PushMessage } from '@/core/notification-route'
import en from '../../../messages/src/en/push.json'
import th from '../../../messages/src/th/push.json'
import type { NotificationLocale } from './templates'

// The push of a notification (BR-NOTI-06, S17-10): one builder for every template. The title is the template's own
// words from the message files (push.<templateKey>.title, Thai and English, e.g. push.task.assigned.title), or the
// general "มีการแจ้งเตือนใหม่" / "New notification" for a template without them; the body is the document's number and
// nothing else (core/notification-route pushMessage). tests/unit/push-titles.test.ts checks every template of
// LINE_TEMPLATES has its title in both languages.

type Titles = { readonly [key: string]: Titles | string }
const TITLES: Readonly<Record<NotificationLocale, Titles>> = { th, en }

/** push.<templateKey>.title in the locale, or null when the template has none */
export function ownPushTitle(templateKey: string, locale: NotificationLocale): string | null {
  let node: Titles | string | undefined = TITLES[locale]
  for (const part of [...templateKey.split('.'), 'title']) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return null
    node = node[part]
  }
  return typeof node === 'string' && node !== '' ? node : null
}

export function pushTitleOf(templateKey: string, locale: NotificationLocale): string {
  return ownPushTitle(templateKey, locale) ?? ownPushTitle('fallback', locale)!
}

/** What a notification's push says and carries: its title, the document's number, its id and the page in the app */
export function pushOf(n: { readonly id: string; readonly templateKey: string; readonly data: Readonly<Record<string, unknown>>; readonly href: string | null }, locale: NotificationLocale): PushMessage {
  return pushMessage({ title: pushTitleOf(n.templateKey, locale), data: n.data, path: n.href, notificationId: n.id })
}
