import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { RouteView } from '@/server/services/doa/view'
import { getWorkflowEditor } from '@/server/services/workflow/view'
import { VersionStatus, versionLook } from '@/ui/admin-doa/version-status'
import { nameIn } from '@/ui/admin-org/names'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Workbench } from '@/ui/admin-workflow/workbench'
import { BacktestPanel } from '@/ui/backtest/panel'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RequestWithdrawal } from '@/ui/policy-withdrawal/request-withdrawal'
import { WithdrawalState } from '@/ui/policy-withdrawal/withdrawal-state'
import { readBacktestRunAction, runBacktestAction } from '../../../../_lib/backtest-actions'
import { getSession } from '../../../../_lib/session'
import { dryRunWorkflowAction, requestWorkflowWithdrawalAction, saveWorkflowAction, submitWorkflowAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminWorkflow')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

// One workflow version (FR-WF-103 AC1 AC2, S6-06): its status and period, who sent and approved it, where its approval
// stands, then the workbench — the rules (edited in a Dialog for a draft), the dry-run beside the version in effect,
// the comparison and, for a draft, the lint and the send. A version that was sent or published is read only; a change
// is a new draft from the list. admin.workflow.draft (ORG_ADMIN), and the version's approver reading it before deciding
// (FR-WF-103 AC3): the service refuses anyone else and this page then says whose page it is. S6-07: the 90-day
// backtest of a draft, a version waiting for approval or one approved for later (BR-WF-13), for whoever may try it out
// — its approver too; a version approved for later may be withdrawn by who may send versions (FR-DOA-104 AC1), and a
// withdrawal asked or done is stated with who asked, when and why.
export default async function WorkflowVersionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tWithdrawal, locale] = await Promise.all([getTranslations('adminWorkflow'), getTranslations('policyWithdrawal'), getLocale()])
  if (!ctx) return null
  const result = await getWorkflowEditor(ctx, id)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) return <NoAccess title={t('title')} message={t('forbidden')} homeLabel={t('homeLink')} />
  const view = result.data
  const v = view.version
  const look = versionLook(v)
  const name = t('versionName', { code: v.code, version: v.versionNo })
  const when = (iso: string) => formatDateTime(locale, iso)
  const person = (p: { nameTh: string; nameEn: string | null }) => nameIn(locale, p)

  const routeLines = (route: RouteView) => {
    const ref = t('doaRef', { code: route.doaCode, version: route.versionNo, rule: route.ruleCode })
    return route.tasks
      .filter((task) => task.status !== 'REASSIGNED' && task.status !== 'CANCELLED')
      .map((task) => {
        const who = task.onBehalfOf ? t('onBehalf', { name: person(task.assignee), principal: person(task.onBehalfOf) }) : person(task.assignee)
        const by = task.decidedBy ? person(task.decidedBy) : who
        if (task.status === 'APPROVED') return t('routeApproved', { name: by, time: when(task.decidedAt ?? task.assignedAt), ref })
        if (task.status === 'REJECTED' || task.status === 'RETURNED') return t('routeRejected', { name: by, time: when(task.decidedAt ?? task.assignedAt), ref })
        return t('routeWaiting', { name: who, ref })
      })
  }
  const submit = view.submit
  const withdrawal = view.withdrawal
  const backtestable = view.canSimulate && (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL' || v.upcoming)
  const waiting = (view.route?.tasks ?? []).filter((task) => task.status === 'OPEN' || task.status === 'INFO_REQUESTED').map((task) => person(task.assignee))
  const approver =
    submit && !('error' in submit.approver)
      ? { ref: t('doaRef', { code: submit.approver.doaCode, version: submit.approver.versionNo, rule: submit.approver.ruleCode }), approvers: submit.approver.approvers }
      : { error: submit && 'error' in submit.approver ? submit.approver.error : 'NONE' }

  return (
    <Page>
      <Link href="/admin/workflows" className={`${linkClass} -mb-4 self-start`}>
        {t('back')}
      </Link>
      <PageHeader title={name}>
        <VersionStatus look={look} label={t(`status.${look}`)} className="self-start" />
        <p className="tabular">
          {v.status === 'PUBLISHED' || v.status === 'SUPERSEDED'
            ? v.effectiveTo
              ? t('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) })
              : t('periodOpen', { from: when(v.effectiveFrom) })
            : view.editable
              ? t('plannedDraft', { from: when(v.effectiveFrom) })
              : t('planned', { from: when(v.effectiveFrom) })}
        </p>
      </PageHeader>

      <PageBody>
        <Panel title={t('facts.title')} id="facts">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="font-medium">{t('facts.reason')}</dt>
            <dd className="break-words text-ink-muted">{v.changeReason ?? t('noReason')}</dd>
            {v.submittedBy && v.submittedAt ? (
              <>
                <dt className="font-medium">{t('facts.submitted')}</dt>
                <dd className="text-ink-muted">{t('byAt', { name: person(v.submittedBy), time: when(v.submittedAt) })}</dd>
              </>
            ) : null}
            {v.approvedBy && v.approvedAt ? (
              <>
                <dt className="font-medium">{t('facts.approved')}</dt>
                <dd className="text-ink-muted">{t('byAt', { name: person(v.approvedBy), time: when(v.approvedAt) })}</dd>
              </>
            ) : null}
            {view.editable ? (
              <>
                <dt className="font-medium">{t('facts.dryRun')}</dt>
                <dd className="text-ink-muted">{v.dryRunAt ? t('facts.dryRunAt', { time: when(v.dryRunAt) }) : t('facts.dryRunNone')}</dd>
              </>
            ) : null}
          </dl>
          {view.route && v.status !== 'DRAFT' ? (
            <div className="flex flex-col gap-1 border-t border-line pt-3">
              <p className="font-medium">{t('facts.route')}</p>
              {routeLines(view.route).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          ) : null}
          {v.status === 'PENDING_APPROVAL' ? (
            // Sent: the same words as the send's own confirmation (§9.9 rule 7), and it cannot change any more
            <Notice tone="success">{waiting.length ? t('submit.sent', { name: waiting.join(', ') }) : t('submit.sentNoName')}</Notice>
          ) : null}
          {view.editable ? null : <Notice tone="info">{v.status === 'PENDING_APPROVAL' ? t('readOnlyPending') : t('readOnly')}</Notice>}
          <WithdrawalState
            pending={withdrawal.pending}
            withdrawnAt={withdrawal.withdrawnAt}
            requestedBy={withdrawal.requestedBy}
            requestedAt={withdrawal.requestedAt}
            reason={withdrawal.reason}
            waiting={withdrawal.pending ? waiting : []}
          />
          {withdrawal.requestable && withdrawal.allowed ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <p className="font-medium">{tWithdrawal('title')}</p>
              <p className="text-ink-muted">{tWithdrawal('intro', { name, time: when(v.effectiveFrom) })}</p>
              <RequestWithdrawal versionId={v.id} versionName={name} request={requestWorkflowWithdrawalAction} />
            </div>
          ) : null}
        </Panel>

        <Panel label={name}>
          <Workbench
            versionId={v.id}
            code={v.code}
            versionNo={v.versionNo}
            lock={v.lock}
            editable={view.editable}
            changeReason={view.editable ? v.changeReason : null}
            rules={view.rules}
            testCases={view.testCases}
            baseline={view.baseline}
            diff={view.diff}
            lint={view.lint}
            context={{ requestTypes: view.requestTypes, positions: view.positions, departments: view.departments, members: view.members }}
            categoryCodes={view.categoryCodes}
            accountCodes={view.accountCodes}
            effectiveDate={view.effectiveDate}
            minEffectiveDate={view.minEffectiveDate}
            slaMaxHours={view.slaMaxHours}
            canSimulate={view.canSimulate}
            dryRunDefaults={view.dryRunDefaults}
            submit={
              submit
                ? {
                    allowed: submit.allowed,
                    dryRunDone: submit.dryRunDone,
                    effectiveInPast: submit.effectiveInPast,
                    laterVersionScheduled: submit.laterVersionScheduled,
                    testCasesFailing: submit.testCasesFailing,
                    approver,
                  }
                : null
            }
            actions={{ save: saveWorkflowAction, dryRun: dryRunWorkflowAction, submit: submitWorkflowAction }}
            backtest={
              backtestable ? <BacktestPanel kind="WORKFLOW_VERSION" versionId={v.id} versionName={name} purpose={withdrawal.pending ? 'withdrawal' : 'draft'} run={runBacktestAction} reread={readBacktestRunAction} /> : undefined
            }
          />
        </Panel>
      </PageBody>
    </Page>
  )
}
