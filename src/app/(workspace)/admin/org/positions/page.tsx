import { LockOpen, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getOrgStructureForAdmin } from '@/server/services/org-structure/view'
import { nameIn } from '@/ui/admin-org/names'
import { PositionHolders } from '@/ui/admin-org/position-forms'
import { OrgSubnav } from '@/ui/admin-org/subnav'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../../../_lib/session'
import { assignHolderAction, endHolderAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminOrg')
  return { title: t('positions.title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

// Positions and their holders (FR-ADM-002 AC2, BR-DOA-17, ADR-042 item 2). A position the DOA relies on — a version in
// effect, to come or awaiting approval names it, or open approval tasks came from it — changes holders only through a
// proposal the governance approver approves; the others are assigned or ended here at once.
export default async function PositionsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminOrg'), getLocale()])
  if (!ctx) return null
  const structure = await getOrgStructureForAdmin(ctx)
  if (!structure.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <Notice tone="danger">{t('forbidden')}</Notice>
        <Link href="/" className={`${linkClass} self-start`}>
          {t('homeLink')}
        </Link>
      </div>
    )
  }
  const { positions, departments, members } = structure.data
  // Positions the DOA relies on first: their holders matter most and change only by approval
  const ordered = [...positions].sort((a, b) => Number(b.authority) - Number(a.authority) || a.code.localeCompare(b.code))
  const departmentOptions = departments.map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, nameEn: d.nameEn, depth: d.depth, root: d.parentId === null }))
  const memberOptions = members.map((m) => ({ id: m.id, nameTh: m.nameTh, nameEn: m.nameEn, employeeCode: m.employeeCode }))

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <OrgSubnav current="positions" label={t('tabs.label')} labels={{ departments: t('tabs.departments'), costCenters: t('tabs.costCenters'), positions: t('tabs.positions') }} />
      <p className="max-w-3xl text-ink-muted">{t('positions.intro')}</p>

      {ordered.length === 0 ? <p className="border-y border-line py-4 text-ink-muted">{t('positions.empty')}</p> : null}
      <div className="flex max-w-4xl flex-col gap-10">
        {ordered.map((p) => {
          const positionName = nameIn(locale, p)
          return (
            <section key={p.code} aria-labelledby={`position-${p.code}`} className="flex flex-col gap-4 border-t border-line pt-6">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                <h2 id={`position-${p.code}`} className="text-xl font-semibold break-words">
                  {positionName}
                  <span className="font-normal text-ink-muted"> · {p.code}</span>
                </h2>
                <p className="text-base text-ink-muted md:text-sm">{t(`positions.scope.${p.scope}`)}</p>
              </div>
              <p className="flex items-start gap-2">
                {p.authority ? <ShieldCheck className="mt-1 size-4 shrink-0 text-warn" aria-hidden="true" /> : <LockOpen className="mt-1 size-4 shrink-0 text-ink-muted" aria-hidden="true" />}
                <span>{p.namedByDoa ? t('positions.authority') : p.authority ? t('positions.openTasksOnly') : t('positions.noAuthority')}</span>
              </p>

              {p.authority ? (
                <>
                  {p.holders.length === 0 ? (
                    <p className="border-y border-line py-3 text-ink-muted">{t('positions.vacant')}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-line border-y border-line">
                      {p.holders.map((h) => {
                        const holder = nameIn(locale, h.member)
                        const department = nameIn(locale, { nameTh: h.departmentNameTh, nameEn: h.departmentNameEn })
                        return (
                          <li key={`${h.departmentId}-${h.member.id}`} className="flex flex-col gap-2 py-3">
                            <div className="flex flex-col gap-0.5">
                              <p className="font-medium">{t('positions.holderLine', { name: holder, department })}</p>
                              <p className="text-base text-ink-muted md:text-sm">
                                {t('positions.since', { date: formatDateTime(locale, h.since) })}
                                {h.openTasks > 0 ? ` · ${t('positions.openTasks', { count: h.openTasks })}` : ''}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-x-6 gap-y-1">
                              <Link href={`/admin/org-authority/new?kind=POSITION_ASSIGN&position=${p.code}&department=${h.departmentId}`} className={linkClass}>
                                {t('positions.proposeReplace', { name: holder })}
                              </Link>
                              <Link href={`/admin/org-authority/new?kind=POSITION_END&position=${p.code}&department=${h.departmentId}`} className={linkClass}>
                                {t('positions.proposeEnd', { name: holder })}
                              </Link>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <Link href={`/admin/org-authority/new?kind=POSITION_ASSIGN&position=${p.code}`} className={`${linkClass} self-start`}>
                    {t('positions.proposeAssign', { position: positionName })}
                  </Link>
                </>
              ) : (
                <PositionHolders
                  position={{ code: p.code, name: positionName, scope: p.scope }}
                  holders={p.holders.map((h) => ({
                    departmentId: h.departmentId,
                    department: nameIn(locale, { nameTh: h.departmentNameTh, nameEn: h.departmentNameEn }),
                    name: nameIn(locale, h.member),
                    since: t('positions.since', { date: formatDateTime(locale, h.since) }),
                  }))}
                  departments={departmentOptions}
                  members={memberOptions}
                  assign={assignHolderAction}
                  end={endHolderAction}
                />
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
