import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getBudgetOverrun } from '@/server/services/budget/overrun-view'
import { OverrunCancel } from '@/ui/budgets/overrun-cancel'
import { OVERRUN_BADGES, overrunCancellable } from '@/ui/budgets/overrun-model'
import { Refused } from '@/ui/budgets/refused'
import { StatusBadge } from '@/ui/document/badges'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Facts } from '@/ui/request-view/facts'
import { getSession } from '../../../../_lib/session'
import { cancelBudgetOverrunAction } from '../actions'
import { overrunFacts, overrunRequestLabel } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('budgetOverrun')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// One over-budget approval (S6-16 · FR-BUD-101 · §9.1 /budgets/overruns/[id]): its number and state, the source request
// and the budget line, what the request needed and the shortfall asked, what it funded went where — used by the
// request's submit, back to the line at use or lapse, back after use — the reason, who asked and when, and when it was
// approved, lapses and was used. Its requester cancels it while it waits or before it is used; anyone else reading it
// finds the open approval task, which its approvers decide on /tasks/[id]. getBudgetOverrun checks who may read it (who
// asked, who reads the line's budget, who has or had a task on it); the cancel checks who asked again.
export default async function BudgetOverrunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('budgetOverrun'), getLocale()])
  const result = await getBudgetOverrun(ctx, id)
  if (!result.ok) return <Refused title={t('title')} message={result.error.code === 'NOT_FOUND' ? t('detail.notFound') : t('detail.forbidden')} href="/" linkLabel={t('home')} />

  const o = result.data
  const request = overrunRequestLabel(o.request)
  const facts = overrunFacts(t, o, (iso) => formatDateTime(locale, iso))

  return (
    <Page>
      <Link href={`/requests/${o.request.id}`} className={linkClass}>
        {t('detail.toRequest', { label: request })}
      </Link>
      <PageHeader title={t('detail.heading', { number: o.number })}>
        <StatusBadge look={OVERRUN_BADGES[o.status]} label={t(`status.${o.status}`)} className="h-auto self-start text-base whitespace-normal md:text-sm" />
      </PageHeader>
      <PageBody>
        <Panel label={o.number}>
          <Facts
            items={facts.map((f) => ({
              label: f.label,
              value: f.money ? <span className={f.key === 'shortfall' ? 'money font-semibold' : 'money'}>{f.value}</span> : f.key === 'reason' ? <span className="break-words whitespace-pre-line">{f.value}</span> : f.value,
            }))}
          />
          <p className="text-ink-muted">{t(`detail.hint.${o.status}`)}</p>
          {/* Kept on the requester's page whatever its state, so the words of what was just done stay after the page refreshes */}
          {o.mine ? <OverrunCancel overrunId={o.id} number={o.number} cancel={overrunCancellable(o.status, o.mine)} approved={o.status === 'APPROVED'} action={cancelBudgetOverrunAction} /> : null}
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6">
            <Link href={`/requests/${o.request.id}`} className={linkClass}>
              {t('detail.openRequest', { label: request })}
            </Link>
            {o.openTaskId && !o.mine ? (
              <Link href={`/tasks/${o.openTaskId}`} className={linkClass}>
                {t('detail.openTask')}
              </Link>
            ) : null}
          </div>
        </Panel>
      </PageBody>
    </Page>
  )
}
