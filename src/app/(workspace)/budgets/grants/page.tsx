import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { budgetGrantsView, type BudgetGrantViewRow } from '@/server/services/budget/grants'
import { GrantForm } from '@/ui/budgets/grant-form'
import { GrantLists, type GrantRowView } from '@/ui/budgets/grant-lists'
import { Refused } from '@/ui/budgets/refused'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { dayText, localeOf, nameIn, type Locale } from '../_present'
import { createBudgetGrantAction, revokeBudgetGrantAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('budgets.grants')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

type GrantsT = Awaited<ReturnType<typeof getTranslations<'budgets.grants'>>>

function rowView(t: GrantsT, locale: Locale, g: BudgetGrantViewRow): GrantRowView {
  const when = (at: string) => formatDateTime(locale, at)
  const period = g.days
    ? g.days.last
      ? t('period', { from: dayText(locale, g.days.first), to: dayText(locale, g.days.last) })
      : t('periodOpen', { from: dayText(locale, g.days.first) })
    : g.validTo
      ? t('period', { from: when(g.validFrom), to: when(g.validTo) })
      : t('periodOpen', { from: when(g.validFrom) })
  const grantee =
    g.grantee.kind === 'DEPARTMENT'
      ? t('granteeDepartment', { name: nameIn(locale, g.grantee.name) })
      : g.grantee.employeeCode
        ? t('granteeMember', { name: nameIn(locale, g.grantee.name), code: g.grantee.employeeCode })
        : t('granteeMemberShort', { name: nameIn(locale, g.grantee.name) })
  return {
    id: g.id,
    state: g.state,
    stateLabel: t(`state.${g.state}`),
    line: `${g.line.code} · ${g.line.nameTh}`,
    owner: t('rowOwner', { department: nameIn(locale, g.line.department) }),
    grantee,
    period,
    granted: t('rowGranted', { name: nameIn(locale, g.grantedBy), time: when(g.grantedAt) }),
    revoked: g.revokedAt ? t('rowRevoked', { time: when(g.revokedAt) }) : null,
    revocable: g.state === 'ACTIVE' || g.state === 'SCHEDULED',
  }
}

// Cross-department budget use (spec FR-BUD-004 AC1, BR-BUD-04, S3-07): BUDGET_ADMIN lets another department, or one
// member, use a budget line for whole days, and takes it back; the grants in force and coming, then those that ended.
// Wide screens: the lists on the left, the form on the right; phones: the form first. budgetGrant.manage is checked by
// the services on every read and change.
export default async function BudgetGrantsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tb, locale] = await Promise.all([getTranslations('budgets.grants'), getTranslations('budgets'), getLocale().then(localeOf)])
  const view = await budgetGrantsView(ctx)
  if (!view.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={tb('home')} />
  const v = view.data

  return (
    <Page>
      <Link href="/budgets" className={linkClass}>
        {tb('back')}
      </Link>
      <PageHeader title={t('title')} intro={t('intro')} />

      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel title={t('formTitle')} id="grant-form" className="lg:col-start-2 lg:row-start-1">
            <GrantForm
              lines={v.lines.map((l) => ({ id: l.id, code: l.code, label: t('lineOption', { code: l.code, name: l.nameTh, department: nameIn(locale, l.department) }), departmentId: l.departmentId, fiscalYearEnds: l.fiscalYearEnds }))}
              departments={v.departments.map((d) => ({ id: d.id, name: nameIn(locale, d.name), label: t('departmentOption', { name: nameIn(locale, d.name), code: d.code }) }))}
              members={v.members.map((m) => {
                const name = nameIn(locale, m.name)
                const department = m.department ? nameIn(locale, m.department) : null
                const label = m.employeeCode
                  ? department
                    ? t('memberOption', { name, code: m.employeeCode, department })
                    : t('memberOptionShort', { name, code: m.employeeCode })
                  : department
                    ? `${name} · ${department}`
                    : name
                return { id: m.id, name, label }
              })}
              today={v.today}
              create={createBudgetGrantAction}
            />
          </Panel>
          <div className="lg:col-start-1 lg:row-start-1">
            <GrantLists current={v.current.map((g) => rowView(t, locale, g))} past={v.past.map((g) => rowView(t, locale, g))} revoke={revokeBudgetGrantAction} />
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
