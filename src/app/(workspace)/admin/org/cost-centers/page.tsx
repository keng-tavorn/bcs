import { CircleCheck, CircleSlash } from 'lucide-react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getOrgStructureForAdmin } from '@/server/services/org-structure/view'
import { CostCenterRowActions, CreateCostCenterForm } from '@/ui/admin-org/cost-center-forms'
import { nameIn } from '@/ui/admin-org/names'
import { OrgSubnav } from '@/ui/admin-org/subnav'
import { Notice } from '@/ui/form/notice'
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
  if (!structure.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const { costCenters, departments } = structure.data

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <OrgSubnav current="costCenters" label={t('tabs.label')} labels={{ departments: t('tabs.departments'), costCenters: t('tabs.costCenters'), positions: t('tabs.positions') }} />

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-12">
        <section aria-labelledby="list" className="flex min-w-0 flex-col gap-4">
          <h2 id="list" className="text-xl font-semibold">
            {t('costCenters.listTitle', { count: costCenters.length })}
          </h2>
          {costCenters.length === 0 ? (
            <p className="border-y border-line py-4 text-ink-muted">{t('costCenters.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {costCenters.map((c) => (
                <li key={c.id} className="flex flex-col gap-2 py-3">
                  <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="font-medium break-words">
                        {c.nameTh}
                        <span className="font-normal text-ink-muted"> · {c.code}</span>
                      </p>
                      <p className="text-base text-ink-muted md:text-sm">{t('costCenters.department', { name: nameIn(locale, c.department) })}</p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-base md:text-sm">
                      {c.active ? <CircleCheck className="size-4 text-primary" aria-hidden="true" /> : <CircleSlash className="size-4 text-ink-muted" aria-hidden="true" />}
                      <span>{c.active ? t('costCenters.active') : t('costCenters.inactive')}</span>
                    </span>
                  </div>
                  <CostCenterRowActions costCenter={{ id: c.id, code: c.code, nameTh: c.nameTh, active: c.active }} update={updateCostCenterAction} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="add" className="flex flex-col gap-4">
          <h2 id="add" className="text-xl font-semibold">
            {t('costCenters.createTitle')}
          </h2>
          <p className="text-ink-muted">{t('costCenters.createIntro')}</p>
          <CreateCostCenterForm departments={departments.map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth }))} create={createCostCenterAction} />
        </section>
      </div>
    </div>
  )
}
