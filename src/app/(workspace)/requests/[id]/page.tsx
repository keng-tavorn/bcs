import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { getRequestAccess, getRequestView, type RequestViewDto } from '@/server/queries/requests'
import { getRequestFollowers } from '@/server/services/requests/followers'
import { Notice } from '@/ui/form/notice'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { PlaceFacts, type PlaceFact } from '@/ui/request-view/place'
import { FollowButton, FollowersPanel } from '@/ui/request-view/followers'
import { CancelRequest, RequesterActions } from '@/ui/request-view/requester-actions'
import { RequestStatus, StateLine } from '@/ui/request-view/status'
import { Timeline } from '@/ui/timeline/timeline'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { canOpenDoaVersion, canViewRequest } from '../../_tracking/access'
import { doaHref, doaRefText, dueText, localeOf, memberName, nameIn, stageText, stageWaitingMinutes, timelineItems, waitingText, when, type Locale, type ViewT } from '../../_tracking/present'
import { RequestFacts, RequestSections } from '../../_tracking/request-sections'
import { answerInfoAction, cancelRequestAction, followAction, manageFollowerAction } from './actions'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('requestView')
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  const access = ctx ? await getRequestAccess(ctx, id) : null
  // The title names the document only for those who may view it
  if (!access || state.kind !== 'member' || !canViewRequest(memberPrincipal(state.member.id, state.roles), access)) return { title: t('listTitle') }
  return { title: access.number ? t('detail.metaTitle', { number: access.number }) : t('detail.draftLabel') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** The delivery site (with its address) and the suggested supplier, or what stands in for them when there is none */
function placeFacts(tv: ViewT, locale: Locale, view: RequestViewDto): PlaceFact[] {
  const site = view.deliverySite
  const supplier = view.suggestedSupplier
  return [
    {
      label: tv('facts.deliverySite'),
      value: site ? tv('facts.deliverySiteValue', { code: site.code, name: site.name }) : tv('facts.deliverySiteNone'),
      detail: site?.address ?? null,
      set: site !== null,
    },
    {
      label: tv('facts.suggestedSupplier'),
      value: supplier ? tv('facts.suggestedSupplierValue', { code: supplier.code, name: nameIn(locale, supplier.name) }) : tv('facts.suggestedSupplierNone'),
      detail: null,
      set: supplier !== null,
    },
  ]
}

// One request (spec §9.1 /requests/[id], FR-INT-008 AC1, FR-DOA-003 AC2, FR-DOA-005 AC2, FR-PLT-003 AC3, FR-INT-009):
// where it is now and for how long, what the requester has to do, the totals and the budget it holds, the route the DOA
// engine chose and why, the lines, details and attachments, and the timeline as stamps. request.view is checked before
// anything is read: the requester and followers, everyone who had a task on it, and the organization-wide roles. Anybody
// who may view it but the requester follows it from the header; the requester adds and removes followers (FR-INT-013).
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [tv, tl, locale] = await Promise.all([getTranslations('requestView'), getTranslations('timeline'), getLocale().then(localeOf)])

  const access = await getRequestAccess(ctx, id)
  if (!access) notFound()
  const principal = memberPrincipal(state.member.id, state.roles)
  if (!canViewRequest(principal, access)) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{tv('detail.forbidden')}</h1>
        <Notice tone="warning">{tv('detail.forbiddenHint')}</Notice>
        <Link href="/" className={linkClass}>
          {tv('detail.home')}
        </Link>
      </div>
    )
  }

  const [view, follow] = await Promise.all([getRequestView(ctx, id), getRequestFollowers(ctx, id)])
  if (!view) notFound()
  const named = (m: { id: string; name: { th: string; en: string | null } }) => ({ id: m.id, name: memberName(locale, m) })
  const mine = view.requester.id === state.member.id
  const stage = view.stage
  const rejection = view.status === 'REJECTED' ? (view.track.filter((e) => e.what === 'REJECTED').at(-1)?.note ?? null) : null
  // DOA references link to the version only for those who may open it (ORG_ADMIN); everyone else reads them as text
  const doaLinks = canOpenDoaVersion(principal)
  const items = timelineItems(tv, tl, locale, view.track, { stepCount: view.route?.steps.length ?? 1, doaLinks })
  const closed = view.status === 'CANCELLED' || view.status === 'REJECTED' || view.status === 'COMPLETED' || view.status === 'DONE'
  const question = mine && view.openInfoRequest
    ? { infoRequestId: view.openInfoRequest.id, text: view.openInfoRequest.question, askedLine: tv('actions.answerAsked', { name: memberName(locale, view.openInfoRequest.askedBy), time: when(locale, view.openInfoRequest.askedAt) }) }
    : null

  return (
    <div className="flex flex-col gap-6">
      <Link href="/requests" className={linkClass}>
        {tv('detail.back')}
      </Link>

      <header className="flex max-w-4xl flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-ink-muted">{view.number ?? tv('detail.draftLabel')}</p>
            <h1 className="text-2xl font-semibold break-words">{view.title}</h1>
          </div>
          {follow?.canFollow ? <FollowButton requestId={view.id} following={follow.following} follow={followAction} /> : null}
        </div>
        <div className="flex flex-col gap-1.5 border-l-4 border-line pl-3">
          <RequestStatus status={view.status} label={tv(`status.${view.status}`)} />
          <p className="text-ink">
            <span className="text-ink-muted">{tv('detail.nowTitle')}: </span>
            {stageText(tv, locale, stage, mine)}
          </p>
          {/* How long it has waited, whoever it waits for: an approver, the requester, procurement or a supplier (§9.9 principle 4) */}
          {waitingText(tv, stageWaitingMinutes(stage)) ? <StateLine kind="waiting">{waitingText(tv, stageWaitingMinutes(stage))}</StateLine> : null}
          {stage.kind === 'APPROVER' && stage.dueAt ? <StateLine kind={stage.overdue ? 'overdue' : 'due'}>{dueText(tv, locale, stage.dueAt, stage.overdue)}</StateLine> : null}
          {view.approvedUnder ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink">{tv('detail.approvedUnder')}</span>
              <DoaRef label={doaRefText(tl, view.approvedUnder)} href={doaLinks ? doaHref(view.approvedUnder.versionId) : null} />
            </p>
          ) : null}
          {rejection ? <p className="break-words whitespace-pre-line text-ink">{tv('detail.rejectedReason', { reason: rejection })}</p> : null}
          {view.cancelReason ? <p className="break-words whitespace-pre-line text-ink">{tv('detail.cancelledReason', { reason: view.cancelReason })}</p> : null}
        </div>
      </header>

      {mine && !closed ? (
        <RequesterActions
          requestId={view.id}
          question={question}
          returned={view.status === 'RETURNED' ? { reason: view.returnReason } : null}
          draft={view.status === 'DRAFT'}
          editHref={view.actions.canEdit ? `/requests/${view.id}/edit` : null}
          actions={{ answer: answerInfoAction }}
        />
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex flex-col gap-3">
            <RequestFacts view={view} locale={locale} />
            {/* Where the goods go and the supplier the requester suggested (S4-02), with the facts above */}
            {view.documentType === 'PURCHASE_REQUEST' ? <PlaceFacts items={placeFacts(tv, locale, view)} /> : null}
          </div>
          <RequestSections view={view} locale={locale} openFile={downloadUrlAction} doaLinks={doaLinks} />
          {mine ? <CancelRequest requestId={view.id} canCancel={view.actions.canCancel} cancel={cancelRequestAction} /> : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          {follow ? (
            <FollowersPanel
              requestId={view.id}
              followers={follow.followers.map(named)}
              canManage={follow.canManage}
              candidates={follow.candidates.map(named)}
              manage={manageFollowerAction}
            />
          ) : null}
          <section aria-labelledby="timeline" className="flex flex-col gap-3">
            <h2 id="timeline" className="text-lg font-semibold text-ink">
              {tv('timeline.title')}
            </h2>
            <Timeline items={items} label={tv('timeline.label')} />
          </section>
        </aside>
      </div>
    </div>
  )
}
