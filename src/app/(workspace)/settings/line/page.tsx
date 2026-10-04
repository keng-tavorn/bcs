import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getMyLineLink } from '@/server/services/line-link'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { formatDateTime } from '@/ui/format'
import { LineLinkPanel } from '@/ui/settings-line/line-link-panel'
import { getSession } from '../../../_lib/session'
import { issueLineLinkCodeAction, lineLinkStatusAction, unlinkLineAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('lineLink')
  return { title: t('title') }
}

// The member's own LINE account (FR-LINE-001 AC1 AC3, §9.1 /settings/*, §9.2): whether it is linked, linking with a
// one-time code shown as a QR and a link, and unlinking from the web. One column: status first, then what to do next.
// Never the LINE user id: the service does not return it.
export default async function LineAccountPage() {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  const [t, tCommon, locale] = await Promise.all([getTranslations('lineLink'), getTranslations('adminSettings'), getLocale()])
  if (!ctx || state.kind !== 'member') return null
  const link = await getMyLineLink(ctx)
  if (!link.ok) return <NoAccess title={t('title')} message={t('errors.FORBIDDEN')} homeLabel={tCommon('homeLink')} />
  const { available, linked, linkedAt, reachable } = link.data

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <LineLinkPanel
        status={{
          available,
          linked,
          linkedAtText: linkedAt ? formatDateTime(locale, linkedAt) : null,
          reachable,
          // Only where the notice points; /admin/line checks admin.channels itself
          canManageChannel: state.roles.includes('ORG_ADMIN'),
        }}
        issue={issueLineLinkCodeAction}
        linkStatus={lineLinkStatusAction}
        unlink={unlinkLineAction}
      />
    </div>
  )
}
