import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { ModuleState } from '@/ui/admin/module-state'
import { getOrgStructureForAdmin } from '@/server/services/org-structure/view'
import { CostCenterRowActions, CreateCostCenterForm } from '@/ui/admin-org/cost-center-forms'
import { nameIn } from '@/ui/admin-org/names'
import { OrgSubnav } from '@/ui/admin-org/subnav'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { getSession } from '../../../../_lib/session'
import { createCostCenterAction, updateCostCenterAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminOrg')
  return { title: t('costCenters.title') }
}

// Cost centers (FR-ADM-002 AC1, ADR-042 item 5): every cost center with its department and whether it is in use; add,
// rename, switch off and on. Wide screens: the list on the left, the add form on the right.
export default async function CostCentersPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminOrg'), getLocale()])
  if (!ctx) return null
  const structure = await getOrgStructureForAdmin(ctx)
  if (!structure.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const { costCenters, departments } = structure.data

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <OrgSubnav current="costCenters" label={t('tabs.label')} labels={{ departments: t('tabs.departments'), costCenters: t('tabs.costCenters'), positions: t('tabs.positions') }} />

        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel title={t('costCenters.listTitle', { count: costCenters.length })} id="list">
            {costCenters.length === 0 ? (
              <ListEmpty title={t('costCenters.empty')} />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {costCenters.map((c) => (
                  <li key={c.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="font-medium break-words">
                          {c.nameTh}
                          <span className="font-normal text-ink-muted"> · {c.code}</span>
                        </p>
                        <p className="text-base text-ink-muted md:text-sm">{t('costCenters.department', { name: nameIn(locale, c.department) })}</p>
                      </div>
                      {/* In use or switched off: the same on/off badge as a module's */}
                      <ModuleState enabled={c.active} label={c.active ? t('costCenters.active') : t('costCenters.inactive')} />
                    </div>
                    <CostCenterRowActions costCenter={{ id: c.id, code: c.code, nameTh: c.nameTh, active: c.active }} update={updateCostCenterAction} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t('costCenters.createTitle')} id="add">
            <p className="text-ink-muted">{t('costCenters.createIntro')}</p>
            <CreateCostCenterForm departments={departments.map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth }))} create={createCostCenterAction} />
          </Panel>
        </div>
      </PageBody>
    </Page>
  )
}
