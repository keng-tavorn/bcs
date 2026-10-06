import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getOrgStructureForAdmin } from '@/server/services/org-structure/view'
import { CreateDepartmentForm, DepartmentRowActions } from '@/ui/admin-org/department-forms'
import { nameIn } from '@/ui/admin-org/names'
import { OrgSubnav } from '@/ui/admin-org/subnav'
import { cn } from '@/ui/cn'
import { Notice } from '@/ui/form/notice'
import { getSession } from '../../../_lib/session'
import { createDepartmentAction, renameDepartmentAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('adminOrg')
  return { title: t('departments.title') }
}

// Indentation of a department by its depth in the tree (a fixed set of classes, so Tailwind sees them all)
const INDENT = ['ml-0', 'ml-0', 'ml-5', 'ml-10', 'ml-14', 'ml-18', 'ml-22'] as const

// Organization structure: departments (FR-ADM-002 AC1, §9.1 /admin/org). Wide screens: the tree on the left, the add
// form on the right. Phones: the tree first, then the form. Moving a department is proposed as an authority change.
export default async function DepartmentsPage() {
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
  const { departments } = structure.data
  const parents = departments.map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth }))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <OrgSubnav current="departments" label={t('tabs.label')} labels={{ departments: t('tabs.departments'), costCenters: t('tabs.costCenters'), positions: t('tabs.positions') }} />

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-12">
        <section aria-labelledby="tree" className="flex min-w-0 flex-col gap-4">
          <h2 id="tree" className="text-xl font-semibold">
            {t('departments.listTitle', { count: departments.length })}
          </h2>
          <p className="text-ink-muted">{t('departments.moveHint')}</p>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {departments.map((d) => {
              const name = nameIn(locale, d)
              return (
                <li key={d.id} className="py-3">
                  <div className={cn('flex min-w-0 flex-col gap-1', INDENT[Math.min(d.depth, INDENT.length - 1)], d.depth > 0 && 'border-l-2 border-line pl-3')}>
                    <p className="font-medium break-words">
                      {name}
                      <span className="font-normal text-ink-muted"> · {d.code}</span>
                    </p>
                    <p className="text-base text-ink-muted md:text-sm">
                      {d.parentId === null ? t('departments.root') : t(`kinds.${d.kind}`)} · {t('departments.costCenters', { count: d.costCenters })}
                    </p>
                    <DepartmentRowActions department={{ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, root: d.parentId === null }} name={name} rename={renameDepartmentAction} />
                  </div>
                </li>
              )
            })}
          </ul>
        </section>

        <section aria-labelledby="add" className="flex flex-col gap-4">
          <h2 id="add" className="text-xl font-semibold">
            {t('departments.createTitle')}
          </h2>
          <p className="text-ink-muted">{t('departments.createIntro')}</p>
          <CreateDepartmentForm parents={parents} create={createDepartmentAction} />
        </section>
      </div>
    </div>
  )
}
