import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { getPoAccess, getPurchaseOrderView, getVarianceView } from '@/server/queries/purchase-orders'
import { getRequestView, type TrackEntryDto } from '@/server/queries/requests'
import { getTaskAccess, getTaskView, listMyTasks, POLICY_SUBJECTS, type TaskViewDto } from '@/server/queries/tasks'
import { Notice } from '@/ui/form/notice'
import { StateLine } from '@/ui/request-view/status'
import { DecisionPanel } from '@/ui/tasks/decision-panel'
import { PolicyDecision } from '@/ui/tasks/policy-decision'
import { Timeline } from '@/ui/timeline/timeline'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { canOpenDoaVersion, canOpenOrgAuthorityChanges, taskRight } from '../../_tracking/access'
import { PolicySubject, boundaryTickOf, policyHeadline } from '../../_tracking/policy-subject'
import { dueText, localeOf, memberName, money, nameIn, roleText, timelineItems, waitingText, when, type Locale, type ViewT } from '../../_tracking/present'
import { RequestFacts, RequestSections } from '../../_tracking/request-sections'
import { taskTitle } from '../../_tracking/rows'
import { canViewPo, poReader } from '../../procurement/pos/_parts/access'
import { PoBody } from '../../procurement/pos/_parts/po-body'
import { docTimelineItems } from '../../procurement/pos/_parts/present'
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
      return (
        <Notice tone={task.status === 'APPROVED' ? 'success' : 'warning'}>
          <p>{text}</p>
          {task.reason && task.status !== 'APPROVED' ? <p className="break-words whitespace-pre-line">{t('state.reason', { reason: task.reason })}</p> : null}
        </Notice>
      )
    }
    case 'REASSIGNED':
      return <Notice tone="info">{task.reassignedTo ? t('state.reassigned', { name: memberName(locale, task.reassignedTo) }) : t('state.reassignedUnknown')}</Notice>
    default:
      return <Notice tone="info">{t(`state.cancelled.${task.cancelledWhy ?? 'other'}`)}</Notice>
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
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('detail.notYours')}</h1>
        <Notice tone="warning">{t('detail.notYoursHint')}</Notice>
        <Link href="/tasks" className={linkClass}>
          {t('detail.toInbox')}
        </Link>
      </div>
    )
  }

  const task = await getTaskView(ctx, id)
  if (!task) notFound()
  const request = task.subjectType === 'REQUEST' ? await getRequestView(ctx, task.subjectId) : null
  const po = task.subjectType === 'PURCHASE_ORDER' ? await getPurchaseOrderView(ctx, task.subjectId) : null
  const variance = task.subjectType === 'VARIANCE' ? await getVarianceView(ctx, task.subjectId) : null
  const [tp, poAccess] = await Promise.all([getTranslations('purchaseOrder'), po ? getPoAccess(ctx, po.id) : variance ? getPoAccess(ctx, variance.po.id) : Promise.resolve(null)])
  // The PO opens for whoever may see it (po.view); otherwise its number is plain text, never a link that ends in a refusal
  const poHref = poAccess && canViewPo(principal, poAccess) ? `/procurement/pos/${poAccess.poId}` : null
  // The approver decides on the prices too: the prices paid before for the same items (FR-P2P-003 AC1)
  const reader = po ? poReader(principal, poAccess, po, { prices: true }) : null
  const open = right === 'DECIDE' && task.status === 'OPEN'
  // A DOA version or an authority change (BR-DOA-15): approved or rejected with the PIN, on a page of its own
  const policyTask = POLICY_SUBJECTS.includes(task.subjectType)
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
  const pageClass = open ? `flex flex-col gap-6 ${barSpace} lg:pb-0` : 'flex flex-col gap-6'

  return (
    <div className={pageClass}>
      <Link href="/tasks" className={linkClass}>
        {t('detail.back')}
      </Link>

      <header className="flex max-w-4xl flex-col gap-3">
        <div className="flex flex-col gap-1">
          {request?.number ? <p className="font-medium text-ink-muted">{t('detail.requestLabel', { number: request.number })}</p> : null}
          {po?.number ? <p className="font-medium text-ink-muted">{t('detail.poLabel', { number: po.number })}</p> : null}
          {variance ? <p className="font-medium text-ink-muted">{t('detail.varianceLabel', { number: variance.po.number ?? '-' })}</p> : null}
          <h1 className="text-2xl font-semibold break-words">{heading}</h1>
          {request ? (
            <p className="text-ink-muted">
              {memberName(locale, request.requester)}
              {request.chargedDepartment ? ` · ${nameIn(locale, request.chargedDepartment.name)}` : ''}
              {` · ${nameIn(locale, request.requestType.name)}`}
            </p>
          ) : null}
          {po ? (
            <p className="text-ink-muted">
              {t('detail.poMeta', { site: po.deliverySite?.nameTh ?? tp('detail.noSite'), kind: tp(`kind.${po.kind}`) })}
              {po.submittedBy ? ` · ${t('item.poMeta', { name: memberName(locale, po.submittedBy) })}` : ''}
            </p>
          ) : null}
          {variance ? <p className="text-ink-muted">{variance.po.supplier.nameTh}</p> : null}
        </div>
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
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {request ? (
            <>
              <RequestFacts view={request} locale={locale} brief />
              <RequestSections view={request} locale={locale} openFile={downloadUrlAction} doaLinks={doaLinks} />
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
          ) : (
            <PolicySubject task={task} locale={locale} doaLinks={doaLinks} doaSimulate={doaSimulate} orgAuthorityLink={canOpenOrgAuthorityChanges(principal)} />
          )}
        </div>

        <aside className="flex min-w-0 flex-col gap-8">
          {policyTask ? (
            <PolicyDecision taskId={task.id} open={open} locale={locale} boundary={boundary} decide={decidePolicyTaskAction} />
          ) : (
            <DecisionPanel
              taskId={task.id}
              open={open}
              locale={locale}
              label={label}
              amount={request?.totals ? money(request.totals.grossSatang) : po ? money(po.totals.grossSatang) : variance ? money(variance.amountSatang) : '-'}
              kind={po ? 'PURCHASE_ORDER' : variance ? 'VARIANCE' : 'REQUEST'}
              stepUp={task.stepUp}
              {...(variance ? { disposition: variance.disposition } : {})}
              actions={po || variance ? { decide: decideTaskAction } : { decide: decideTaskAction, ask: askForInformationAction }}
            />
          )}
          <section aria-labelledby="timeline" className="flex flex-col gap-3">
            <h2 id="timeline" className="text-lg font-semibold text-ink">
              {tv('timeline.title')}
            </h2>
            <Timeline items={items} label={timelineLabel} />
          </section>
        </aside>
      </div>
    </div>
  )
}
