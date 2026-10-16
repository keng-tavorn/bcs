import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { PolicyField } from '@/server/services/doa/diff'
import { getDoaVersionForAdmin, type RouteView, type RuleView } from '@/server/services/doa/view'
import { hasAmount } from '@/ui/admin-doa/editor-model'
import { InitialPackageForm } from '@/ui/admin-doa/initial-package-form'
import { LintIssueText } from '@/ui/admin-doa/lint-issue'
import { SubmitDoaPanel } from '@/ui/admin-doa/submit-panel'
import { VersionStatus, versionLook } from '@/ui/admin-doa/version-status'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { BacktestPanel } from '@/ui/backtest/panel'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RequestWithdrawal } from '@/ui/policy-withdrawal/request-withdrawal'
import { WithdrawalState } from '@/ui/policy-withdrawal/withdrawal-state'
import { readBacktestRunAction, runBacktestAction } from '../../../../_lib/backtest-actions'
import { getSession } from '../../../../_lib/session'
import { AuthorityList, BoundaryCompare, DiffList, Section, diffIsEmpty, keepTogether, type Baseline } from '../_parts/sections'
import { DOCUMENT_TYPES, doaWords } from '../_parts/words'
import { requestDoaWithdrawalAction, submitDoaAction, submitInitialPackageAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminDoa')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
// Rule, the two band edges (money, right-aligned), and the approver with the SLA under it; a policy change has no
// amount (BR-DOA-08 (จ)), so its rules have no band columns
const RULE_GRID = 'md:grid-cols-[6.5rem_8rem_8rem_minmax(0,1fr)]'
const RULE_GRID_NO_AMOUNT = 'md:grid-cols-[6.5rem_minmax(0,1fr)]'
/** The section the drafter's tick links to (FR-DOA-009 AC3) */
const BOUNDARY_SECTION = 'boundaries'

// One DOA version (FR-DOA-001 AC3, FR-DOA-002 AC1, FR-DOA-009, BR-DOA-19): its status, effective period and history
// (reason, who drafted, submitted and approved, the diff with the version before), its rules and policy, the boundary
// table with the rule and approvers at each band edge, and for a draft what sending it needs. A draft or a version
// waiting for approval is read beside the version it replaces — the one in effect now, or one approved for later that
// is in effect just before it starts: what changes, who gains or loses authority, and both boundary tables, which the
// drafter ticks as checked before sending whenever there is one (FR-DOA-009 AC1, AC3). A version that was sent or
// published has no edit control: a change is a new draft, edited from it on screen or imported. Wide screens: content
// on the left, status, tools and the send on the right (§9.9 document pages); phones: status and tools first, then the
// content, then the send, so the drafter reaches it after reading the boundary table they tick (a draft that cannot be
// sent says why up there, with the status, since it has nothing to tick or send). The initial package of
// an organization without a DOA is the page's main task and a list of holders, so it gets its own full-width section
// first, before the content, on every screen. S6-07: a draft or a version waiting for approval has the 90-day backtest
// (FR-DOA-103) after its comparison; a version approved for later may be withdrawn (FR-DOA-104 AC1) by who may send
// versions, with a reason, and a withdrawal asked or done is stated beside the status (who asked, when and why).
export default async function DoaVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tVersions, tBacktest, tWithdrawal, locale] = await Promise.all([getTranslations('adminDoa.detail'), getTranslations('adminDoa'), getTranslations('backtest'), getTranslations('policyWithdrawal'), getLocale()])
  if (!ctx) return null
  const result = await getDoaVersionForAdmin(ctx, versionId)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) return <NoAccess title={tVersions('title')} message={tVersions('forbidden')} homeLabel={tVersions('homeLink')} />
  const view = result.data
  const v = view.version
  const look = versionLook(v)
  const words = doaWords(tVersions, locale)
  const name = words.versionName(v)
  const when = (iso: string) => formatDateTime(locale, iso)
  const person = words.person

  const lowerCell = (rule: RuleView) => {
    if (!rule.band) return null
    if (rule.band.gte !== undefined) return t('atLeast', { amount: words.money(rule.band.gte) })
    return words.money(rule.band.gt ?? '0')
  }
  const upperCell = (rule: RuleView) => (rule.band?.lte !== undefined ? words.money(rule.band.lte) : t('noLimit'))

  const routeLines = (route: RouteView) => {
    const ref = route.initialPackage ? t('initialRoute') : tVersions('doaRef', { code: route.doaCode, version: route.versionNo, rule: route.ruleCode })
    return route.tasks
      .filter((task) => task.status !== 'REASSIGNED' && task.status !== 'CANCELLED')
      .map((task) => {
        const who = task.onBehalfOf ? t('onBehalf', { name: person(task.assignee), principal: person(task.onBehalfOf) }) : person(task.assignee)
        if (task.status === 'APPROVED') return t('routeApproved', { name: task.decidedBy ? person(task.decidedBy) : who, time: when(task.decidedAt ?? task.assignedAt), ref })
        if (task.status === 'REJECTED') return t('routeRejected', { name: task.decidedBy ? person(task.decidedBy) : who, time: when(task.decidedAt ?? task.assignedAt), ref })
        return t('routeWaiting', { name: who, ref })
      })
  }

  const rulesByType = DOCUMENT_TYPES.map((d) => ({ documentType: d, rules: view.rules.filter((r) => r.documentType === d) })).filter((g) => g.rules.length)
  const previousName = view.previous ? words.versionName({ code: v.code, versionNo: view.previous.versionNo }) : ''
  const compare = view.compare
  // The version it replaces: in effect now, or approved for later and in effect just before this one starts
  const baseline: Baseline | null = compare ? { name: words.versionName(compare.baseline), next: !compare.baseline.inEffectNow } : null
  const boundaryTables = compare ? compare.boundaries : view.ownBoundaries
  // The drafter ticks the boundary table this page shows, when it has one (FR-DOA-009 AC3; the service asks for the same)
  const boundaryTableId = boundaryTables.length ? BOUNDARY_SECTION : null
  const simulateHref = `/admin/doa/${v.id}/simulate`
  const compareWords = (key: 'compareTitle' | 'compareNone') => (baseline?.next ? (`${key}Next` as const) : key)

  const submit = view.submit
  const waiting = (view.route?.tasks ?? []).filter((task) => task.status === 'OPEN' || task.status === 'INFO_REQUESTED').map((task) => person(task.assignee))
  const withdrawal = view.withdrawal
  // The 90-day backtest of a draft or a version waiting for approval (FR-DOA-103): what it would change on the documents
  // of the last 90 days, before it is sent or decided
  const backtestable = view.canBacktest && (v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')
  const blocked = submit?.mode === 'NORMAL' && (submit.effectiveInPast || submit.laterVersionScheduled !== null || submit.errors.length > 0 || !submit.allowed)
  const initial = submit?.mode === 'INITIAL' ? submit : null
  // The send: on wide screens in the right column; on phones after the content when it can be sent (the boundary table
  // is read before it is ticked), or with the status first when it cannot, since then it only says why
  const sendSection =
    submit?.mode === 'NORMAL' ? (
      <Section id="submit" title={t('submitTitle')}>
        {blocked ? null : (
          <>
            <p className="text-ink-muted">{t('submitIntro')}</p>
            {'error' in submit.approver ? (
              <Notice tone="danger">{t('approverError')}</Notice>
            ) : (
              <p>
                {t('approverLine', {
                  names: submit.approver.approvers.map(person).join(', '),
                  ref: tVersions('doaRef', { code: submit.approver.doaCode, version: submit.approver.versionNo, rule: submit.approver.ruleCode }),
                })}
              </p>
            )}
            {submit.current && submit.openTasksUnderCurrent > 0 ? (
              <p className="text-ink-muted">{t('openTasks', { count: submit.openTasksUnderCurrent, name: words.versionName(submit.current) })}</p>
            ) : null}
          </>
        )}
        {submit.effectiveInPast ? <Notice tone="danger">{t('effectiveInPast', { time: when(v.effectiveFrom) })}</Notice> : null}
        {submit.laterVersionScheduled !== null ? <Notice tone="danger">{t('laterScheduled', { version: submit.laterVersionScheduled })}</Notice> : null}
        {submit.errors.length ? (
          <Notice tone="danger">
            <p className="font-medium">{t('errorsTitle')}</p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
              {submit.errors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <LintIssueText issue={e} />
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}
        {blocked ? null : (
          <SubmitDoaPanel
            versionId={v.id}
            warnings={submit.warnings}
            approvers={'error' in submit.approver ? [] : submit.approver.approvers}
            boundaryTableId={boundaryTableId}
            submit={submitDoaAction}
          />
        )}
      </Section>
    ) : null

  return (
    <Page>
      <Link href="/admin/doa" className={`${linkClass} -mb-4 self-start`}>
        {t('back')}
      </Link>
      <PageHeader title={name}>
        <VersionStatus look={look} label={tVersions(`status.${look}`)} className="self-start" />
        <p className="tabular">
          {v.status === 'PUBLISHED' || v.status === 'SUPERSEDED'
            ? v.effectiveTo
              ? tVersions('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) })
              : tVersions('periodOpen', { from: when(v.effectiveFrom) })
            : tVersions('planned', { from: when(v.effectiveFrom) })}
        </p>
      </PageHeader>

      <PageBody>
        {initial ? (
          <div className="max-w-4xl">
            <Section id="submit" title={t('initial.title')}>
              <p className="text-ink-muted">{t('initial.intro')}</p>
              {initial.effectiveInPast ? <Notice tone="danger">{t('effectiveInPast', { time: when(v.effectiveFrom) })}</Notice> : null}
              {initial.signatory === null ? <Notice tone="warning">{t('initial.noSignatory')}</Notice> : null}
              {initial.submitterIsSignatory ? <Notice tone="warning">{t('initial.youAreSignatory')}</Notice> : null}
              {initial.effectiveInPast || initial.submitterIsSignatory || !initial.allowed ? null : (
                <InitialPackageForm
                  versionId={v.id}
                  positions={initial.positions}
                  departments={initial.departments}
                  members={initial.members}
                  holders={initial.holders}
                  signatory={initial.signatory}
                  boundaryTableId={boundaryTableId}
                  submit={submitInitialPackageAction}
                />
              )}
            </Section>
          </div>
        ) : null}

        {/* Wide screens: the content on the left; status, tools and the send on the right. Phones: status and tools, then
            the content, then the send (DOM order), so the boundary table is read before it is ticked. The content spans
            both rows on the left; the second row is flexible, so the first is only as tall as the status beside it. */}
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-6">
          <aside aria-label={t('asideLabel')} className="flex flex-col gap-4 lg:col-start-2 lg:row-start-1 lg:gap-6">
            <Panel>
              <dl className="flex flex-col gap-2">
                <dt className="font-medium">{t('reasonLabel')}</dt>
                <dd className="break-words text-ink-muted">{v.changeReason ?? tVersions('noReason')}</dd>
                {view.importedBy && view.importedAt ? (
                  <>
                    <dt className="font-medium">{t('importedLabel')}</dt>
                    <dd className="text-ink-muted">{t('byAt', { name: person(view.importedBy), time: when(view.importedAt) })}</dd>
                  </>
                ) : null}
                {v.submittedBy && v.submittedAt ? (
                  <>
                    <dt className="font-medium">{t('submittedLabel')}</dt>
                    <dd className="text-ink-muted">{t('byAt', { name: person(v.submittedBy), time: when(v.submittedAt) })}</dd>
                  </>
                ) : null}
                {v.approvedBy && v.approvedAt ? (
                  <>
                    <dt className="font-medium">{t('approvedLabel')}</dt>
                    <dd className="text-ink-muted">{t('byAt', { name: person(v.approvedBy), time: when(v.approvedAt) })}</dd>
                  </>
                ) : null}
              </dl>

              <nav aria-label={t('toolsTitle')} className="flex flex-col border-t border-line pt-2">
                <Link href={simulateHref} className={`${linkClass} self-start`}>
                  {t('simulateLink')}
                </Link>
                <Link href={`/admin/doa/${v.id}/edit`} className={`${linkClass} self-start`}>
                  {t('editLink')}
                </Link>
                <a href={`/admin/doa/${v.id}/export`} download className={`${linkClass} self-start`}>
                  {tVersions('download', { name })}
                </a>
              </nav>
            </Panel>

            {/* A version approved for later may be withdrawn before it starts (FR-DOA-104 AC1); one asked or done says so */}
            {withdrawal.pending || withdrawal.withdrawnAt || (withdrawal.requestable && withdrawal.allowed) ? (
              <Section id="withdrawal" title={tWithdrawal('title')}>
                <WithdrawalState
                  pending={withdrawal.pending}
                  withdrawnAt={withdrawal.withdrawnAt}
                  requestedBy={withdrawal.requestedBy}
                  requestedAt={withdrawal.requestedAt}
                  reason={withdrawal.reason}
                  waiting={withdrawal.pending ? waiting : []}
                />
                {withdrawal.requestable && withdrawal.allowed ? (
                  <>
                    <p className="text-ink-muted">{tWithdrawal('intro', { name, time: when(v.effectiveFrom) })}</p>
                    <RequestWithdrawal versionId={v.id} versionName={name} request={requestDoaWithdrawalAction} />
                  </>
                ) : null}
              </Section>
            ) : null}

            {view.route && v.status !== 'DRAFT' ? (
              <Section id="route" title={t('routeTitle')}>
                {routeLines(view.route).map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </Section>
            ) : null}

            {submit === null ? (
              v.status === 'PENDING_APPROVAL' ? (
                // Sent: the same words as the send's own confirmation (§9.9 rule 7) — the initial package's own, when it
                // went as one — and it cannot change any more
                <Notice tone="success">
                  {view.route?.initialPackage
                    ? waiting.length
                      ? t('initial.sent', { name: waiting.join(', ') })
                      : t('initial.sentNoName')
                    : waiting.length
                      ? t('submitted', { name: waiting.join(', ') })
                      : t('submittedNoName')}
                </Notice>
              ) : (
                <Notice tone="info">{t('readOnly')}</Notice>
              )
            ) : blocked ? (
              sendSection
            ) : null}
          </aside>

          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:gap-6">
            {compare && baseline ? (
              <>
                <Section id="diff" title={t.rich(compareWords('compareTitle'), { name: baseline.name, now: keepTogether })}>
                  {baseline.next ? <p className="text-base text-ink-muted md:text-sm">{t('compareNextNote', { name: baseline.name, time: when(compare.baseline.effectiveFrom) })}</p> : null}
                  {diffIsEmpty(compare.diff) ? (
                    <p className="text-ink-muted">{t.rich(compareWords('compareNone'), { name: baseline.name, now: keepTogether })}</p>
                  ) : (
                    <DiffList diff={compare.diff} before={compare.baseline.rules} after={view.rules} t={tVersions} words={words} />
                  )}
                </Section>
                <Section id="authority" title={t('authorityTitle')}>
                  <AuthorityList compare={compare} baseline={baseline} simulateHref={simulateHref} t={tVersions} words={words} />
                </Section>
              </>
            ) : (
              <Section id="diff" title={view.previous ? t('diffTitle', { name: previousName }) : t('diffTitleFirst')}>
                {view.previous === null || view.diff === null ? (
                  <p className="text-ink-muted">{t('diffFirst', { code: v.code })}</p>
                ) : diffIsEmpty(view.diff) ? (
                  <p className="text-ink-muted">{t('diffNone', { name: previousName })}</p>
                ) : (
                  <DiffList diff={view.diff} before={view.previous.rules} after={view.rules} t={tVersions} words={words} />
                )}
              </Section>
            )}

            {backtestable ? (
              <Section id="backtest" title={tBacktest('title')}>
                <BacktestPanel kind="DOA_VERSION" versionId={v.id} versionName={name} purpose="draft" run={runBacktestAction} reread={readBacktestRunAction} />
              </Section>
            ) : null}

            {boundaryTables.length ? (
              <Section id={BOUNDARY_SECTION} title={t('boundaryTitle')}>
                <BoundaryCompare tables={boundaryTables} baseline={baseline} basis={compare?.basis ?? null} simulateHref={simulateHref} t={tVersions} words={words} />
              </Section>
            ) : null}

            <Section id="rules" title={t('rulesTitle', { count: view.rules.length })}>
              {rulesByType.map((group) => (
                <div key={group.documentType} className="flex flex-col gap-1">
                  <h3 className="text-base font-semibold">{words.documentType(group.documentType)}</h3>
                  <div className={`hidden border-b border-line pb-2 text-sm font-medium text-ink-muted md:grid md:gap-x-4 ${hasAmount(group.documentType) ? RULE_GRID : RULE_GRID_NO_AMOUNT}`} aria-hidden="true">
                    <span>{t('ruleHeaders.rule')}</span>
                    {hasAmount(group.documentType) ? (
                      <>
                        <span className="text-right">{t('ruleHeaders.above')}</span>
                        <span className="text-right">{t('ruleHeaders.upTo')}</span>
                      </>
                    ) : null}
                    <span>{t('ruleHeaders.approverSla')}</span>
                  </div>
                  <ul className="flex flex-col divide-y divide-line border-b border-line">
                    {group.rules.map((r) => (
                      <li key={r.code} className={`grid grid-cols-1 gap-1 py-3 md:items-baseline md:gap-x-4 ${hasAmount(group.documentType) ? RULE_GRID : RULE_GRID_NO_AMOUNT}`}>
                        <p className="font-semibold">
                          <span className="md:sr-only">{t('ruleHeaders.rule')} </span>
                          {r.code}
                        </p>
                        {!hasAmount(group.documentType) ? null : r.band ? (
                          <>
                            <p className="flex justify-between gap-4 md:block md:text-right">
                              <span className="shrink-0 text-ink-muted md:sr-only">{t('ruleHeaders.above')}</span>
                              <span className="tabular">{lowerCell(r)}</span>
                            </p>
                            <p className="flex justify-between gap-4 md:block md:text-right">
                              <span className="shrink-0 text-ink-muted md:sr-only">{t('ruleHeaders.upTo')}</span>
                              <span className="tabular">{upperCell(r)}</span>
                            </p>
                          </>
                        ) : (
                          <p className="md:col-span-2 md:text-right">{t('anyAmount')}</p>
                        )}
                        <div className="flex flex-col">
                          <span className="text-ink-muted md:sr-only">{t('ruleHeaders.approver')}</span>
                          <span>{words.rulesApprover(r)}</span>
                          <span className="text-base text-ink-muted md:text-sm">
                            <span className="md:sr-only">{t('ruleHeaders.sla')} </span>
                            {words.rulesSla(r)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Section>

            <Section id="policy" title={t('policyTitle')}>
              <dl className="grid gap-x-6 gap-y-2 border-y border-line py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                {(Object.keys(view.policy) as PolicyField[]).map((field) => (
                  <div key={field} className="contents">
                    <dt className="text-ink-muted">{t(`policy.${field}`)}</dt>
                    <dd className={field === 'stepUpThreshold' ? 'money font-medium' : 'font-medium'}>{words.policyText(field, view.policy[field])}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          </div>

          {submit?.mode === 'NORMAL' && !blocked ? <div className="flex flex-col lg:col-start-2 lg:row-start-2">{sendSection}</div> : null}
        </div>
      </PageBody>
    </Page>
  )
}
