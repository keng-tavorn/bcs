import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { amountToSatang } from '@/core/money/dto'
import { memberPrincipal } from '@/server/authz'
import { getPurchaseOrderView, getVarianceView } from '@/server/queries/purchase-orders'
import { getRequestView, type TrackEntryDto } from '@/server/queries/requests'
import { getTaskAccess, getTaskView, listMyTasks, POLICY_SUBJECTS, type TaskViewDto } from '@/server/queries/tasks'
import { budgetLineAvailable } from '@/server/services/budget/line-available'
import { liffFacts } from '@/server/services/liff'
import { LIFF_HELP_PATH, LIFF_HOME_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { BackToChat } from '@/ui/liff/tasks/back-to-chat'
import { LiffPolicyDecisionLoader, LiffTaskDecisionLoader } from '@/ui/liff/tasks/lazy'
import { liffTaskAction, WEB_PIN_SETTINGS_PATH } from '@/ui/liff/tasks/shared'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Amounts, Facts, type AmountRow, type Fact } from '@/ui/request-view/facts'
import { StateLine } from '@/ui/request-view/status'
import { Timeline } from '@/ui/timeline/timeline'
import { taskRight } from '../../../(workspace)/_tracking/access'
import { requestBudgetState } from '../../../(workspace)/_tracking/budget-state'
import { PolicySubject, boundaryTickOf, policyHeadline } from '../../../(workspace)/_tracking/policy-subject'
import { doaRefText, dueText, localeOf, memberName, money, nameIn, roleText, timelineItems, waitingText, when, type Locale, type ViewT } from '../../../(workspace)/_tracking/present'
import { RequestFacts, RequestSections } from '../../../(workspace)/_tracking/request-sections'
import { taskTitle } from '../../../(workspace)/_tracking/rows'
import { poReader } from '../../../(workspace)/procurement/pos/_parts/access'
import { PoBody } from '../../../(workspace)/procurement/pos/_parts/po-body'
import { docTimelineItems } from '../../../(workspace)/procurement/pos/_parts/present'
import { ClosedTaskText } from '../../../(workspace)/tasks/_parts/closed-task'
import { VarianceBody } from '../../../(workspace)/tasks/_parts/variance-body'
import { getInvoiceTaskView } from '@/server/queries/ap-invoices'
import { LiffInvoiceSummary } from '@/ui/liff/tasks/subjects/invoice'
import { liffTaskHref } from '../../_lib/links'
import { liffPage } from '../../_lib/session'
import { liffSignedIn } from '../_lib/signed-in'
import { askLiffRequesterAction, decideLiffPolicyAction, decideLiffTaskAction, openLiffFileAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('detail.metaTitle') }
}

type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>
type LiffTasksT = Awaited<ReturnType<typeof getTranslations<'liffTasks'>>>

/** A PO's source requests are not links on a LIFF page (their files are listed): the workspace's request page is not for a LINE sign-in */
const NO_LINK = () => null

/** Where the task stands, in words — the lines of the web decision page: waiting since and until when, decided by whom */
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
        <LiffNotice tone="info">
          <p className="break-words whitespace-pre-line">{t('state.question', { question: task.openQuestion?.question ?? '' })}</p>
          {task.openQuestion ? <p className="text-ink-muted">{t('state.questionHint', { time: when(locale, task.openQuestion.askedAt) })}</p> : null}
        </LiffNotice>
      )
    case 'APPROVED':
    case 'RETURNED':
    case 'REJECTED': {
      const text = t(`state.${task.decision ?? 'APPROVE'}`, { name: memberName(locale, task.decidedBy), time: task.decidedAt ? when(locale, task.decidedAt) : '' })
      // In the colours the timeline below draws the same decision in: approved --primary, returned --warn, not approved
      // --danger (§9.9 tokens). How the task stands, read politely as a status, not an error just made (role=alert)
      return (
        <LiffNotice tone={task.status === 'APPROVED' ? 'success' : task.status === 'REJECTED' ? 'danger' : 'warning'} role="status">
          <p>{text}</p>
          {task.reason && task.status !== 'APPROVED' ? <p className="break-words whitespace-pre-line">{t('state.reason', { reason: task.reason })}</p> : null}
        </LiffNotice>
      )
    }
    // Moved or cancelled: the words of the web decision page — why, and who decided its step and when
    case 'REASSIGNED':
    default:
      return (
        <LiffNotice tone="info">
          <ClosedTaskText task={task} t={t} locale={locale} />
        </LiffNotice>
      )
  }
}

/**
 * The facts to decide on, first on the phone's screen (§9.9 principle 5): the amount and what is left on the budget line —
 * label and figure on one row, the figures right-aligned in tabular digits under their unit, as in the amounts below
 * (§9.9 principle 6) — then the budget line, the supplier or the order, and the DOA rule
 */
function Summary({ label, amounts, facts, unit }: { label: string; amounts: readonly AmountRow[]; facts: readonly Fact[]; unit: { readonly heading: string; readonly name: string } }) {
  return (
    <section aria-label={label} className="flex flex-col gap-4 border-t border-line pt-5">
      {amounts.length ? <Amounts rows={amounts} heading={unit.heading} unit={unit.name} /> : null}
      {/* One column at every width, as LIFF is (§9.9) */}
      {facts.length ? <Facts items={facts} columns="one" /> : null}
    </section>
  )
}

/** After the task was decided or moved: the next task, the inbox, and in LINE the chat */
function AfterTask({ next, t, tLiff }: { next: { id: string; label: string } | null; t: TasksT; tLiff: LiffTasksT }) {
  return (
    <div className="flex flex-col gap-1">
      {next ? <LiffLink href={liffTaskHref(next.id)}>{t('detail.next', { label: next.label })}</LiffLink> : null}
      <LiffLink href={LIFF_HOME_PATH}>{t('detail.toInbox')}</LiffLink>
      <BackToChat label={tLiff('detail.backToChat')} />
    </div>
  )
}

// /liff/tasks/[id] (§9.4 "รายละเอียดและตัดสิน (พร้อม PIN เมื่อจำเป็น)", §9.3, §9.9 principle 5, FR-LINE-003 AC1 AC2,
// FR-DOA-004, BR-DOA-15, FR-DOA-009 AC3, NEW-41, BR-LINE-06): everything a decider needs, on the phone — what it is and
// who asked, how much, which budget line and what is left on it (only for a member who may see the line's figures:
// budget.view, checked by the budget service), the DOA rule with why the route comes here and the route so far, the
// files, then the timeline as stamps — and the decision: approve in the bar at the bottom of the screen, return or reject
// (with a reason) and asking the requester in sections of their own. The same queries, bodies and words as the web
// decision page: a request's sections; a purchase order's amounts, budget, lines with the prices paid before, source
// requests with their files, facts and route (PoBody); a variance's amounts, budget, facts with its goods receipt,
// photos and route (VarianceBody); a DOA version's diff, who gains or loses authority and the boundary table the
// approver ticks before approving with the PIN. Files open through this page's own action, for the LIFF session, bound
// to the task (openLiffFileAction: only the files this page lists; the file service checks the document again). Only the task's deciders open it while it waits
// (approval.decide), and those who held or decided it afterwards; every decision is checked again by the service. Links
// to the workspace's pages are left out — the DOA versions, the source requests, the PO: a LINE sign-in does not open
// them. ?action=approve or ?action=reject (a LINE card's button) opens with that choice ready and never decides by itself.
export default async function LiffTaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const initial = liffTaskAction(query.action)
  const [page, t, tv, tl, tp, tLiff, locale] = await Promise.all([
    liffPage(),
    getTranslations('tasks'),
    getTranslations('requestView'),
    getTranslations('timeline'),
    getTranslations('purchaseOrder'),
    getTranslations('liffTasks'),
    getLocale().then(localeOf),
  ])
  const back = { href: LIFF_HOME_PATH, label: t('detail.back') }
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('detail.metaTitle')} back={back}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const { ctx } = page
  const access = await getTaskAccess(ctx, id)
  if (!access) notFound()
  const principal = memberPrincipal(page.member.id, [])
  const right = taskRight(principal, access)
  if (right === 'NONE') {
    return (
      <LiffFrame title={t('detail.notYours')} back={back}>
        <LiffContent>
          <LiffNotice tone="warning">{t('detail.notYoursHint')}</LiffNotice>
          <LiffLink href={LIFF_HOME_PATH}>{t('detail.toInbox')}</LiffLink>
        </LiffContent>
      </LiffFrame>
    )
  }

  const task = await getTaskView(ctx, id)
  if (!task) notFound()
  const request = task.subjectType === 'REQUEST' ? await getRequestView(ctx, task.subjectId) : null
  const po = task.subjectType === 'PURCHASE_ORDER' ? await getPurchaseOrderView(ctx, task.subjectId) : null
  const variance = task.subjectType === 'VARIANCE' ? await getVarianceView(ctx, task.subjectId) : null
  // What the reader of a PO sees beside it, with the member's roles: the approver decides on the prices paid before too
  // (FR-P2P-003 AC1), as on the web decision page; the supplier's address and the source requests' files per §2.4
  const reader = po ? poReader(memberPrincipal(page.member.id, (await liffSignedIn(page.member.id))?.roles ?? []), null, po, { prices: true }) : null
  const open = right === 'DECIDE' && task.status === 'OPEN'
  // A DOA version or an authority change (BR-DOA-15): approved or rejected with the PIN
  const policyTask = POLICY_SUBJECTS.includes(task.subjectType)
  // A DOA version with a boundary table: the approver ticks it before approving (FR-DOA-009 AC3)
  const boundary = open ? boundaryTickOf(task) : null
  const inbox = open ? null : await listMyTasks(ctx, { limit: 2 })
  const nextTask = inbox?.items.find((i) => i.id !== task.id) ?? null
  // What is left on the request's budget line, while the decision waits: the budget service answers only a member who may
  // see the line's figures (budget.view: a head of its department, or the organization's budget roles), §2.4
  const available = open && request?.budget ? await budgetLineAvailable(ctx, request.budget.lineId) : null
  const left = available?.ok ? money(amountToSatang(available.data.available.amount)) : null

  // The timeline: the request's own (FR-INT-008), a PO's or a variance's, or the policy document's with the step that waits
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
  const items = po
    ? docTimelineItems(tp, tv, tl, locale, po.track, { doaLinks: false })
    : variance
      ? docTimelineItems(tp, tv, tl, locale, variance.track, { doaLinks: false })
      : timelineItems(tv, tl, locale, request ? request.track : [...task.track, ...policyNow], { stepCount: request?.route?.steps.length ?? 1, doaLinks: false })
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
          : t('item.untitled')
  const heading = request ? request.title : po ? po.supplier.nameTh : (varianceTitle ?? label)
  const route = task.route ?? request?.route ?? po?.route ?? variance?.route ?? null
  // A file opens through the task it belongs to: the action checks both again (FR-PLT-004 AC2)
  const openFile = openLiffFileAction.bind(null, task.id)

  // The facts first on the screen; the full sections follow. The money first, as rows of label and figure
  const summaryAmounts: AmountRow[] = [
    ...(request?.totals ? [{ label: tv('amounts.gross'), value: money(request.totals.grossSatang) }] : []),
    ...(po ? [{ label: tv('amounts.gross'), value: money(po.totals.grossSatang) }] : []),
    ...(variance ? [{ label: tLiff('detail.varianceAmount'), value: money(variance.amountSatang) }] : []),
    ...(left ? [{ label: tLiff('detail.budgetLeft'), value: left }] : []),
  ]
  const summaryFacts: Fact[] = [
    ...(po ? [{ label: tLiff('detail.supplier'), value: po.supplier.nameTh }] : []),
    ...(variance ? [{ label: tLiff('detail.purchaseOrder'), value: `${variance.po.number ?? '-'} · ${variance.po.supplier.nameTh}` }] : []),
    ...(request?.budget
      ? [
          {
            label: tv('budget.line'),
            value: (
              <span className="flex flex-col">
                <span>{`${request.budget.code} · ${request.budget.name}`}</span>
                {/* The request page's state and mark: budget held — reserved or committed — is a padlock in --info, not approved */}
                <StateLine kind={requestBudgetState(request).kind}>{tv(`budget.${requestBudgetState(request).key}`)}</StateLine>
              </span>
            ),
          },
        ]
      : []),
    ...(route ? [{ label: tLiff('detail.doaRule'), value: <DoaRef label={doaRefText(tl, route.doa)} /> }] : []),
  ]

  const details: ReactNode = (
    <>
      <header className="flex flex-col gap-2">
        {request?.number ? <p className="font-medium text-ink-muted">{t('detail.requestLabel', { number: request.number })}</p> : null}
        {po?.number ? <p className="font-medium text-ink-muted">{t('detail.poLabel', { number: po.number })}</p> : null}
        {variance ? <p className="font-medium text-ink-muted">{t('detail.varianceLabel', { number: variance.po.number ?? '-' })}</p> : null}
        {request ? (
          <p className="text-ink-muted">
            {memberName(locale, request.requester)}
            {request.chargedDepartment ? ` · ${nameIn(locale, request.chargedDepartment.name)}` : ''}
            {` · ${nameIn(locale, request.requestType.name)}`}
          </p>
        ) : null}
        {po?.submittedBy ? <p className="text-ink-muted">{t('item.poMeta', { name: memberName(locale, po.submittedBy) })}</p> : null}
        <TaskState task={task} t={t} tv={tv} locale={locale} mine={page.member.id} />
        {open ? null : <AfterTask next={nextTask ? { id: nextTask.id, label: taskTitle(t, nextTask) } : null} t={t} tLiff={tLiff} />}
      </header>

      {/* A policy change says what it is in its own first section; its DOA rule is in its route section */}
      {summaryAmounts.length + summaryFacts.length > 0 && !policyTask ? (
        <Summary label={tLiff('detail.summary')} amounts={summaryAmounts} facts={summaryFacts} unit={{ heading: tv('amounts.unit'), name: tv('amounts.currency') }} />
      ) : null}

      {request ? (
        <>
          <div className="border-t border-line pt-5">
            <RequestFacts view={request} locale={locale} brief />
          </div>
          <RequestSections view={request} locale={locale} openFile={openFile} doaLinks={false} />
        </>
      ) : po && reader ? (
        // The route of this task, also after a return took the PO back to a draft without one
        <PoBody po={{ ...po, route: task.route ?? po.route }} locale={locale} doaLinks={false} reader={reader} openFile={openFile} requestHref={NO_LINK} />
      ) : variance ? (
        <VarianceBody variance={variance} locale={locale} doaLinks={false} poHref={null} openFile={openFile} />
      ) : task.subjectType === 'INVOICE' ? (
        <LiffInvoiceSummary invoice={await getInvoiceTaskView(ctx, task.subjectId)} />
      ) : (
        <PolicySubject task={task} locale={locale} doaLinks={false} doaSimulate={false} orgAuthorityLink={false} />
      )}

      <LiffSection id="timeline" title={tv('timeline.title')}>
        <Timeline items={items} label={timelineLabel} />
      </LiffSection>
    </>
  )

  const { pinLength } = liffFacts()
  const common = { taskId: task.id, open, pinLength, initial: open ? initial : null, pinSettingsHref: WEB_PIN_SETTINGS_PATH, helpHref: LIFF_HELP_PATH }
  return (
    <LiffFrame title={heading} back={back}>
      {policyTask ? (
        <LiffPolicyDecisionLoader {...common} boundary={boundary} decide={decideLiffPolicyAction}>
          {details}
        </LiffPolicyDecisionLoader>
      ) : (
        <LiffTaskDecisionLoader
          {...common}
          kind={po ? 'PURCHASE_ORDER' : variance ? 'VARIANCE' : 'REQUEST'}
          label={label}
          amount={request?.totals ? money(request.totals.grossSatang) : po ? money(po.totals.grossSatang) : variance ? money(variance.amountSatang) : '-'}
          stepUp={task.stepUp}
          {...(variance ? { disposition: variance.disposition } : {})}
          decide={decideLiffTaskAction}
          {...(request ? { ask: askLiffRequesterAction } : {})}
        >
          {details}
        </LiffTaskDecisionLoader>
      )}
    </LiffFrame>
  )
}
