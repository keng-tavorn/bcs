import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { CONFIG_PACKAGE_MAX_CHARS } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { effectiveDates } from '@/server/services/doa/dates'
import { ExportConfigForm, ImportConfigForm } from '@/ui/admin-config/config-forms'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { exportConfigAction, importConfigAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('configPackages')
  return { title: t('title') }
}

// The configuration package (S6-21 · FR-PLT-101 AC2 · BR-UAT-02 BR-UAT-03 · §9.1 /admin/config): what an organization
// tried on its UAT sandbox goes to production as a file. Export on the left (the sections ticked, saved as JSON with its
// checksum), import on the right (the file, the date the DOA and workflow drafts would start, a reason) — on a phone
// the export first, then the import. Each card shows only to whom holds its capability; the services check it again.
// The import makes drafts only, and the page says so before the file is chosen: each goes through its own approval.
export default async function ConfigPackagesPage() {
  const state = await getSession()
  const t = await getTranslations('configPackages')
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const principal = memberPrincipal(state.member.id, state.roles)
  const canExport = isAllowed(principal, 'config.export')
  const canImport = isAllowed(principal, 'config.import')
  if (!canExport && !canImport) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  // The drafts start, once approved, on the first of next month unless the admin picks another day (as a new DOA draft does)
  const { defaultDate } = effectiveDates(ctx.now, null)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
          {canExport ? (
            <Panel title={t('export.title')} id="config-export">
              <p className="text-ink-muted">{t('export.intro')}</p>
              <ExportConfigForm exportPackage={exportConfigAction} />
            </Panel>
          ) : null}
          {canImport ? (
            <Panel title={t('import.title')} id="config-import">
              <p className="text-ink-muted">{t('import.intro')}</p>
              <ImportConfigForm importPackage={importConfigAction} defaultDate={defaultDate} maxChars={CONFIG_PACKAGE_MAX_CHARS} />
            </Panel>
          ) : null}
        </div>
      </PageBody>
    </Page>
  )
}
