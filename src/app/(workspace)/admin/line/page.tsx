import { getTranslations } from 'next-intl/server'
import { MS_PER_SECOND } from '@/lib/constants'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getLineChannelSettings, LINE_CONNECTION_TEST_BUDGET_MS } from '@/server/services/line-channel'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { LineChannelPanel } from '@/ui/admin-line/line-channel-panel'
import { getSession } from '../../../_lib/session'
import { replaceRichMenusAction, saveLineChannelAction, testLineConnectionAction } from './actions'
import { toLineChannelView } from './view'

export async function generateMetadata() {
  const t = await getTranslations('lineSettings')
  return { title: t('title') }
}

// The organization's LINE channel (FR-ADM-006 AC2 AC3, §9.1 /admin/*, §9.2, §9.5): the values from LINE Developers
// Console, the webhook URL to give LINE, the connection test and the rich menus. ORG_ADMIN only (admin.channels, checked
// by the service): anybody else sees whose page this is. The secret and the token are never on this page, only whether
// each is set.
export default async function LineSettingsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tCommon] = await Promise.all([getTranslations('lineSettings'), getTranslations('adminSettings')])
  if (!ctx) return null
  const settings = await getLineChannelSettings(ctx)
  if (!settings.ok) return <NoAccess title={t('title')} message={tCommon('forbidden')} homeLabel={tCommon('homeLink')} />

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <LineChannelPanel
        initial={toLineChannelView(settings.data)}
        testSeconds={Math.ceil(LINE_CONNECTION_TEST_BUDGET_MS / MS_PER_SECOND)}
        save={saveLineChannelAction}
        test={testLineConnectionAction}
        replaceMenus={replaceRichMenusAction}
      />
    </div>
  )
}
