import { Lock } from 'lucide-react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getMyNotificationPrefs } from '@/server/services/self/notification-prefs'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { DigestSwitch } from '@/ui/settings-notifications/digest-switch'
import { getSession } from '../../../_lib/session'
import { setDailyDigestAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('notificationSettings')
  return { title: t('title') }
}

// The member's own notification settings (FR-LINE-006 AC3, §9.1 /settings/*): the daily summary on or off, what is always
// sent at once and cannot be switched off (BR-NOTI-04, FR-NOTI-004 AC2), and where notifications arrive. The rest of
// FR-NOTI-004 (main channel, quiet hours) comes with S5-10.
export default async function NotificationSettingsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon] = await Promise.all([getTranslations('notificationSettings'), getTranslations('adminSettings')])
  if (!ctx) return null
  const prefs = await getMyNotificationPrefs(ctx)
  if (!prefs.ok) return <NoAccess title={t('title')} message={t('errors.FORBIDDEN')} homeLabel={tCommon('homeLink')} />

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>

      <section aria-labelledby="digest" className="flex flex-col gap-3">
        <h2 id="digest" className="text-xl font-semibold">
          {t('digest.title')}
        </h2>
        <DigestSwitch initial={prefs.data.digest} save={setDailyDigestAction} />
      </section>

      {prefs.data.approvalsAlwaysImmediate ? (
        <section aria-labelledby="always" className="flex flex-col gap-3 border-t border-line pt-6">
          <h2 id="always" className="text-xl font-semibold">
            {t('always.title')}
          </h2>
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
        </section>
      ) : null}

      <section aria-labelledby="channel" className="flex flex-col gap-3 border-t border-line pt-6">
        <h2 id="channel" className="text-xl font-semibold">
          {t('channel.title')}
        </h2>
        <p className="text-ink-muted">{t('channel.text')}</p>
        <Link href="/settings/line" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('channel.manageLine')}
        </Link>
      </section>
    </div>
  )
}
