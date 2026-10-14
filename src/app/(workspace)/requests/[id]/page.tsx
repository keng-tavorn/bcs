import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import { businessDaysTaken, getMyOpenTaskId, getRouteStepDetails, listRequestPurchaseOrders } from '@/server/queries/document-page'
import { getPoAccess } from '@/server/queries/purchase-orders'
import { getRequestAccess, getRequestView, getServiceLines, type RequestViewDto } from '@/server/queries/requests'
import { getTaskAccess, getTaskView } from '@/server/queries/tasks'
import { getRequestFollowers } from '@/server/services/requests/followers'
import { Notice } from '@/ui/form/notice'
import { PO_BADGES, REQUEST_BADGES, StatusBadge, URGENCY_BADGES } from '@/ui/document/badges'
import { DecisionBar } from '@/ui/document/decision-bar'
import { DocBody, DocHeader } from '@/ui/document/doc-header'
import { CANCEL_ANCHOR, DocMenu } from '@/ui/document/doc-header-parts'
import { DocTabs, type DocTab } from '@/ui/document/doc-tabs'
import { tabFrom } from '@/ui/document/tab-param'
import { HistoryTable } from '@/ui/document/history-table'
import { CommentList, PoCards, SummaryList, type PoCardView } from '@/ui/document/rail'
import { StepCards } from '@/ui/document/step-cards'
import { Toaster } from '@/ui/shadcn/sonner'
import { AttachmentList } from '@/ui/request-view/attachments'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Section } from '@/ui/request-view/facts'
import { PlaceFacts, type PlaceFact } from '@/ui/request-view/place'
import { FollowButton, FollowersPanel } from '@/ui/request-view/followers'
import { RenewLines, ReorderButton } from '@/ui/request-view/repeat-actions'
import { canRenew, canReorder } from '@/ui/request-view/repeat-rules'
import { CancelRequest, RequesterActions } from '@/ui/request-view/requester-actions'
import { StateLine } from '@/ui/request-view/status'
import { BYTES_PER_KIB } from '@/lib/constants'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { canOpenDoaVersion, canViewRequest, taskRight } from '../../_tracking/access'
import { requestBudgetState } from '../../_tracking/budget-state'
import { commentViews, historyRows, requestHistoryKinds, routeWhy, stepCards } from '../../_tracking/document-present'
import { day, doaHref, doaRefText, dueText, fileKind, localeOf, memberName, money, nameIn, stageText, stageWaitingMinutes, timelineItems, waitingText, when, type Locale, type ViewT } from '../../_tracking/present'
import { RequestFacts, RequestSections } from '../../_tracking/request-sections'
import { canViewPo } from '../../procurement/pos/_parts/access'
import { askForInformationAction, decideTaskAction } from '../../tasks/actions'
import { answerInfoAction, cancelRequestAction, followAction, manageFollowerAction, renewLineAction, reorderAction } from './actions'

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

const CLOSED_STATUSES: readonly string[] = ['CANCELLED', 'REJECTED', 'COMPLETED', 'DONE']

// One request as a tabbed document (spec §9.1 /requests/[id], FR-INT-012, FR-INT-008 AC1, FR-DOA-003 AC2, FR-DOA-005 AC2,
// FR-PLT-003 AC3, FR-INT-009, FR-INT-013): the header with its number, title, badges, follow button, menu and summary row;
// the tabs — overview (where it is now, the route as step cards that turn into stamps, the budget it holds and its POs),
// items and budget, documents, POs and receiving (only POs the reader may see, po.view), and history from its Events —
// and the right column: the decision bar for whoever holds an open task on it, then its summary with the attachments
// and followers, and its comments. request.view is checked before anything is read: the requester and followers,
// everyone who had a task on it, and the organization-wide roles. The decision bar calls the task page's actions, whose
// services check the assignee, the state, separation of duties and the PIN again. The requester asks again from the
// header ("ขอซ้ำ", once the request was sent) and renews a service line of an ordered or done request from the overview,
// where the renewal reminder lands (S6-12 · FR-INT-101); the service checks the requester again.
export default async function RequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [tv, tl, td, locale] = await Promise.all([getTranslations('requestView'), getTranslations('timeline'), getTranslations('document'), getLocale().then(localeOf)])

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

  const [view, follow, myTaskId, allPos] = await Promise.all([getRequestView(ctx, id), getRequestFollowers(ctx, id), getMyOpenTaskId(ctx, 'REQUEST', id), listRequestPurchaseOrders(ctx, id)])
  if (!view) notFound()
  const route = view.route
  const closed = CLOSED_STATUSES.includes(view.status)
  const lastDone = view.track.filter((e) => e.state === 'done').at(-1)?.at ?? null
  const [details, daysTaken, poAccess, task] = await Promise.all([
    route ? getRouteStepDetails(ctx, route.id) : Promise.resolve([]),
    businessDaysTaken(ctx, view.submittedAt, closed ? lastDone : null),
    Promise.all(allPos.map((po) => getPoAccess(ctx, po.id))),
    myTaskId ? Promise.all([getTaskAccess(ctx, myTaskId), getTaskView(ctx, myTaskId)]) : Promise.resolve(null),
  ])
  // Only the POs the reader may open (po.view, §2.4): a PO they may not see is not mentioned at all (AC2)
  const pos = allPos.filter((_, i) => poAccess[i] && canViewPo(principal, poAccess[i]!))
  // The decision bar: an open task on this request that the reader may decide (approval.decide, BR-DLG-04)
  const decide = task && task[0] && task[1] && taskRight(principal, task[0]) === 'DECIDE' && task[1].status === 'OPEN' ? task[1] : null

  const named = (m: { id: string; name: { th: string; en: string | null } }) => ({ id: m.id, name: memberName(locale, m) })
  const mine = view.requester.id === state.member.id
  // Asking again (S6-12 · FR-INT-101): the requester's own request once sent, and its service lines once ordered or done
  const serviceLines = canRenew(mine, view.status) ? await getServiceLines(ctx, view.id) : []
  const stage = view.stage
  const rejection = view.status === 'REJECTED' ? (view.track.filter((e) => e.what === 'REJECTED').at(-1)?.note ?? null) : null
  // DOA references link to the version only for those who may open it (ORG_ADMIN); everyone else reads them as text
  const doaLinks = canOpenDoaVersion(principal)
  const items = timelineItems(tv, tl, locale, view.track, { stepCount: route?.steps.length ?? 1, doaLinks })
  const question = mine && view.openInfoRequest
    ? { infoRequestId: view.openInfoRequest.id, text: view.openInfoRequest.question, askedLine: tv('actions.answerAsked', { name: memberName(locale, view.openInfoRequest.askedBy), time: when(locale, view.openInfoRequest.askedAt) }) }
    : null
  const budget = requestBudgetState(view)
  const statusBadge = <StatusBadge look={REQUEST_BADGES[view.status]} label={td(`badge.request.${view.status}`)} />
  const waited = waitingText(tv, stageWaitingMinutes(stage))
  // While the route runs, what comes after it: procurement issues the PO (the timeline's own last step)
  const nextAfterRoute = route?.status === 'ACTIVE' && view.track.some((e) => e.what === 'NEXT_PROCUREMENT') ? tv('timeline.what.NEXT_PROCUREMENT') : null
  const comments = commentViews(td, locale, view.track, tv('system'))
  const kb = (bytes: number) => new Intl.NumberFormat(locale === 'en' ? 'en' : 'th').format(Math.max(1, Math.ceil(bytes / BYTES_PER_KIB)))
  const files = view.attachments.map((f) => ({ fileId: f.fileId, fileName: f.fileName, detail: `${tv(`files.kind.${fileKind(f.kind)}`)} · ${tv('files.size', { size: kb(f.sizeBytes) })}` }))
  const poCards: PoCardView[] = pos.map((po) => ({
    id: po.id,
    title: po.number ? `${po.number} · ${nameIn(locale, po.supplier)}` : nameIn(locale, po.supplier),
    href: `/procurement/pos/${po.id}`,
    amount: td('pos.gross', { amount: money(po.grossSatang) }),
    badge: { look: PO_BADGES[po.status], label: td(`badge.po.${po.status}` as 'badge.po.SENT') },
  }))
  const supplier = view.suggestedSupplier ? nameIn(locale, view.suggestedSupplier.name) : pos.length ? [...new Set(pos.map((p) => nameIn(locale, p.supplier)))].join(', ') : td('header.supplierNone')

  const overview = (
    <div className="flex flex-col gap-6">
      <div data-doc-now="" className="flex flex-col gap-1.5 border-l-4 border-line pl-3">
        <p className="text-ink">
          <span className="text-ink-muted">{tv('detail.nowTitle')}: </span>
          {stageText(tv, locale, stage, mine)}
        </p>
        {/* How long it has waited, whoever it waits for: an approver, the requester, procurement or a supplier (§9.9 principle 4) */}
        {waited ? <StateLine kind="waiting">{waited}</StateLine> : null}
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

      {serviceLines.length ? (
        <Section id="renewal" title={tv('actions.renewTitle')}>
          <RenewLines lines={serviceLines.map((l) => ({ id: l.id, description: l.description, ends: tv('lines.serviceEnd', { date: day(locale, l.serviceEndDate) }) }))} renew={renewLineAction} />
        </Section>
      ) : null}

      <Section id="route" title={tv('route.title')}>
        {route ? (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-ink-muted">{tv('route.rule')}</span>
              <DoaRef label={doaRefText(tl, route.doa)} href={doaLinks ? doaHref(route.doa.versionId) : null} />
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="font-semibold text-ink">{tv('route.why')}</h3>
              <p className="break-words text-ink">{routeWhy(tv, tl, locale, route, 'REQUEST')}</p>
            </div>
            {route.routeNo > 1 ? <p className="text-ink-muted">{tv('route.round', { no: route.routeNo })}</p> : null}
            <StepCards
              steps={stepCards(td, tv, tl, locale, route, details, { doaLinks })}
              explanation={routeWhy(tv, tl, locale, route, 'REQUEST')}
              labels={{ list: td('steps.list'), open: td('steps.open'), panelHistory: td('steps.panelHistory'), panelWhy: td('steps.panelWhy'), panelNoHistory: td('steps.panelNoHistory') }}
              {...(nextAfterRoute ? { next: nextAfterRoute } : {})}
            />
          </div>
        ) : (
          <p className="text-ink-muted">{view.documentType === 'SUPPLIER_REQUEST' ? tv('route.none') : tv('route.notYet')}</p>
        )}
      </Section>

      {view.documentType === 'PURCHASE_REQUEST' ? (
        <Section id="budget-card" title={td('overview.budgetTitle')}>
          {view.budget ? (
            <div className="flex flex-col gap-1">
              <p className="text-ink">{`${view.budget.code} · ${view.budget.name}`}</p>
              <StateLine kind={budget.kind}>{tv(`budget.${budget.key}`)}</StateLine>
              {view.budget.reservedSatang > 0n ? <p className="tabular text-ink">{`${tv('budget.reserved')} ${money(view.budget.reservedSatang)} ${tv('amounts.currency')}`}</p> : null}
              {view.budget.committedSatang > 0n ? <p className="tabular text-ink">{`${tv('budget.committed')} ${money(view.budget.committedSatang)} ${tv('amounts.currency')}`}</p> : null}
            </div>
          ) : (
            <p className="text-ink-muted">{tv('budget.none')}</p>
          )}
        </Section>
      ) : null}

      {poCards.length ? (
        <Section id="po-card" title={td('overview.poTitle')}>
          <PoCards pos={poCards} label={td('pos.list')} />
        </Section>
      ) : null}
    </div>
  )

  const tabs: DocTab[] = [
    { value: 'overview', label: td('tabs.overview'), content: overview },
    {
      value: 'lines',
      label: td('tabs.linesBudget'),
      content: (
        <div className="flex flex-col gap-6">
          <RequestFacts view={view} locale={locale} />
          {/* Where the goods go and the supplier the requester suggested (S4-02), with the facts above */}
          {view.documentType === 'PURCHASE_REQUEST' ? <PlaceFacts items={placeFacts(tv, locale, view)} /> : null}
          <RequestSections view={view} locale={locale} openFile={downloadUrlAction} doaLinks={doaLinks} parts={['money', 'lines', 'details']} />
        </div>
      ),
    },
    { value: 'documents', label: td('tabs.documents'), content: <RequestSections view={view} locale={locale} openFile={downloadUrlAction} doaLinks={doaLinks} parts={['files', 'questions']} /> },
    ...(pos.length
      ? [
          {
            value: 'orders',
            label: td('tabs.poReceiving'),
            content: (
              <PoCards
                label={td('pos.list')}
                pos={pos.map((po, i) => ({
                  ...poCards[i]!,
                  lines: po.receipts.length
                    ? po.receipts.map((r) => `${td('pos.receipt', { number: r.number ?? '-', time: when(locale, r.receivedAt) })} · ${td(`pos.receiptStatus.${r.status === 'REVERSED' ? 'REVERSED' : 'POSTED'}`)}`)
                    : [td('pos.noReceipts')],
                }))}
              />
            ),
          },
        ]
      : []),
    {
      value: 'history',
      label: td('tabs.history'),
      content: (
        <HistoryTable
          rows={historyRows(td, items, requestHistoryKinds(view.track))}
          labels={{
            table: td('history.table'),
            filter: td('history.filter'),
            all: td('history.all'),
            kinds: { DECISION: td('history.kinds.DECISION'), DOCUMENT: td('history.kinds.DOCUMENT'), QUESTION: td('history.kinds.QUESTION'), GOODS: td('history.kinds.GOODS') },
            columns: { when: td('history.columns.when'), actor: td('history.columns.actor'), event: td('history.columns.event'), channel: td('history.columns.channel') },
            empty: td('history.empty'),
          }}
        />
      ),
    },
  ]

  const totals = view.totals
  const summary = (
    <div className="flex flex-col gap-6">
      <SummaryList
        label={td('summary.list')}
        items={[
          ...(totals
            ? [
                { label: td('summary.net'), value: <span className="tabular">{td('summary.money', { amount: money(totals.netSatang) })}</span> },
                { label: td('summary.vat'), value: <span className="tabular">{td('summary.money', { amount: money(totals.vatSatang) })}</span> },
                { label: td('summary.gross'), value: <span className="tabular font-semibold">{td('summary.money', { amount: money(totals.grossSatang) })}</span> },
              ]
            : []),
          { label: td('summary.type'), value: nameIn(locale, view.requestType.name) },
          { label: td('summary.charged'), value: view.chargedDepartment ? nameIn(locale, view.chargedDepartment.name) : td('summary.none') },
          ...(view.documentType === 'PURCHASE_REQUEST' ? [{ label: td('summary.budgetLine'), value: view.budget ? `${view.budget.code} · ${view.budget.name}` : td('summary.none') }] : []),
          { label: td('summary.requester'), value: memberName(locale, view.requester) },
          { label: td('summary.neededBy'), value: view.neededBy ? day(locale, view.neededBy) : td('summary.none') },
          ...(view.documentType === 'PURCHASE_REQUEST' ? [{ label: td('summary.site'), value: view.deliverySite ? `${view.deliverySite.code} · ${view.deliverySite.name}` : td('summary.none') }] : []),
          { label: td('summary.doa'), value: route ? doaRefText(tl, route.doa) : td('summary.none') },
          {
            label: td('summary.files'),
            value: files.length ? <AttachmentList open={downloadUrlAction} files={files} /> : <span className="text-ink-muted">{tv('files.none')}</span>,
          },
        ]}
      />
      {follow ? (
        <FollowersPanel requestId={view.id} followers={follow.followers.map(named)} canManage={follow.canManage} candidates={follow.candidates.map(named)} manage={manageFollowerAction} />
      ) : null}
    </div>
  )

  return (
    <div className={decide ? 'flex flex-col gap-6 pb-[calc(var(--task-bar-space,14rem)_+_1rem)] xl:pb-0' : 'flex flex-col gap-6'}>
      <DocHeader
        back={{ href: '/requests', label: tv('detail.back') }}
        number={view.number ?? tv('detail.draftLabel')}
        title={view.title}
        badges={
          <>
            {statusBadge}
            <StatusBadge look={URGENCY_BADGES[view.urgency]} label={td(`badge.urgency.${view.urgency}`)} />
          </>
        }
        actions={
          <>
            {canReorder(mine, view.status) ? <ReorderButton requestId={view.id} reorder={reorderAction} /> : null}
            {follow?.canFollow ? <FollowButton requestId={view.id} following={follow.following} unfollowEndsAccess={follow.unfollowEndsAccess} follow={followAction} /> : null}
            <DocMenu
              pdfHref={view.number ? `/requests/${view.id}/pdf` : null}
              cancel={mine && view.actions.canCancel && !closed}
              labels={{ menu: td('header.menu'), pdf: td('header.pdf'), copy: td('header.copy'), copied: td('header.copied'), cancel: td('header.cancelRequest') }}
            />
          </>
        }
        summary={[
          { label: td('header.total'), value: totals ? td('header.totalValue', { amount: money(totals.grossSatang) }) : td('header.totalNotYet') },
          ...(view.documentType === 'PURCHASE_REQUEST' ? [{ label: td('header.supplier'), value: supplier }] : []),
          { label: td('header.submitted'), value: view.submittedAt ? when(locale, view.submittedAt) : td('header.notSent') },
          { label: td('header.taken'), value: daysTaken !== null ? td('header.takenDays', { days: new Intl.NumberFormat(locale === 'en' ? 'en' : 'th').format(daysTaken) }) : td('header.takenUnknown') },
        ]}
        compactBadge={statusBadge}
      />

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

      <DocBody
        main={
          <>
            <DocTabs tabs={tabs} initial={tabFrom(query.tab, tabs.map((tab) => tab.value))} label={td('tabs.label')} param="tab" />
            {mine ? (
              <div id={CANCEL_ANCHOR}>
                <CancelRequest requestId={view.id} canCancel={view.actions.canCancel} cancel={cancelRequestAction} />
              </div>
            ) : null}
          </>
        }
        rail={
          <>
            {decide ? (
              <DecisionBar
                taskId={decide.id}
                kind="REQUEST"
                label={view.number ?? view.title}
                amount={totals ? money(totals.grossSatang) : '-'}
                locale={locale}
                stepUp={decide.stepUp}
                facts={{
                  amount: route?.basisSatang != null ? td('bar.amountValue', { amount: money(route.basisSatang), basis: tv(`route.explain.basis.${route.amountBasis}`) }) : '-',
                  budget: <StateLine kind={budget.kind}>{tv(`budget.${budget.key}`)}</StateLine>,
                  ...(route ? { doaRef: doaRefText(tl, route.doa) } : {}),
                }}
                actions={{ decide: decideTaskAction, ask: askForInformationAction }}
              />
            ) : null}
            <DocTabs
              label={td('rail.label')}
              initial="summary"
              tabs={[
                { value: 'summary', label: td('rail.summary'), content: summary },
                { value: 'comments', label: td('rail.comments', { count: comments.length }), content: <CommentList comments={comments} label={td('comments.list')} empty={td('comments.empty')} /> },
              ]}
            />
          </>
        }
      />
      {/* The outcome of a decision or a copied link (§9.10 ข้อความแจ้งผล); above the decision bar on phones */}
      <Toaster position="top-center" />
    </div>
  )
}
