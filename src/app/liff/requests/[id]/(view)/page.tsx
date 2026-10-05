import { getLocale, getTranslations } from 'next-intl/server'
import { cache, type ReactNode } from 'react'
import { getRequestAccess, getRequestView, isUuid, type RequestViewDto } from '@/server/queries/requests'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffCancelRequest } from '@/ui/liff/requests/cancel'
import { LiffRequestScreen } from '@/ui/liff/requests/requester'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { PlaceFacts, type PlaceFact } from '@/ui/request-view/place'
import { RequestStatus, StateLine } from '@/ui/request-view/status'
import { Timeline } from '@/ui/timeline/timeline'
import { canViewRequest } from '../../../../(workspace)/_tracking/access'
import { doaRefText, dueText, localeOf, memberName, nameIn, stageText, timelineItems, waitingText, when, type Locale, type ViewT } from '../../../../(workspace)/_tracking/present'
import { RequestFacts, RequestSections } from '../../../../(workspace)/_tracking/request-sections'
import { liffHref } from '../../../_lib/links'
import { liffPage } from '../../../_lib/session'
import { answerInfoAction, cancelRequestAction, downloadUrlAction, resubmitReturnedAction } from '../../actions'
import { liffDraftHref } from '../../_lib/form'
import { liffPrincipalOf } from '../../_lib/principal'

/** Who may view the request, read once per render (the title and the page ask it with the same context) */
const requestAccess = cache(getRequestAccess)

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('requestView')
  const page = await liffPage()
  if (page.kind !== 'member' || !isUuid(id)) return { title: t('listTitle') }
  // The title names the document only for those who may view it
  const access = await requestAccess(page.ctx, id)
  if (!access || !canViewRequest(await liffPrincipalOf(page.member.id), access)) return { title: t('listTitle') }
  return { title: access.number ? t('detail.metaTitle', { number: access.number }) : t('detail.draftLabel') }
}

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

// /liff/requests/[id] (§9.4 "รายละเอียดคำขอ", FR-INT-008 AC1 AC2, FR-DOA-005 AC2): one request in LINE, as the workspace's
// request page shows it — the same read model (getRequestView), the same parts and words — in one column: where it is
// now, who it waits for and for how long, what the requester has to do (FR-INT-009: answer a question, send a returned
// request again, go on with a draft — its main button in the bar at the bottom of the screen, §9.9), the timeline as
// stamps with who, position, when, the channel of every step (LINE (LIFF), แชท LINE, เว็บ, อีเมล) and the DOA rule it was
// decided under ("DOA-DEMO ฉบับ 1 ข้อ PR-02"), then the amounts, the budget, the route and why, the lines, details and
// files. The approval card and its confirmation in the LINE chat open this page (scene 2), and so do the LINE messages
// about a question or a return. request.view is checked before anything is read, with the member's roles (the requester
// and followers, everyone who had a task on it, organization-wide roles), as on the web. DOA references are text here:
// the DOA version's page is a workspace page for administrators.
export default async function LiffRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [tv, tl, tlr, locale, page] = await Promise.all([getTranslations('requestView'), getTranslations('timeline'), getTranslations('liffRequests.view'), getLocale().then(localeOf), liffPage()])
  const track = liffHref('/requests') ?? '/liff/track'
  const back = { href: track, label: tv('detail.back') }
  const screen = (title: string, content: ReactNode) => (
    <LiffFrame title={title} back={back}>
      <LiffContent>{content}</LiffContent>
    </LiffFrame>
  )
  if (page.kind !== 'member') return screen(tlr('title'), <LiffGate mode="member" state={page.kind} />)

  const access = isUuid(id) ? await requestAccess(page.ctx, id) : null
  const notFound = screen(
    tlr('notFoundTitle'),
    <>
      <LiffNotice tone="warning">{tlr('notFound')}</LiffNotice>
      <LiffLink href={track}>{tv('detail.back')}</LiffLink>
    </>,
  )
  if (!access) return notFound
  if (!canViewRequest(await liffPrincipalOf(page.member.id), access)) {
    return screen(
      tv('detail.forbidden'),
      <>
        <LiffNotice tone="warning">{tv('detail.forbiddenHint')}</LiffNotice>
        <LiffLink href={track}>{tv('detail.back')}</LiffLink>
      </>,
    )
  }
  const view = await getRequestView(page.ctx, id)
  if (!view) return notFound

  const mine = view.requester.id === page.member.id
  const stage = view.stage
  const rejection = view.status === 'REJECTED' ? (view.track.filter((e) => e.what === 'REJECTED').at(-1)?.note ?? null) : null
  const items = timelineItems(tv, tl, locale, view.track, { stepCount: view.route?.steps.length ?? 1, doaLinks: false })
  const question =
    mine && view.openInfoRequest
      ? {
          infoRequestId: view.openInfoRequest.id,
          text: view.openInfoRequest.question,
          askedLine: tv('actions.answerAsked', { name: memberName(locale, view.openInfoRequest.askedBy), time: when(locale, view.openInfoRequest.askedAt) }),
        }
      : null
  const returned = view.status === 'RETURNED' ? { reason: view.returnReason } : null
  const draft = view.status === 'DRAFT'
  const editHref = view.actions.canEdit ? liffDraftHref(view.id) : null
  const waited = stage.kind === 'APPROVER' ? waitingText(tv, stage.waitingMinutes) : null

  const header = (
    <header className="flex flex-col gap-3">
      <h2 className="text-xl leading-snug font-semibold break-words">{view.title}</h2>
      <div className="flex flex-col gap-1.5 border-l-4 border-line pl-3">
        <RequestStatus status={view.status} label={tv(`status.${view.status}`)} />
        <p className="text-ink">
          <span className="text-ink-muted">{tv('detail.nowTitle')}: </span>
          {stageText(tv, locale, stage, mine)}
        </p>
        {waited ? <StateLine kind="waiting">{waited}</StateLine> : null}
        {stage.kind === 'APPROVER' && stage.dueAt ? <StateLine kind={stage.overdue ? 'overdue' : 'due'}>{dueText(tv, locale, stage.dueAt, stage.overdue)}</StateLine> : null}
        {view.approvedUnder ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink">{tv('detail.approvedUnder')}</span>
            <DoaRef label={doaRefText(tl, view.approvedUnder)} />
          </p>
        ) : null}
        {rejection ? <p className="break-words whitespace-pre-line text-ink">{tv('detail.rejectedReason', { reason: rejection })}</p> : null}
        {view.cancelReason ? <p className="break-words whitespace-pre-line text-ink">{tv('detail.cancelledReason', { reason: view.cancelReason })}</p> : null}
      </div>
    </header>
  )

  const body = (
    <>
      {/* The status story first on a phone: the timeline as stamps (§9.9 principle 4), then the document */}
      <LiffSection id="liff-timeline" title={tv('timeline.title')}>
        <Timeline items={items} label={tv('timeline.label')} />
      </LiffSection>

      <LiffSection id="liff-facts" title={tv('facts.title')}>
        <RequestFacts view={view} locale={locale} />
        {view.documentType === 'PURCHASE_REQUEST' ? <PlaceFacts items={placeFacts(tv, locale, view)} /> : null}
      </LiffSection>

      <RequestSections view={view} locale={locale} openFile={downloadUrlAction.bind(null, view.id)} doaLinks={false} />
      {mine ? <LiffCancelRequest requestId={view.id} canCancel={view.actions.canCancel} cancel={cancelRequestAction} /> : null}
    </>
  )

  return (
    <LiffFrame title={view.number ?? tv('detail.draftLabel')} back={back}>
      {mine ? (
        // The requester: what to do now, with its main button at the bottom of the screen (§9.9), whatever the state
        <LiffRequestScreen
          active={Boolean(question || returned || (draft && editHref))}
          header={header}
          requestId={view.id}
          question={question}
          returned={returned}
          draft={draft}
          editHref={editHref}
          canResubmit={view.actions.canResubmit}
          actions={{ answer: answerInfoAction, resubmit: resubmitReturnedAction }}
        >
          {body}
        </LiffRequestScreen>
      ) : (
        <LiffContent>
          {header}
          {body}
        </LiffContent>
      )}
    </LiffFrame>
  )
}
