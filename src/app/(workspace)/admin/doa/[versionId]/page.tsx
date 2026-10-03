import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { PolicyField, PolicyValue } from '@/server/services/doa/diff'
import { getDoaVersionForAdmin, type RouteView, type RuleView } from '@/server/services/doa/view'
import { bandText } from '@/ui/admin-doa/band'
import { InitialPackageForm } from '@/ui/admin-doa/initial-package-form'
import { LintIssueText } from '@/ui/admin-doa/lint-issue'
import { SubmitDoaPanel } from '@/ui/admin-doa/submit-panel'
import { VersionStatus, versionLook } from '@/ui/admin-doa/version-status'
import { nameIn } from '@/ui/admin-org/names'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { getSession } from '../../../../_lib/session'
import { submitDoaAction, submitInitialPackageAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('adminDoa')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'
const DOCUMENT_TYPES = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'] as const
const MINUTES_PER_HOUR = 60
// Rule, the two band edges (money, right-aligned), and the approver with the SLA under it
const RULE_GRID = 'md:grid-cols-[6.5rem_8rem_8rem_minmax(0,1fr)]'

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  )
}

// One DOA version (FR-DOA-001 AC3, FR-DOA-002 AC1, BR-DOA-19): its status, effective period and history (reason, who
// imported, submitted and approved, the diff with the version before), its rules and policy, the boundary table, and
// for a draft what sending it needs. A version that was sent or published has no edit control: a change is a new
// version. Wide screens: content on the left, status and actions on the right (§9.9 document pages). The initial
// package of an organization without a DOA is the page's main task and a list of holders, so it gets its own full-width
// section first, before the content, on every screen.
export default async function DoaVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  const [t, tVersions, locale] = await Promise.all([getTranslations('adminDoa.detail'), getTranslations('adminDoa'), getLocale()])
  if (!ctx) return null
  const result = await getDoaVersionForAdmin(ctx, versionId)
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound()
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{tVersions('title')}</h1>
        <Notice tone="danger">{tVersions('forbidden')}</Notice>
        <Link href="/" className={`${linkClass} self-start`}>
          {tVersions('homeLink')}
        </Link>
      </div>
    )
  }
  const view = result.data
  const v = view.version
  const look = versionLook(v)
  const name = tVersions('versionName', { code: v.code, version: v.versionNo })
  const when = (iso: string) => formatDateTime(locale, iso)
  const person = (p: { nameTh: string; nameEn: string | null }) => nameIn(locale, p)
  const money = (satang: string) => formatSatang(BigInt(satang))

  const documentType = (d: string) => ((DOCUMENT_TYPES as readonly string[]).includes(d) ? tVersions(`documentTypes.${d as (typeof DOCUMENT_TYPES)[number]}`) : d)
  const band = (rule: Pick<RuleView, 'band'>) => {
    const b = bandText(rule.band)
    return tVersions(`band.${b.key}`, b.values)
  }
  const approver = (rule: RuleView) =>
    rule.steps
      .map((s) => {
        const a = s.approver
        if (a.kind === 'MEMBER') return t('approver.MEMBER', { name: person(a.member) })
        const position = a.positionNameTh ? `${nameIn(locale, { nameTh: a.positionNameTh, nameEn: a.positionNameEn })} (${a.position})` : a.position
        return t(`approver.${a.kind}`, { position })
      })
      .join(', ')
  const sla = (rule: RuleView) =>
    rule.steps
      .map((s) => (s.slaMinutes % MINUTES_PER_HOUR === 0 ? t('sla', { hours: s.slaMinutes / MINUTES_PER_HOUR }) : t('slaMinutes', { minutes: s.slaMinutes })))
      .join(', ')
  const lowerCell = (rule: RuleView) => {
    if (!rule.band) return null
    if (rule.band.gte !== undefined) return t('atLeast', { amount: money(rule.band.gte) })
    return money(rule.band.gt ?? '0')
  }
  const upperCell = (rule: RuleView) => (rule.band?.lte !== undefined ? money(rule.band.lte) : t('noLimit'))

  const policyText = (field: PolicyField, value: PolicyValue) => {
    if (value === null) return t('policy.none')
    if (field === 'stepUpThreshold') return t('policy.amount', { amount: money(String(value)) })
    if (field === 'amountBasis' || field === 'selfApprovalPolicy') return t(`policy.${String(value) as 'GROSS' | 'NET' | 'ESCALATE_NEXT_BAND' | 'BLOCK'}`)
    if (field === 'collapseDuplicateApprovers') return value ? t('policy.on') : t('policy.off')
    return value ? t('policy.yes') : t('policy.no')
  }

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
  const previousName = view.previous ? tVersions('versionName', { code: v.code, version: view.previous.versionNo }) : ''
  const ruleOf = (rules: readonly RuleView[], code: string) => rules.find((r) => r.code === code)
  const diffEmpty = view.diff !== null && view.diff.policy.length === 0 && view.diff.added.length === 0 && view.diff.removed.length === 0 && view.diff.changed.length === 0
  const ruleLine = (r: RuleView) => t('ruleLine', { documentType: documentType(r.documentType), band: band(r), approver: approver(r) })

  const submit = view.submit
  const waiting = (view.route?.tasks ?? []).filter((task) => task.status === 'OPEN' || task.status === 'INFO_REQUESTED').map((task) => person(task.assignee))
  const blocked = submit?.mode === 'NORMAL' && (submit.effectiveInPast || submit.laterVersionScheduled !== null || submit.errors.length > 0 || !submit.allowed)
  const initial = submit?.mode === 'INITIAL' ? submit : null

  return (
    <div className="flex flex-col gap-8">
      <Link href="/admin/doa" className={`${linkClass} self-start`}>
        {t('back')}
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <h1 className="text-2xl font-semibold">{name}</h1>
          <VersionStatus look={look} label={tVersions(`status.${look}`)} />
        </div>
        <p className="tabular">
          {v.status === 'PUBLISHED' || v.status === 'SUPERSEDED'
            ? v.effectiveTo
              ? tVersions('period', { from: when(v.effectiveFrom), to: when(v.effectiveTo) })
              : tVersions('periodOpen', { from: when(v.effectiveFrom) })
            : tVersions('planned', { from: when(v.effectiveFrom) })}
        </p>
      </div>

      {initial ? (
        <div className="max-w-4xl border-t border-line pt-6">
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
                submit={submitInitialPackageAction}
              />
            )}
          </Section>
        </div>
      ) : null}

      <div className="flex flex-col gap-10 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-10">
        <aside aria-label={t('asideLabel')} className="flex flex-col gap-6 lg:col-start-2 lg:row-start-1">
          <dl className="flex flex-col gap-2 border-y border-line py-4">
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
          <a href={`/admin/doa/${v.id}/export`} download className={`${linkClass} self-start`}>
            {tVersions('download', { name })}
          </a>

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
          ) : submit.mode === 'NORMAL' ? (
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
                    <p className="text-ink-muted">{t('openTasks', { count: submit.openTasksUnderCurrent, name: tVersions('versionName', { code: submit.current.code, version: submit.current.versionNo }) })}</p>
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
                  submit={submitDoaAction}
                />
              )}
            </Section>
          ) : null}
        </aside>

        <div className="flex min-w-0 flex-col gap-10 lg:col-start-1 lg:row-start-1">
          <Section id="diff" title={view.previous ? t('diffTitle', { name: previousName }) : t('diffTitleFirst')}>
            {view.previous === null || view.diff === null ? (
              <p className="text-ink-muted">{t('diffFirst', { code: v.code })}</p>
            ) : diffEmpty ? (
              <p className="text-ink-muted">{t('diffNone', { name: previousName })}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line border-y border-line">
                {view.diff.policy.map((p) => (
                  <li key={`policy-${p.field}`} className="flex flex-col gap-0.5 py-3">
                    <p className="font-medium">{t('diffPolicy', { field: t(`policy.${p.field}`) })}</p>
                    <p className="text-ink-muted">{t('beforeAfter', { before: policyText(p.field, p.before), after: policyText(p.field, p.after) })}</p>
                  </li>
                ))}
                {view.diff.changed.map((c) => {
                  const before = ruleOf(view.previous!.rules, c.code)
                  const after = ruleOf(view.rules, c.code)
                  return (
                    <li key={`changed-${c.code}`} className="flex flex-col gap-0.5 py-3">
                      <p className="font-medium">{t('diffChanged', { rule: c.code })}</p>
                      {before && after
                        ? c.fields.map((f) => (
                            <p key={f} className="text-ink-muted">
                              {t('diffField', {
                                field: t(`ruleFields.${f}`),
                                change: t('beforeAfter', {
                                  before: f === 'band' ? band(before) : f === 'approver' ? approver(before) : f === 'sla' ? sla(before) : f === 'priority' ? String(before.priority) : documentType(before.documentType),
                                  after: f === 'band' ? band(after) : f === 'approver' ? approver(after) : f === 'sla' ? sla(after) : f === 'priority' ? String(after.priority) : documentType(after.documentType),
                                }),
                              })}
                            </p>
                          ))
                        : null}
                    </li>
                  )
                })}
                {view.diff.added.map((code) => {
                  const r = ruleOf(view.rules, code)
                  return (
                    <li key={`added-${code}`} className="flex flex-col gap-0.5 py-3">
                      <p className="font-medium">{t('diffAdded', { rule: code })}</p>
                      {r ? <p className="text-ink-muted">{ruleLine(r)}</p> : null}
                    </li>
                  )
                })}
                {view.diff.removed.map((code) => {
                  const r = ruleOf(view.previous!.rules, code)
                  return (
                    <li key={`removed-${code}`} className="flex flex-col gap-0.5 py-3">
                      <p className="font-medium">{t('diffRemoved', { rule: code })}</p>
                      {r ? <p className="text-ink-muted">{ruleLine(r)}</p> : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          <Section id="rules" title={t('rulesTitle', { count: view.rules.length })}>
            {rulesByType.map((group) => (
              <div key={group.documentType} className="flex flex-col gap-1">
                <h3 className="text-lg font-semibold">{documentType(group.documentType)}</h3>
                <div className={`hidden border-b border-line pb-2 text-sm font-medium text-ink-muted md:grid md:gap-x-4 ${RULE_GRID}`} aria-hidden="true">
                  <span>{t('ruleHeaders.rule')}</span>
                  <span className="text-right">{t('ruleHeaders.above')}</span>
                  <span className="text-right">{t('ruleHeaders.upTo')}</span>
                  <span>{t('ruleHeaders.approverSla')}</span>
                </div>
                <ul className="flex flex-col divide-y divide-line border-b border-line">
                  {group.rules.map((r) => (
                    <li key={r.code} className={`grid grid-cols-1 gap-1 py-3 md:items-baseline md:gap-x-4 ${RULE_GRID}`}>
                      <p className="font-semibold">
                        <span className="md:sr-only">{t('ruleHeaders.rule')} </span>
                        {r.code}
                      </p>
                      {r.band ? (
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
                        <span>{approver(r)}</span>
                        <span className="text-base text-ink-muted md:text-sm">
                          <span className="md:sr-only">{t('ruleHeaders.sla')} </span>
                          {sla(r)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Section>

          {view.boundaries.length ? (
            <Section id="boundaries" title={t('boundaryTitle')}>
              <p className="text-ink-muted">{t('boundaryIntro')}</p>
              {view.boundaries.map((b) => (
                <div key={b.documentType} className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold">{documentType(b.documentType)}</h3>
                  <ul className="flex max-w-md flex-col divide-y divide-line border-y border-line">
                    {b.rows.map((row) => (
                      <li key={row.amount} className="grid grid-cols-[minmax(0,11rem)_1fr] gap-x-6 py-2">
                        <span className="money">{t('boundaryAmount', { amount: money(row.amount) })}</span>
                        <span>{row.ruleCode ? t('boundaryRule', { rule: row.ruleCode }) : t('boundaryNone')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Section>
          ) : null}

          <Section id="policy" title={t('policyTitle')}>
            <dl className="grid gap-x-6 gap-y-2 border-y border-line py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              {(Object.keys(view.policy) as PolicyField[]).map((field) => (
                <div key={field} className="contents">
                  <dt className="text-ink-muted">{t(`policy.${field}`)}</dt>
                  <dd className={field === 'stepUpThreshold' ? 'money font-medium' : 'font-medium'}>{policyText(field, view.policy[field])}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  )
}
