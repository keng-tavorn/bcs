import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listModules } from '@/server/services/modules'
import { ModuleState } from '@/ui/admin/module-state'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
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
  if (!modules.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {tMembers('homeLink')}
        </Link>
      </div>
    )
  }
  const when = (iso: string) => formatDateTime(locale, iso)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {modules.data.map((m) => (
          <li key={m.module} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
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
    </div>
  )
}
