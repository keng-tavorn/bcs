import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai'
import { systemClock } from '@/lib/clock'
import { makeCtx } from '@/server/context'
import { actionLinkCsrf, actionLinkOwner } from '@/server/auth/action-links'
import { viewActionLink } from '@/server/services/approvals/action-link'
import { ActionLinkForm } from '@/ui/approvals/action-link-form'
import { Notice } from '@/ui/form/notice'
import { getSession } from '../../../_lib/session'
import { decideByLinkAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('actionLink')
  return { title: t('metaTitle') }
}

const SUBJECTS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const
const subjectOf = (type: string) => SUBJECTS.find((s) => s === type) ?? 'REQUEST'

function LinkMessage({ title, body, href, label }: { title: string; body: string; href?: string; label?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Notice tone="info">{body}</Notice>
      {href ? (
        <Link href={href} className="self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {label}
        </Link>
      ) : null}
    </div>
  )
}

// Opening a decision link from e-mail (spec BR-TOK-03, FR-NOTI-002 AC2): the page only shows the task — a GET changes
// nothing, since an e-mail scanner may open it. Signing in comes first unless the organization turned that off; the
// decision is the POST of the form, as the member the link was sent to.
export default async function ActionLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const raw = (await params).token
  // a link mangled in transit (a stray %) is just an invalid link
  const link = (() => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  })()
  const t = await getTranslations('actionLink')
  const owner = await actionLinkOwner(link)
  if (!owner) return <LinkMessage title={t('invalidTitle')} body={t('invalidBody')} href="/" label={t('openWorkspace')} />
  const session = await getSession()
  let memberId: string
  let binding: string
  if (session.kind === 'member') {
    if (session.member.organizationId !== owner.organizationId || session.member.id !== owner.memberId) return <LinkMessage title={t('notYoursTitle')} body={t('notYoursBody')} />
    memberId = session.member.id
    binding = session.sessionId
  } else if (owner.requireLogin || session.kind === 'needs-2fa-setup') {
    redirect(`/login?next=${encodeURIComponent(`/a/${link}`)}`)
  } else {
    memberId = owner.memberId
    binding = 'link'
  }

  const ctx = makeCtx({ organizationId: owner.organizationId, actor: { type: 'USER', memberId }, channel: 'EMAIL', now: systemClock.now() })
  const result = await viewActionLink(ctx, link)
  const view = result.ok ? result.data : ({ state: 'TOKEN_INVALID' } as const)
  switch (view.state) {
    case 'NOT_YOURS':
      return <LinkMessage title={t('notYoursTitle')} body={t('notYoursBody')} />
    case 'TOKEN_USED':
      return <LinkMessage title={t('usedTitle')} body={t('usedBody')} href="/" label={t('openWorkspace')} />
    case 'TOKEN_EXPIRED':
      return <LinkMessage title={t('expiredTitle')} body={t('expiredBody')} href="/" label={t('openWorkspace')} />
    case 'TOKEN_INVALID':
      return <LinkMessage title={t('invalidTitle')} body={t('invalidBody')} href="/" label={t('openWorkspace')} />
    case 'CLOSED':
      return <LinkMessage title={t('closedTitle')} body={t('closedBody')} href={`/tasks/${view.taskId}`} label={t('openWorkspace')} />
  }

  const locale = await getLocale()
  const until = locale === 'en' ? formatEnglishBeDateTime(view.expiresAt) : formatThaiDateTime(view.expiresAt)
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t('heading', { subject: t(`subject.${subjectOf(view.subjectType)}`), label: view.label })}</h1>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr] sm:gap-y-2">
        {view.title ? (
          <>
            <dt className="text-ink-muted">{t('titleLabel')}</dt>
            <dd className="mb-2 sm:mb-0">{view.title}</dd>
          </>
        ) : null}
        {view.requester ? (
          <>
            <dt className="text-ink-muted">{t('requesterLabel')}</dt>
            <dd className="mb-2 sm:mb-0">{view.requester}</dd>
          </>
        ) : null}
        {view.amount ? (
          <>
            <dt className="text-ink-muted">{t('amountLabel')}</dt>
            <dd className="font-semibold tabular-nums">{t('baht', { amount: view.amount })}</dd>
          </>
        ) : null}
      </dl>
      {view.inWorkspaceOnly ? (
        <LinkMessage title={t('openWorkspace')} body={t('workspaceOnly')} href={`/tasks/${view.taskId}`} label={t('openWorkspace')} />
      ) : (
        <ActionLinkForm link={link} csrf={actionLinkCsrf(binding, link)} actions={view.actions} workspaceHref={`/tasks/${view.taskId}`} decide={decideByLinkAction} />
      )}
      <p className="text-ink-muted">{t('oneUse', { time: until })}</p>
    </div>
  )
}
