import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getTenantKind, getTenant } from '@/server/services/platform/tenants'
import { SandboxForm } from '@/ui/admin/sandbox-form'
import { Notice } from '@/ui/form/notice'
import { getPlatformSession } from '../../../../_lib/session'
import { createSandboxAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('platform.tenant')
  return { title: t('titleShort') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// One customer organization for the BCS team (§9.1 /platform/tenants/[orgId] · S6-21 · FR-PLT-101 AC1): its name, code,
// status and kind — the live system, or the UAT sandbox of which organization — the ways to its modules and AI credits,
// and, for a live organization, the form that makes its UAT sandbox with a contract reference and a reason. No business
// data of the customer shows here (BR-AUTH-08), and nothing of it is copied into the sandbox (BR-UAT-04, NG-12).
export default async function TenantPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params
  const state = await getPlatformSession()
  const [t, tTenants, tStatus] = await Promise.all([getTranslations('platform.tenant'), getTranslations('platform.tenants'), getTranslations('platform.orgStatus')])
  if (state.kind !== 'platform-admin') return null
  const [tenant, kind] = await Promise.all([getTenant(state.platformAdminId, orgId), getTenantKind(state.platformAdminId, orgId)])
  if (!tenant.ok && tenant.error.code === 'NOT_FOUND') notFound()
  if (!tenant.ok || !kind.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('titleShort')}</h1>
        <Notice tone="danger">{tTenants('forbidden')}</Notice>
      </div>
    )
  }
  const org = tenant.data
  const { sandboxOf } = kind.data

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href="/platform/tenants" className={linkClass}>
        {t('back')}
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold break-words">{org.name}</h1>
        <p className="text-ink-muted">{t('code', { code: org.code, status: tStatus(org.status) })}</p>
      </div>

      <section aria-labelledby="tenant-kind" className="flex flex-col gap-2 border-y border-line py-4">
        <h2 id="tenant-kind" className="text-base font-semibold">
          {t('kindTitle')}
        </h2>
        {kind.data.kind === 'PRODUCTION' ? (
          <p>{t('PRODUCTION')}</p>
        ) : sandboxOf ? (
          <>
            <p>{t('SANDBOX', { name: sandboxOf.name, code: sandboxOf.code })}</p>
            <Link href={`/platform/tenants/${sandboxOf.id}`} className={linkClass}>
              {t('openProduction', { name: sandboxOf.name })}
            </Link>
          </>
        ) : (
          <p>{t('sandboxUnknown')}</p>
        )}
        <Link href={`/platform/tenants/${org.id}/modules`} className={linkClass}>
          {tTenants('manageModules', { name: org.name })}
        </Link>
        <Link href={`/platform/tenants/${org.id}/ai`} className={linkClass}>
          {tTenants('manageAi', { name: org.name })}
        </Link>
      </section>

      <section aria-labelledby="tenant-sandbox" className="flex flex-col gap-3">
        <h2 id="tenant-sandbox" className="text-xl font-semibold">
          {t('sandbox.title')}
        </h2>
        {kind.data.kind === 'PRODUCTION' ? (
          <>
            <p className="text-ink-muted">{t('sandbox.intro', { name: org.name })}</p>
            <Notice tone="info">{t('sandbox.noCopy')}</Notice>
            <SandboxForm organizationId={org.id} example={`${org.code}-UAT`} createSandbox={createSandboxAction} />
          </>
        ) : (
          <Notice tone="info">{t('sandbox.nested')}</Notice>
        )}
      </section>
    </div>
  )
}
