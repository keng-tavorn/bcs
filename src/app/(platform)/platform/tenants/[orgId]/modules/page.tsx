import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { platformCtx } from '@/server/auth/session'
import { listModules } from '@/server/services/modules'
import { getTenant } from '@/server/services/platform/tenants'
import { ModuleState } from '@/ui/admin/module-state'
import { ModuleSwitch } from '@/ui/admin/module-switch'
import { formatDateTime } from '@/ui/format'
import { Notice } from '@/ui/form/notice'
import { getPlatformSession } from '../../../../../_lib/session'
import { setModuleAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('platform.modules')
  return { title: t('titleShort') }
}

// Modules of one customer (FR-ADM-006 AC1 · §9.1 /platform/tenants/[orgId]/modules): state of every module, and a
// form per optional module to switch it with a contract reference and a reason. CORE is always on.
export default async function TenantModulesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const state = await getPlatformSession()
  const [t, tModules, locale] = await Promise.all([getTranslations('platform.modules'), getTranslations('admin.modules'), getLocale()])
  if (state.kind !== 'platform-admin') return null
  const tenant = await getTenant(state.platformAdminId, orgId)
  if (!tenant.ok && tenant.error.code === 'NOT_FOUND') notFound()
  const ctx = tenant.ok ? platformCtx(state, tenant.data.id, systemClock.now()) : null
  const modules = ctx ? await listModules(ctx) : null
  if (!tenant.ok || !modules?.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('titleShort')}</h1>
        <Notice tone="danger">{t('errors.FORBIDDEN')}</Notice>
      </div>
    )
  }
  const names = Object.fromEntries(modules.data.map((m) => [m.module, tModules(`names.${m.module}`)]))
  const when = (iso: string) => formatDateTime(locale, iso)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href="/platform/tenants" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
        {t('back')}
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title', { name: tenant.data.name })}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {modules.data.map((m) => (
          <li key={m.module} className="flex flex-col gap-2 py-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="flex flex-col gap-0.5">
                <p className="font-medium">
                  {tModules(`names.${m.module}`)}
                  {/* The code is for the BCS team only; customer screens show the name alone */}
                  <span className="ml-2 font-normal text-ink-muted">{t('code', { code: m.module })}</span>
                </p>
                {m.contractRef || m.changedAt ? (
                  <p className="text-base text-ink-muted md:text-sm">
                    {[m.contractRef ? tModules('contractRef', { ref: m.contractRef }) : null, m.changedAt ? tModules('changedAt', { time: when(m.changedAt) }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
              <ModuleState enabled={m.enabled} label={m.enabled ? tModules('on') : tModules('off')} />
            </div>
            {m.module === 'CORE' ? (
              <p className="text-base text-ink-muted md:text-sm">{t('coreAlwaysOn')}</p>
            ) : (
              <ModuleSwitch organizationId={tenant.data.id} module={m.module} enabled={m.enabled} names={names} setModule={setModuleAction} />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
