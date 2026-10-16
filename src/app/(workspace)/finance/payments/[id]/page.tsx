import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getPaymentRunPage, type PaymentRunPageDto } from '@/server/services/payments/view'
import { DocBody, DocHeader } from '@/ui/document/doc-header'
import { DocTabs } from '@/ui/document/doc-tabs'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageHeader, Panel } from '@/ui/page/page'
import { RunStatusBadge } from '@/ui/payments/badges'
import { DraftActions } from '@/ui/payments/draft-actions'
import { FilesPanel } from '@/ui/payments/files-panel'
import { ItemsPanel } from '@/ui/payments/items-panel'
import { accountValues, dayText, eventKey, money } from '@/ui/payments/present'
import { ResultsPanel } from '@/ui/payments/results-panel'
import { RunDecision } from '@/ui/payments/run-decision'
import { nameIn, type RunActions } from '@/ui/payments/types'
import { Toaster } from '@/ui/shadcn/sonner'
import { Timeline, type TimelineItem, type TimelineOutcome } from '@/ui/timeline/timeline'
import { getSession } from '../../../../_lib/session'
import { decideTaskAction } from '../../../tasks/actions'
import {
  addDocumentsAction,
  cancelApprovedAction,
  cancelDraftAction,
  downloadFileAction,
  generateFileAction,
  markSentAction,
  recordResultsAction,
  regenerateFileAction,
  removeDocumentsAction,
  resendAdviceAction,
  revertSentAction,
  setFlagReasonAction,
  submitRunAction,
} from '../actions'

// /finance/payments/[id] (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-101 to FR-PAY-103, demo steps 2 to 6 and 9): the
// head — number, status, pay date, payer masked, and the row of what it pays, withholds and transfers to how many
// suppliers — with the notice of the neutral template (BR-BANK-05); then the tabs รายการ · ไฟล์ · ผลการจ่าย · ประวัติ
// (the tab in the address) and, on the right, the approver's decision bar with the acknowledgement of the flags and the
// step-up, or the preparer's sending and cancelling. Every action goes through a server action and the S9 services,
// which check everything again; AUDITOR and approvers read the run masked and act on nothing else. The task of a payment
// run opens here (/tasks/[id] sends it on).

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const TABS = ['items', 'files', 'results', 'history'] as const
const CHANNELS = ['WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'APP', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP'] as const

const ACTIONS: RunActions = {
  addDocuments: addDocumentsAction,
  removeDocuments: removeDocumentsAction,
  setFlagReason: setFlagReasonAction,
  submit: submitRunAction,
  cancelDraft: cancelDraftAction,
  generateFile: generateFileAction,
  regenerateFile: regenerateFileAction,
  downloadFile: downloadFileAction,
  markSent: markSentAction,
  revertSent: revertSentAction,
  cancelApproved: cancelApprovedAction,
  recordResults: recordResultsAction,
  resendAdvice: resendAdviceAction,
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const t = await getTranslations('payRun.run')
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const run = ctx ? await getPaymentRunPage(ctx, id) : null
  return { title: run?.ok && run.data.number ? t('metaTitle', { number: run.data.number }) : t('metaTitleDraft') }
}

/** The tab a run opens on without one in the address: where its work is now */
function tabOf(status: string): (typeof TABS)[number] {
  if (status === 'APPROVED' || status === 'FILE_READY') return 'files'
  if (status === 'SENT_TO_BANK' || status === 'COMPLETED') return 'results'
  return 'items'
}

type PayT = Awaited<ReturnType<typeof getTranslations<'payRun'>>>
type TimelineT = Awaited<ReturnType<typeof getTranslations<'timeline'>>>

const DECISION_OUTCOME: Readonly<Record<string, TimelineOutcome>> = { APPROVE: 'approved', RETURN: 'returned', REJECT: 'rejected' }

/** The run's events as the vertical timeline of §9.9: each a done step, a decision drawn as a stamp with its DOA rule */
function historyItems(t: PayT, tl: TimelineT, locale: string, run: PaymentRunPageDto): TimelineItem[] {
  return run.history.map((e) => {
    const key = `history.event.${eventKey(e.type)}`
    const values = { version: e.fileVersion ?? '-', supplier: e.supplierCode ?? '-' }
    const decision = e.decision && t.has(`history.decision.${e.decision}` as 'history.decision.APPROVE') ? t(`history.decision.${e.decision}` as 'history.decision.APPROVE') : null
    const title = decision ?? (t.has(key as 'history.event.other') ? t(key as 'history.event.other', values) : t('history.event.other'))
    const outcome: TimelineOutcome = e.decision ? (DECISION_OUTCOME[e.decision] ?? 'neutral') : e.type === 'payment_run.cancelled' ? 'cancelled' : e.type === 'payment_run.rejected' ? 'rejected' : 'neutral'
    const channel = (CHANNELS as readonly string[]).includes(e.channel) ? tl(`channel.${e.channel as (typeof CHANNELS)[number]}`) : undefined
    return {
      id: e.id,
      title,
      actor: e.actor ? nameIn(locale, e.actor) : t('history.system'),
      when: formatDateTime(locale, e.occurredAt),
      ...(channel ? { channel } : {}),
      ...(e.doa ? { doaRef: tl('doaRef', { code: e.doa.code, version: e.doa.versionNo, rule: e.doa.ruleCode }) } : {}),
      ...(e.note ? { note: e.note, noteLabel: t('history.reason') } : {}),
      state: 'done' as const,
      outcome,
      statusLabel: decision ?? t('history.done'),
      stamp: Boolean(e.decision),
    }
  })
}

export default async function PaymentRunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params
  const query = await searchParams
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tl, locale] = await Promise.all([getTranslations('payRun'), getTranslations('timeline'), getLocale()])
  const result = await getPaymentRunPage(ctx, id)
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound()
    return (
      <Page>
        <PageHeader title={t('run.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('run.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('run.home')}
          </Link>
        </div>
      </Page>
    )
  }
  const run = result.data
  const statusLabel = t(`status.${run.status}` as 'status.DRAFT')
  const title = run.number ? t('run.title', { number: run.number }) : t('run.titleDraft')
  const payer = run.payer.code ? t('account.withCode', accountValues(locale, run.payer)) : t('account.masked', accountValues(locale, run.payer))
  const acts = Object.values(run.may).some(Boolean)
  const decide = run.decision
  const reasonsMissing = run.items.filter((i) => i.reasonNeeded).length
  const wanted = typeof query.tab === 'string' ? query.tab : ''
  const initial = (TABS as readonly string[]).includes(wanted) ? wanted : tabOf(run.status)

  const tabs = [
    {
      value: 'items',
      label: t('run.tab.items'),
      content: (
        <ItemsPanel
          paymentRunId={run.id}
          version={run.version}
          payDate={run.payDate}
          items={run.items}
          editable={run.may.edit}
          addable={run.addable}
          actions={{ addDocuments: ACTIONS.addDocuments, removeDocuments: ACTIONS.removeDocuments, setFlagReason: ACTIONS.setFlagReason }}
        />
      ),
    },
    {
      value: 'files',
      label: t('run.tab.files'),
      content: (
        <FilesPanel
          paymentRunId={run.id}
          version={run.version}
          status={run.status}
          files={run.files}
          downloaded={run.downloaded}
          may={run.may}
          actions={{
            generateFile: ACTIONS.generateFile,
            regenerateFile: ACTIONS.regenerateFile,
            downloadFile: ACTIONS.downloadFile,
            markSent: ACTIONS.markSent,
            revertSent: ACTIONS.revertSent,
            cancelApproved: ACTIONS.cancelApproved,
          }}
        />
      ),
    },
    {
      value: 'results',
      label: t('run.tab.results'),
      content: (
        <ResultsPanel
          paymentRunId={run.id}
          version={run.version}
          status={run.status}
          payDate={run.payDate}
          today={run.today}
          items={run.items}
          adviceEmail={run.adviceEmail}
          may={run.may}
          actions={{ recordResults: ACTIONS.recordResults, resendAdvice: ACTIONS.resendAdvice }}
        />
      ),
    },
    {
      value: 'history',
      label: t('run.tab.history'),
      content: (
        <section aria-labelledby="run-history-title" className="flex flex-col gap-4">
          <h2 id="run-history-title" className="text-base font-semibold text-ink">
            {t('history.title')}
          </h2>
          {run.history.length ? <Timeline items={historyItems(t, tl, locale, run)} label={t('history.title')} /> : <p className="text-ink-muted">{t('history.empty')}</p>}
        </section>
      ),
    },
  ]

  const notices = (
    <div className="flex flex-col gap-2">
      {run.neutralTemplate ? (
        <Notice tone="warning" role="status">
          {t('run.neutral')}
        </Notice>
      ) : null}
      {run.status === 'CANCELLED' && run.cancelReason ? <Notice tone="info">{t('run.cancelled', { reason: run.cancelReason })}</Notice> : null}
      {run.status === 'REJECTED' ? (
        <Notice tone="danger" role="status">
          {t('run.rejected')}
        </Notice>
      ) : null}
      {run.status === 'PENDING_APPROVAL' && !decide ? <Notice tone="info">{t('run.waitingApprover')}</Notice> : null}
      {run.status === 'DRAFT' && !run.may.edit ? <Notice tone="info">{t('run.waitingPreparer', { name: nameIn(locale, run.preparedBy) })}</Notice> : null}
      {!acts && !decide ? <Notice tone="info">{t('run.readOnly')}</Notice> : null}
    </div>
  )

  return (
    <div className={decide ? 'flex flex-col gap-6 pb-[calc(var(--task-bar-space,14rem)_+_1rem)] xl:pb-0' : 'flex flex-col gap-6'}>
      <DocHeader
        back={{ href: '/finance/payments', label: t('run.back') }}
        number={run.number ? `${t('run.numberLabel')} ${run.number}` : t('run.numberDraft')}
        title={title}
        badges={<RunStatusBadge status={run.status} label={statusLabel} />}
        actions={null}
        summary={[
          { label: t('run.payDate'), value: dayText(locale, run.payDate) },
          { label: t('run.payer'), value: payer },
          { label: t('run.preparedBy'), value: nameIn(locale, run.preparedBy) },
          { label: t('run.payable'), value: <span className="money">{money(run.totalPayableSatang)}</span> },
          { label: t('run.wht'), value: <span className="money">{money(run.totalWhtSatang)}</span> },
          { label: t('run.transfer'), value: <span className="money font-semibold">{money(run.totalTransferSatang)}</span> },
          { label: t('run.suppliers'), value: t('run.suppliersValue', { count: run.itemCount, documents: run.documentCount }) },
        ]}
        compactBadge={<RunStatusBadge status={run.status} label={statusLabel} />}
        notices={notices}
      />
      <DocBody
        main={<DocTabs tabs={tabs} initial={initial} label={t('run.tabsLabel')} param="tab" />}
        rail={
          <>
            {decide ? (
              <RunDecision
                taskId={decide.taskId}
                label={run.number ?? title}
                amount={money(run.totalTransferSatang)}
                flagged={run.flaggedItems}
                flagsKey={decide.flagsKey}
                stepUp={decide.stepUp}
                locale={locale}
                decide={decideTaskAction}
              />
            ) : null}
            {run.may.edit || run.may.cancelDraft ? (
              <Panel title={run.may.edit ? t('draft.title') : t('draft.cancelTitle')} id="run-draft">
                <DraftActions
                  paymentRunId={run.id}
                  version={run.version}
                  mayEdit={run.may.edit}
                  mayCancel={run.may.cancelDraft}
                  reasonsMissing={reasonsMissing}
                  actions={{ submit: ACTIONS.submit, cancelDraft: ACTIONS.cancelDraft }}
                />
              </Panel>
            ) : null}
          </>
        }
      />
      <Toaster position="top-center" />
    </div>
  )
}
