import { getLocale, getTranslations } from 'next-intl/server'
import { listMySessions } from '@/server/auth/sessions'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { revokeDeviceAction } from './actions'
import { formatDateTime } from '@/ui/format'

export async function generateMetadata() {
  const t = await getTranslations('auth.security')
  return { title: t('title') }
}

/** "Chrome · Windows" from a user-agent string; product names only, nothing personal. */
function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null
  const browser = /Line\//.test(userAgent)
    ? 'LINE'
    : /Edg\//.test(userAgent)
      ? 'Edge'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null
  return [browser, os].filter(Boolean).join(' · ') || null
}

// Account security (FR-AUTH-002, FR-AUTH-003 AC3). The workspace layout has already made sure the member is signed in
// and has 2FA set up, so this page shows the 2FA status and the signed-in devices, each in its white card on --surface
// under the page's title (the frame of S16-10).
export default async function SecurityPage() {
  const state = await getSession()
  if (state.kind !== 'member') return null
  const [t, locale] = await Promise.all([getTranslations('auth.security'), getLocale()])
  const devices = await listMySessions(state.userId, state.sessionId)
  const when = (iso: string) => formatDateTime(locale, iso)

  return (
    <Page>
      <PageHeader title={t('title')} />
      <PageBody>
        <Panel id="two-factor" title={t('twoFactorTitle')} className="max-w-3xl">
          <Notice tone="success">
            <p>{t('enabled')}</p>
            <p className="text-base text-ink-muted md:text-sm">{t('enabledHint')}</p>
          </Notice>
        </Panel>

        <Panel id="devices" title={t('devicesTitle')} className="max-w-3xl">
          <ul className="flex flex-col divide-y divide-line">
            {devices.map((device) => (
              <li key={device.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">
                    {describeDevice(device.userAgent) ?? t('deviceUnknown')}
                    {device.current ? <span className="ml-2 text-base text-primary md:text-sm">({t('deviceCurrent')})</span> : null}
                  </p>
                  <p className="text-base text-ink-muted md:text-sm">
                    {t('deviceSince', { time: when(device.createdAt) })}
                    {device.lastActiveAt ? <span> · {t('deviceLastActive', { time: when(device.lastActiveAt) })}</span> : null}
                  </p>
                </div>
                {device.current ? null : (
                  <form action={revokeDeviceAction}>
                    <input type="hidden" name="sessionId" value={device.id} />
                    <Button type="submit" variant="secondary">
                      {t('signOutDevice')}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </PageBody>
    </Page>
  )
}
