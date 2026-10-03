import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { listTenants } from '@/server/services/platform/tenants'
import { Notice } from '@/ui/form/notice'
import { getPlatformSession } from '../../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('platform.tenants')
  return { title: t('title') }
}

// Customer organizations for the BCS team (§9.1 /platform/tenants): name, code and status only (BR-AUTH-08).
export default async function TenantsPage() {
  const state = await getPlatformSession()
  const [t, tStatus] = await Promise.all([getTranslations('platform.tenants'), getTranslations('platform.orgStatus')])
  if (state.kind !== 'platform-admin') return null
  const tenants = await listTenants(state.platformAdminId)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      {!tenants.ok ? (
        <Notice tone="danger">{t('forbidden')}</Notice>
      ) : tenants.data.length === 0 ? (
        <Notice tone="info">{t('empty')}</Notice>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {tenants.data.map((org) => (
            <li key={org.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">{org.name}</p>
                <p className="text-base text-ink-muted md:text-sm">
                  {org.code} · {tStatus(org.status)}
                </p>
              </div>
              <Link href={`/platform/tenants/${org.id}/modules`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
                {t('manageModules', { name: org.name })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
