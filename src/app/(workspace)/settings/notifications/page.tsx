import { Lock } from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getMyNotificationPrefs } from '@/server/services/self/notification-prefs'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { DigestSwitch } from '@/ui/settings-notifications/digest-switch'
import { getSession } from '../../../_lib/session'
import { setDailyDigestAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('notificationSettings')
  return { title: t('title') }
}

// The member's own notification settings (FR-LINE-006 AC3, §9.1 /settings/*): the daily summary on or off, what is always
// sent at once and cannot be switched off (BR-NOTI-04, FR-NOTI-004 AC2), and where notifications arrive. The rest of
// FR-NOTI-004 (main channel, quiet hours) comes with S5-10. Each part in its white card on --surface under the page's
// title (the frame of S16-10).
export default async function NotificationSettingsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon] = await Promise.all([getTranslations('notificationSettings'), getTranslations('adminSettings')])
  if (!ctx) return null
  const prefs = await getMyNotificationPrefs(ctx)
  if (!prefs.ok) return <NoAccess title={t('title')} message={t('errors.FORBIDDEN')} homeLabel={tCommon('homeLink')} />

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel id="digest" title={t('digest.title')} className="max-w-3xl">
          <DigestSwitch initial={prefs.data.digest} save={setDailyDigestAction} />
        </Panel>

        {prefs.data.approvalsAlwaysImmediate ? (
          <Panel id="always" title={t('always.title')} className="max-w-3xl">
            <p className="text-ink-muted">{t('always.intro')}</p>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {(['tasks', 'reminders', 'escalations'] as const).map((key) => (
                <li key={key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                  <span>{t(`always.${key}`)}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-ink-muted">
                    <Lock className="size-4" aria-hidden="true" />
                    {t('always.fixed')}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel id="channel" title={t('channel.title')} className="max-w-3xl">
          <p className="text-ink-muted">{t('channel.text')}</p>
          <Link href="/settings/line" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('channel.manageLine')}
          </Link>
        </Panel>
      </PageBody>
    </Page>
  )
}
