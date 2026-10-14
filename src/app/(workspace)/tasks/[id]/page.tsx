import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { getPoAccess, getPurchaseOrderView, getVarianceView } from '@/server/queries/purchase-orders'
import { getRequestView, type TrackEntryDto } from '@/server/queries/requests'
import { getTaskAccess, getTaskView, listMyTasks, PIN_DECISION_SUBJECTS, type TaskViewDto } from '@/server/queries/tasks'
import { getPriceReference } from '@/server/services/price-reference'
import { listRequestFlags } from '@/server/services/requests/duplicates'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { StateLine } from '@/ui/request-view/status'
import { AiBrief } from '@/ui/tasks/ai-brief'
import { DecisionPanel } from '@/ui/tasks/decision-panel'
import { BacktestPanel } from '@/ui/backtest/panel'
import { Section } from '@/ui/request-view/facts'
import { PolicyDecision } from '@/ui/tasks/policy-decision'
import { PriceReferencePanel } from '@/ui/price-reference/panel'
import { RequestFlagsPanel } from '@/ui/request-flags/panel'
import { Timeline } from '@/ui/timeline/timeline'
import { readBacktestRunAction, runBacktestAction } from '../../../_lib/backtest-actions'
import { briefView } from '../../../_lib/brief-present'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { canOpenDoaVersion, canOpenOrgAuthorityChanges, taskRight } from '../../_tracking/access'
import { PolicySubject, boundaryTickOf, policyHeadline } from '../../_tracking/policy-subject'
import { WorkflowSubject } from '../../_tracking/workflow-subject'
import { priceReferenceView } from '../../_tracking/price-reference'
import { requestFlagsView } from '../../_tracking/request-flags'
import { dueText, localeOf, memberName, money, nameIn, roleText, timelineItems, waitingText, when, type Locale, type ViewT } from '../../_tracking/present'
import { RequestFacts, RequestSections } from '../../_tracking/request-sections'
import { taskTitle } from '../../_tracking/rows'
import { canViewPo, poReader } from '../../procurement/pos/_parts/access'
import { PoBody } from '../../procurement/pos/_parts/po-body'
import { docTimelineItems } from '../../procurement/pos/_parts/present'
import { ClosedTaskText } from '../_parts/closed-task'
import { VarianceBody } from '../_parts/variance-body'
import { askForInformationAction, decidePolicyTaskAction, decideTaskAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('detail.metaTitle') }
}

type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

/** Where the task stands, in words: waiting since when and until when, decided by whom and when, moved or closed */
function TaskState({ task, t, tv, locale, mine }: { task: TaskViewDto; t: TasksT; tv: ViewT; locale: Locale; mine: string }) {
  const role = roleText(tv, locale, task.role)
  switch (task.status) {
    case 'OPEN': {
      const waited = waitingText(tv, task.waitingMinutes)
      const due = dueText(tv, locale, task.dueAt, task.overdue)
      return (
        <div className="flex flex-col gap-1">
          {waited ? <StateLine kind="waiting">{waited}</StateLine> : null}
          {due ? <StateLine kind={task.overdue ? 'overdue' : 'due'}>{due}</StateLine> : null}
          {role ? <StateLine kind="person">{t('detail.as', { role })}</StateLine> : null}
          {task.principal && task.assignee?.id === mine ? <StateLine kind="person">{t('detail.holdingFor', { name: memberName(locale, task.principal) })}</StateLine> : null}
          {task.principal?.id === mine && task.assignee ? <StateLine kind="person">{t('detail.heldBy', { name: memberName(locale, task.assignee) })}</StateLine> : null}
        </div>
      )
    }
    case 'INFO_REQUESTED':
      return (
        <Notice tone="info">
          <p className="break-words whitespace-pre-line">{t('state.question', { question: task.openQuestion?.question ?? '' })}</p>
          {task.openQuestion ? <p className="text-base text-ink-muted md:text-sm">{t('state.questionHint', { time: when(locale, task.openQuestion.askedAt) })}</p> : null}
        </Notice>
      )
    case 'APPROVED':
    case 'RETURNED':
    case 'REJECTED': {
      const text = t(`state.${task.decision ?? 'APPROVE'}`, { name: memberName(locale, task.decidedBy), time: task.decidedAt ? when(locale, task.decidedAt) : '' })
      // In the colours the timeline beside it draws the same decision in: approved --primary, returned --warn, not
      // approved --danger (§9.9 tokens). How the task stands, read politely as a status, not an error just made (role=alert)
      return (
        <Notice tone={task.status === 'APPROVED' ? 'success' : task.status === 'REJECTED' ? 'danger' : 'warning'} role="status">
          <p>{text}</p>
          {task.reason && task.status !== 'APPROVED' ? <p className="break-words whitespace-pre-line">{t('state.reason', { reason: task.reason })}</p> : null}
        </Notice>
      )
    }
    // Moved or cancelled: why, and — when another task of its step decided it — who decided and when (FR-DOA-004 AC2)
    case 'REASSIGNED':
    default:
      return (
        <Notice tone="info">
          <ClosedTaskText task={task} t={t} locale={locale} />
        </Notice>
      )
  }
}

// The decision page (spec §9.1 /tasks/[id], §9.9 principle 5, FR-DOA-004, FR-DOA-005 AC2, BR-DOA-15): everything needed
// to decide on one screen — the amount before VAT and the VAT, the budget line and its state, the DOA version and rule
// with why the route comes to this member, the lines, the details, the attachments and the timeline as stamps. Only
// the task's deciders open it while it waits (approval.decide), and those who held or decided it afterwards. A
// purchase order shows its supplier, lines with their source requests, totals and the prices paid before (FR-P2P-003,
// FR-P2P-004); a receiving variance shows its PO line, what was ordered and received, and its amount (FR-P2P-007 AC2).
// Policy tasks, and tasks whose amount is at or above the DOA version's stepUpThreshold, are decided with the PIN
// (FR-AUTH-005 AC2): the decision forms ask for it whenever task.stepUp says so.
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, tl, locale] = await Promise.all([getTranslations('tasks'), getTranslations('requestView'), getTranslations('timeline'), getLocale().then(localeOf)])

  const access = await getTaskAccess(ctx, id)
  if (!access) notFound()
  const principal = memberPrincipal(state.member.id, state.roles)
  const right = taskRight(principal, access)
  if (right === 'NONE') {
    return (
      <Page>
        <PageHeader title={t('detail.notYours')} />
        <div className="flex max-w-2xl flex-col gap-3">
          <Notice tone="warning">{t('detail.notYoursHint')}</Notice>
          <Link href="/tasks" className={linkClass}>
            {t('detail.toInbox')}
          </Link>
        </div>
      </Page>
    )
  }

  const task = await getTaskView(ctx, id)
  if (!task) notFound()
  const request = task.subjectType === 'REQUEST' ? await getRequestView(ctx, task.subjectId) : null
  // The prices paid before for the request's items, for whoever may read them (priceReference.view: who has or had a task
  // on it, and who reads every PO — S6-11 · FR-DOA-101 · BR-PRC-07); anyone else simply gets no panel
  const priceRef = request ? await getPriceReference(ctx, { requestId: request.id }) : null
  const priceRefView = priceRef?.ok ? priceReferenceView(await getTranslations('priceReference'), priceRef.data) : null
  // A request like one its requester sent before, or that may split a purchase to stay under a limit (S6-13 · FR-INT-103
  // AC2 AC3): whoever may view the request reads its flags; none, or no right to them, and the page shows nothing
  const flags = request ? await listRequestFlags(ctx, request.id) : null
  const flagsView = flags?.ok ? requestFlagsView(await getTranslations('requestFlags'), flags.data, (id) => `/requests/${id}`) : null
  const po = task.subjectType === 'PURCHASE_ORDER' ? await getPurchaseOrderView(ctx, task.subjectId) : null
  const variance = task.subjectType === 'VARIANCE' ? await getVarianceView(ctx, task.subjectId) : null
  const [tp, poAccess] = await Promise.all([getTranslations('purchaseOrder'), po ? getPoAccess(ctx, po.id) : variance ? getPoAccess(ctx, variance.po.id) : Promise.resolve(null)])
  // The PO opens for whoever may see it (po.view); otherwise its number is plain text, never a link that ends in a refusal
  const poHref = poAccess && canViewPo(principal, poAccess) ? `/procurement/pos/${poAccess.poId}` : null
  // The approver decides on the prices too: the prices paid before for the same items (FR-P2P-003 AC1)
  const reader = po ? poReader(principal, poAccess, po, { prices: true }) : null
  const open = right === 'DECIDE' && task.status === 'OPEN'
  // The Approval Brief for the one who decides it now (FR-AI-301): none when there is no Brief for this task
  const brief = open ? await briefView(ctx, task.id) : null
  // A DOA version or an authority change (BR-DOA-15), or a workflow version to publish (BR-WF-12): approved or rejected
  // with the PIN, on a page of its own
  const policyTask = PIN_DECISION_SUBJECTS.includes(task.subjectType)
  // A DOA version with a boundary table: the approver ticks it before approving (FR-DOA-009 AC3)
  const boundary = open ? boundaryTickOf(task) : null
  const inbox = open ? null : await listMyTasks(ctx, { limit: 2 })
  const next = inbox?.items.find((i) => i.id !== task.id) ?? null

  // The timeline: the request's own (FR-INT-008), or the policy document's with the step that waits now
  const policyNow: TrackEntryDto[] =
    policyTask && (task.status === 'OPEN' || task.status === 'INFO_REQUESTED')
      ? [
          {
            key: `task-${task.id}`,
            state: 'current',
            what: 'WAIT_APPROVAL',
            at: task.assignedAt,
            channel: null,
            actor: task.assignee,
            onBehalfOf: task.principal,
            role: task.role,
            expected: null,
            doa: null,
            note: null,
            other: null,
            number: null,
            stepNo: null,
            waitingMinutes: task.waitingMinutes,
            dueAt: task.dueAt,
            overdue: task.overdue,
          },
        ]
      : []
  const track = request ? request.track : [...task.track, ...policyNow]
  // DOA references link to the version only for those who may open it (ORG_ADMIN); everyone else reads them as text
  const doaLinks = canOpenDoaVersion(principal)
  // The try-out of a DOA version, offered beside a change of amount basis, only to who may open it (admin.doa.simulate)
  const doaSimulate = isAllowed(principal, 'admin.doa.simulate')
  const items = po
    ? docTimelineItems(tp, tv, tl, locale, po.track, { doaLinks })
    : variance
      ? docTimelineItems(tp, tv, tl, locale, variance.track, { doaLinks })
      : timelineItems(tv, tl, locale, track, { stepCount: request?.route?.steps.length ?? 1, doaLinks })
  const timelineLabel = po ? tp('track.label') : variance ? t('variance.timelineLabel') : tv('timeline.label')

  const varianceTitle = variance ? t('detail.varianceHeading', { type: t(`varianceType.${variance.type}`), description: variance.line.description }) : null
  const label = request
    ? (request.number ?? request.title)
    : po
      ? (po.number ?? tp('detail.draftLabel'))
      : variance
        ? `${variance.po.number ?? '-'} · ${variance.line.description}`
        : task.policy
          ? policyHeadline(t, locale, task.policy)
          : task.workflow
            ? t(task.workflow.withdrawal ? 'item.workflowWithdrawal' : 'item.workflow', { code: task.workflow.code, version: task.workflow.versionNo })
            : t('item.untitled')
  const heading = request ? request.title : po ? po.supplier.nameTh : (varianceTitle ?? label)
  // On phones the decision bar is fixed to the bottom: the page ends above it, with room as tall as the bar is now — its
  // height comes from the bar itself (useBarSpace of src/ui/tasks/bar-space.ts) as it grows with the PIN, a refusal or
  // the boundary table's tick; until then a guess of it for the first paint, taller with the PIN and with the tick
  const barSpace = policyTask
    ? boundary
      ? 'pb-[calc(var(--task-bar-space,23rem)_+_1rem)]'
      : 'pb-[calc(var(--task-bar-space,15rem)_+_1rem)]'
    : task.stepUp
      ? 'pb-[calc(var(--task-bar-space,19rem)_+_1rem)]'
      : 'pb-[calc(var(--task-bar-space,13rem)_+_1rem)]'
  // The approver of a DOA or workflow version runs its 90-day backtest before deciding (BR-DOA-14 · FR-DOA-103 AC3)
  const backtest =
    (task.status === 'OPEN' || task.status === 'INFO_REQUESTED') && (task.policy?.kind === 'DOA_VERSION' || task.workflow)
      ? task.policy?.kind === 'DOA_VERSION'
        ? { kind: 'DOA_VERSION' as const, versionId: task.policy.versionId, name: t('policy.doaVersionRef', { code: task.policy.code, version: task.policy.versionNo }), withdrawal: task.policy.withdrawal !== null }
        : { kind: 'WORKFLOW_VERSION' as const, versionId: task.workflow!.versionId, name: t('workflow.versionValue', { code: task.workflow!.code, version: task.workflow!.versionNo }), withdrawal: task.workflow!.withdrawal !== null }
      : null
  const pageClass = open ? `flex flex-col gap-6 ${barSpace} lg:pb-0` : 'flex flex-col gap-6'

  return (
    <div className={pageClass}>
      <Link href="/tasks" className={linkClass}>
        {t('detail.back')}
      </Link>

      <PageHeader
        title={heading}
        intro={
          request ? (
            <>
              {memberName(locale, request.requester)}
              {request.chargedDepartment ? ` · ${nameIn(locale, request.chargedDepartment.name)}` : ''}
              {` · ${nameIn(locale, request.requestType.name)}`}
            </>
          ) : po ? (
            <>
              {t('detail.poMeta', { site: po.deliverySite?.nameTh ?? tp('detail.noSite'), kind: tp(`kind.${po.kind}`) })}
              {po.submittedBy ? ` · ${t('item.poMeta', { name: memberName(locale, po.submittedBy) })}` : ''}
            </>
          ) : variance ? (
            variance.po.supplier.nameTh
          ) : undefined
        }
      >
        {request?.number ? <p className="font-medium text-ink-muted">{t('detail.requestLabel', { number: request.number })}</p> : null}
        {po?.number ? <p className="font-medium text-ink-muted">{t('detail.poLabel', { number: po.number })}</p> : null}
        {variance ? <p className="font-medium text-ink-muted">{t('detail.varianceLabel', { number: variance.po.number ?? '-' })}</p> : null}
        <TaskState task={task} t={t} tv={tv} locale={locale} mine={state.member.id} />
        {!open ? (
          <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-6">
            {next ? (
              <Link href={`/tasks/${next.id}`} className={linkClass}>
                {t('detail.next', { label: taskTitle(t, next) })}
              </Link>
            ) : null}
            <Link href="/tasks" className={linkClass}>
              {t('detail.toInbox')}
            </Link>
          </div>
        ) : null}
      </PageHeader>

      <PageBody>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel label={heading}>
            <div className="flex min-w-0 flex-col gap-6">
              {request ? (
                <>
                  <RequestFacts view={request} locale={locale} brief />
                  {flagsView ? <RequestFlagsPanel view={flagsView} /> : null}
                  <RequestSections view={request} locale={locale} openFile={downloadUrlAction} doaLinks={doaLinks} />
                  {priceRefView ? (
                    <Section id="price-reference" title={priceRefView.title}>
                      <PriceReferencePanel view={priceRefView} />
                    </Section>
                  ) : null}
                  <Link href={`/requests/${request.id}`} className={linkClass}>
                    {t('detail.openRequest', { label: request.number ?? request.title })}
                  </Link>
                </>
              ) : po && reader ? (
                <>
                  {/* The route of this task, also after a return took the PO back to a draft without one */}
                  <PoBody po={{ ...po, route: task.route ?? po.route }} locale={locale} doaLinks={doaLinks} reader={reader} openFile={downloadUrlAction} />
                  {poHref ? (
                    <Link href={poHref} className={linkClass}>
                      {t('detail.openPo', { label })}
                    </Link>
                  ) : null}
                </>
              ) : variance ? (
                <VarianceBody variance={variance} locale={locale} doaLinks={doaLinks} poHref={poHref} openFile={downloadUrlAction} />
              ) : task.workflow ? (
                <WorkflowSubject workflow={task.workflow} locale={locale} />
              ) : (
                <PolicySubject task={task} locale={locale} doaLinks={doaLinks} doaSimulate={doaSimulate} orgAuthorityLink={canOpenOrgAuthorityChanges(principal)} />
              )}
              {backtest ? (
                <Section id="backtest" title={t('withdrawal.backtestTitle')}>
                  <BacktestPanel
                    kind={backtest.kind}
                    versionId={backtest.versionId}
                    versionName={backtest.name}
                    purpose={backtest.withdrawal ? 'withdrawal' : 'draft'}
                    run={runBacktestAction}
                    reread={readBacktestRunAction}
                  />
                </Section>
              ) : null}
            </div>
          </Panel>

          <aside className="flex min-w-0 flex-col gap-4 lg:gap-6">
            {brief ? <AiBrief brief={brief} /> : null}
            {/* The decision in its own card; on phones its buttons stay fixed to the bottom of the screen */}
            <Panel>
              {policyTask ? (
                <PolicyDecision taskId={task.id} open={open} locale={locale} boundary={boundary} decide={decidePolicyTaskAction} />
              ) : (
                <DecisionPanel
                  taskId={task.id}
                  open={open}
                  locale={locale}
                  label={label}
                  amount={request?.totals ? money(request.totals.grossSatang) : po ? money(po.totals.grossSatang) : variance ? money(variance.amountSatang) : '-'}
                  kind={po ? 'PURCHASE_ORDER' : variance ? 'VARIANCE' : task.review ? 'REVIEW' : 'REQUEST'}
                  stepUp={task.stepUp}
                  {...(variance ? { disposition: variance.disposition } : {})}
                  actions={po || variance ? { decide: decideTaskAction } : { decide: decideTaskAction, ask: askForInformationAction }}
                />
              )}
            </Panel>
            <Panel title={tv('timeline.title')} id="timeline">
              <Timeline items={items} label={timelineLabel} />
            </Panel>
          </aside>
        </div>
      </PageBody>
    </div>
  )
}
