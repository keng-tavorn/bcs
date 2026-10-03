import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { RouteView } from '@/server/services/doa/view'
import { listOrgChangesForAdmin, type ChangeDetails, type OrgChangeView } from '@/server/services/org-authority/view'
import { ChangeStatus } from '@/ui/admin-org/change-status'
import { ChangeSummary, type ChangeSummaryInput } from '@/ui/admin-org/change-summary'
import { nameIn } from '@/ui/admin-org/names'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('adminOrg.authority')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const IN_PROGRESS = new Set<OrgChangeView['status']>(['PENDING_APPROVAL', 'SCHEDULED', 'DRAFT'])

// Authority changes (FR-DOA-010, §9.1 /admin/org-authority): those waiting for approval or for their effective time
// first, then the history; each says what it changes (one sentence, no label above it), when it takes effect — the
// time it applied once it has, "as soon as approved" for those that wait for nothing else — why, its impact, and its
// route: who decides under which DOA rule, and what they decided.
export default async function OrgAuthorityPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, locale] = await Promise.all([getTranslations('adminOrg.authority'), getLocale()])
  if (!ctx) return null
  const changes = await listOrgChangesForAdmin(ctx)
  if (!changes.ok) {
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
  const inProgress = changes.data.filter((c) => IN_PROGRESS.has(c.status))
  const history = changes.data.filter((c) => !IN_PROGRESS.has(c.status))
  const when = (iso: string) => formatDateTime(locale, iso)
  const name = (p: { nameTh: string; nameEn: string | null }) => nameIn(locale, p)

  const summaryOf = (d: ChangeDetails): ChangeSummaryInput => {
    switch (d.kind) {
      case 'POSITION_ASSIGN':
        return { kind: d.kind, position: `${name(d.position)} (${d.position.code})`, department: name(d.department), member: name(d.member) }
      case 'POSITION_END':
        return { kind: d.kind, position: `${name(d.position)} (${d.position.code})`, department: name(d.department), replacement: d.replacement ? name(d.replacement) : null }
      case 'DEPARTMENT_REPARENT':
        return { kind: d.kind, department: name(d.department), parent: name(d.newParent) }
      case 'DELEGATION_ON_BEHALF':
        return { kind: d.kind, delegator: name(d.delegator), delegate: name(d.delegate), startsAt: d.startsAt, endsAt: d.endsAt, documentTypes: d.documentTypes, maxAmount: d.maxAmount }
      case 'IDENTITY_RESET':
        return { kind: d.kind, member: name(d.member) }
    }
  }

  const routeLines = (route: RouteView) => {
    const ref = route.initialPackage ? t('initialPackage') : t('doaRef', { code: route.doaCode, version: route.versionNo, rule: route.ruleCode })
    return route.tasks
      .filter((task) => task.status !== 'REASSIGNED' && task.status !== 'CANCELLED')
      .map((task) => {
        const who = task.onBehalfOf ? t('onBehalf', { name: name(task.assignee), principal: name(task.onBehalfOf) }) : name(task.assignee)
        if (task.status === 'APPROVED') return t('routeApproved', { name: task.decidedBy ? name(task.decidedBy) : who, time: when(task.decidedAt ?? task.assignedAt), ref })
        if (task.status === 'REJECTED') return t('routeRejected', { name: task.decidedBy ? name(task.decidedBy) : who, time: when(task.decidedAt ?? task.assignedAt), ref })
        return t('routeWaiting', { name: who, ref })
      })
  }

  const effective = (c: OrgChangeView) => {
    if (c.appliedAt) return t('effectiveApplied', { time: when(c.appliedAt) })
    if (c.onApproval) return c.kind === 'DELEGATION_ON_BEHALF' ? t('effectiveOnApprovalDelegation') : t('effectiveOnApproval')
    return when(c.effectiveFrom)
  }

  const item = (c: OrgChangeView) => {
    // A change that was not approved (or was cancelled) never took effect: its time and impact are what was proposed
    const closed = c.status === 'REJECTED' || c.status === 'CANCELLED'
    const gains = c.impact?.gains.map(name) ?? []
    const loses = c.impact?.loses.map(name) ?? []
    const tasks = c.impact?.openTasks
      ? t('impactTasks', { count: c.impact.openTasks })
      : c.impact?.openTasksStay
        ? t('impactTasksStay', { count: c.impact.openTasksStay, names: loses.length ? loses.join(', ') : t('formerHolder') })
        : null
    return (
      <li key={c.id} className="flex flex-col gap-2 py-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          {c.details ? <ChangeSummary input={summaryOf(c.details)} className="min-w-0 font-medium break-words" /> : <p className="font-medium">{t('summary.unreadableKind', { kind: t(`kinds.${c.kind}`) })}</p>}
          <ChangeStatus status={c.status} label={t(`status.${c.status}`)} className="shrink-0" />
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-base sm:grid-cols-[10rem_1fr] md:text-sm">
          <dt className="text-ink-muted">{closed ? t('effectiveProposedLabel') : t('effectiveLabel')}</dt>
          <dd>{effective(c)}</dd>
          <dt className="text-ink-muted">{t('reasonLabel')}</dt>
          <dd className="break-words">{c.reason}</dd>
          <dt className="text-ink-muted">{t('proposedByLabel')}</dt>
          <dd>{c.submittedAt ? t('proposedBy', { name: name(c.submittedBy), time: when(c.submittedAt) }) : name(c.submittedBy)}</dd>
          {c.impact && (gains.length || loses.length || tasks) ? (
            <>
              <dt className="text-ink-muted">{closed ? t('impactProposedLabel') : t('impactLabel')}</dt>
              <dd>
                {[gains.length ? t('impactGains', { names: gains.join(', ') }) : null, loses.length ? t('impactLoses', { names: loses.join(', ') }) : null, tasks].filter(Boolean).join(' · ')}
              </dd>
            </>
          ) : null}
          {c.route ? (
            <>
              <dt className="text-ink-muted">{t('routeLabel')}</dt>
              <dd>
                {routeLines(c.route).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </li>
    )
  }

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
      </div>
      <Link href="/admin/org-authority/new" className="inline-flex h-11 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_85%,black)]">
        {t('propose')}
      </Link>

      {changes.data.length === 0 ? (
        <p className="border-y border-line py-4 text-ink-muted">{t('empty')}</p>
      ) : (
        <>
          <section aria-labelledby="in-progress" className="flex flex-col gap-3">
            <h2 id="in-progress" className="text-xl font-semibold">
              {t('inProgressTitle', { count: inProgress.length })}
            </h2>
            {inProgress.length ? <ul className="flex flex-col divide-y divide-line border-y border-line">{inProgress.map(item)}</ul> : <p className="border-y border-line py-4 text-ink-muted">{t('inProgressEmpty')}</p>}
          </section>
          <section aria-labelledby="history" className="flex flex-col gap-3">
            <h2 id="history" className="text-xl font-semibold">
              {t('historyTitle', { count: history.length })}
            </h2>
            {history.length ? <ul className="flex flex-col divide-y divide-line border-y border-line">{history.map(item)}</ul> : <p className="border-y border-line py-4 text-ink-muted">{t('historyEmpty')}</p>}
          </section>
        </>
      )}
    </div>
  )
}
