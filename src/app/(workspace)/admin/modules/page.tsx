import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listModules } from '@/server/services/modules'
import { ModuleState } from '@/ui/admin/module-state'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('admin.modules')
  return { title: t('title') }
}

// Modules of the organization, read-only for ORG_ADMIN (FR-ADM-006 AC1, §4.11): only the BCS team switches them.
export default async function ModulesPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tMembers, locale] = await Promise.all([getTranslations('admin.modules'), getTranslations('admin.members'), getLocale()])
  if (!ctx) return null
  const modules = await listModules(ctx)
  if (!modules.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={tMembers('homeLink')} />
  const when = (iso: string) => formatDateTime(locale, iso)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel label={t('title')} className="max-w-3xl">
          <ul className="flex flex-col divide-y divide-line">
            {modules.data.map((m) => (
              <li key={m.module} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium">{t(`names.${m.module}`)}</p>
                  {m.contractRef || m.changedAt ? (
                    <p className="text-base text-ink-muted md:text-sm">
                      {[m.contractRef ? t('contractRef', { ref: m.contractRef }) : null, m.changedAt ? t('changedAt', { time: when(m.changedAt) }) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  ) : null}
                </div>
                <ModuleState enabled={m.enabled} label={m.enabled ? t('on') : t('off')} />
              </li>
            ))}
          </ul>
        </Panel>
      </PageBody>
    </Page>
  )
}
