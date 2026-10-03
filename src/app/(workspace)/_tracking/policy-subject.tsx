import { getTranslations } from 'next-intl/server'
import type { MemberRefDto, NameDto } from '@/server/queries/requests'
import type { DoaVersionContentDto, PolicySubjectDto, TaskViewDto } from '@/server/queries/tasks'
import { diffVersions, type PolicyField, type PolicyValue, type RuleField } from '@/server/services/doa/diff'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Facts, Section, type Fact } from '@/ui/request-view/facts'
import { Notice } from '@/ui/form/notice'
import { doaHref, doaRefText, memberName, money, nameIn, routeSentence, when, type Locale } from './present'

// What a policy task asks the approver to approve (BR-DOA-15, FR-DOA-010 AC1–AC2, FR-DOA-002 AC2, BR-DOA-13): the
// change as one sentence with names, who proposed it and when it takes effect, the reason, and who gains or loses
// authority — or, for a DOA version, every rule and the policy it publishes, what differs from the version in effect
// (the same comparison as the version history, FR-DOA-001 AC3), and the tasks still running under that one. The
// approver reads it all here: they are the task's decider, and the admin pages are for ORG_ADMIN only.

type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>
// The engine's shapes, as the query hands them over (screens import core only for formatting, §4.10)
type DoaRuleSnapshot = DoaVersionContentDto['rules'][number]
type DoaStepSpec = DoaRuleSnapshot['steps'][number]
type ApproverSpec = DoaStepSpec['approver']
type AmountCondition = NonNullable<DoaRuleSnapshot['when']['amount']>
type DoaDocumentType = DoaRuleSnapshot['documentType']

/** The change as one sentence, e.g. "แต่งตั้ง สมหญิง รักงาน เป็นผู้จัดการฝ่าย ฝ่ายก่อสร้าง" */
export function policyHeadline(t: TasksT, locale: Locale, policy: PolicySubjectDto): string {
  if (policy.kind === 'DOA_VERSION') return t('policy.doaHeadline', { code: policy.code, version: policy.versionNo })
  const d = policy.details
  const unknown = t('policy.unknown')
  const member = (m: { name: { th: string; en: string | null } } | null) => (m ? nameIn(locale, m.name) : unknown)
  const department = (dep: { name: { th: string; en: string | null } } | null) => (dep ? nameIn(locale, dep.name) : unknown)
  if (!d) return t('item.change', { kind: t(`changeKind.${policy.changeKind}`) })
  switch (d.kind) {
    case 'POSITION_ASSIGN':
      return t('policy.change.POSITION_ASSIGN', { member: member(d.member), position: d.position.name ? nameIn(locale, d.position.name) : d.position.code, department: department(d.department) })
    case 'POSITION_END':
      return d.replacement
        ? t('policy.change.POSITION_END_REPLACED', { member: member(d.replacement), position: d.position.name ? nameIn(locale, d.position.name) : d.position.code, department: department(d.department) })
        : t('policy.change.POSITION_END', { position: d.position.name ? nameIn(locale, d.position.name) : d.position.code, department: department(d.department) })
    case 'DEPARTMENT_REPARENT':
      return t('policy.change.DEPARTMENT_REPARENT', { department: department(d.department), from: department(d.currentParent), to: department(d.newParent) })
    case 'DELEGATION_ON_BEHALF':
      return t('policy.change.DELEGATION_ON_BEHALF', {
        delegate: member(d.delegate),
        delegator: member(d.delegator),
        start: d.startsAt ? when(locale, d.startsAt) : unknown,
        end: d.endsAt ? when(locale, d.endsAt) : unknown,
      })
    case 'IDENTITY_RESET':
      return t('policy.change.IDENTITY_RESET', { member: member(d.member) })
  }
}

/** Words for the rules and the policy of a DOA version, in the reader's language */
function doaWords(t: TasksT, locale: Locale, names: { positions: ReadonlyMap<string, NameDto>; members: ReadonlyMap<string, MemberRefDto> }) {
  const documentType = (type: DoaDocumentType) => t(`policy.doaDocumentType.${type}`)
  /** BR-DOA-02: (lower, upper] or [lower, upper]; an exclusive lower bound of zero is no lower bound (as the admin pages say it) */
  const band = (amount: AmountCondition | undefined): string => {
    if (!amount) return t('policy.doaBand.any')
    const above = amount.gt !== undefined && amount.gt > 0n ? money(amount.gt) : null
    const from = amount.gte !== undefined ? money(amount.gte) : null
    const to = amount.lte !== undefined ? money(amount.lte) : null
    if (above && to) return t('policy.doaBand.range', { from: above, to })
    if (from && to) return t('policy.doaBand.fromTo', { from, to })
    if (to) return t('policy.doaBand.upTo', { to })
    if (above) return t('policy.doaBand.above', { from: above })
    if (from) return t('policy.doaBand.from', { from })
    return t('policy.doaBand.any')
  }
  const approver = (a: ApproverSpec): string => {
    if (a.kind === 'MEMBER') return t('policy.doaApprover.MEMBER', { name: memberName(locale, names.members.get(a.memberId)) || t('policy.unknown') })
    const name = names.positions.get(a.position)
    const position = name && nameIn(locale, name) !== a.position ? t('policy.doaApprover.position', { name: nameIn(locale, name), code: a.position }) : a.position
    return t(`policy.doaApprover.${a.kind}`, { position })
  }
  const sla = (minutes: number) => (minutes % 60 === 0 ? t('policy.doaSla', { hours: minutes / 60 }) : t('policy.doaSlaMinutes', { minutes }))
  const step = (s: DoaStepSpec) => t('policy.doaRuleStep', { approver: approver(s.approver), sla: sla(s.slaBusinessMinutes) })
  const policyValue = (field: PolicyField, value: PolicyValue): string => {
    if (value === null) return t('policy.doaValue.none')
    if (field === 'stepUpThreshold') return t('policy.doaValue.amount', { amount: money(BigInt(String(value))) })
    if (field === 'collapseDuplicateApprovers') return value ? t('policy.doaValue.on') : t('policy.doaValue.off')
    if (typeof value === 'boolean') return value ? t('policy.doaValue.yes') : t('policy.doaValue.no')
    return value === 'GROSS' || value === 'NET' || value === 'ESCALATE_NEXT_BAND' || value === 'BLOCK' ? t(`policy.doaValue.${value}`) : value
  }
  /** One field of a rule, before or after a change */
  const ruleField = (field: RuleField, rule: DoaRuleSnapshot): string => {
    switch (field) {
      case 'documentType':
        return documentType(rule.documentType)
      case 'priority':
        return String(rule.priority)
      case 'band':
        return band(rule.when.amount)
      case 'approver':
        return rule.steps.map((s) => approver(s.approver)).join(', ')
      case 'sla':
        return rule.steps.map((s) => sla(s.slaBusinessMinutes)).join(', ')
    }
  }
  return { documentType, band, step, policyValue, ruleField }
}

const POLICY_ORDER: readonly PolicyField[] = ['amountBasis', 'selfApprovalPolicy', 'collapseDuplicateApprovers', 'stepUpThreshold', 'approverMayReceive', 'requesterMayReceive']

function policyValues(c: DoaVersionContentDto): Record<PolicyField, PolicyValue> {
  return {
    amountBasis: c.amountBasis,
    selfApprovalPolicy: c.selfApprovalPolicy,
    collapseDuplicateApprovers: c.collapseDuplicateApprovers,
    stepUpThreshold: c.stepUpThresholdSatang === null ? null : c.stepUpThresholdSatang.toString(),
    approverMayReceive: c.sodPolicy.approverMayReceive,
    requesterMayReceive: c.sodPolicy.requesterMayReceive,
  }
}

const tagClass = 'rounded-sm border border-line px-1.5 text-base font-normal text-ink md:text-sm'

/** The rules and the policy a DOA version publishes, and what differs from the version in effect */
function DoaVersionContent({ policy, t, locale }: { policy: Extract<PolicySubjectDto, { kind: 'DOA_VERSION' }>; t: TasksT; locale: Locale }) {
  const content = policy.content
  if (!content) return <Notice tone="warning">{t('policy.doaUnreadable')}</Notice>
  const words = doaWords(t, locale, { positions: policy.positionNames, members: policy.memberNames })
  const current = policy.currentContent
  const currentName = policy.current ? t('policy.doaVersionRef', { code: policy.current.code, version: policy.current.versionNo }) : ''
  const diff = current ? diffVersions(current, content) : null
  const changedCodes = new Map((diff?.changed ?? []).map((c) => [c.code, c.fields]))
  const added = new Set(diff?.added ?? [])
  const before = new Map((current?.rules ?? []).map((r) => [r.code, r]))
  const differs = diff ? diff.policy.length + diff.added.length + diff.removed.length + diff.changed.length > 0 : false
  const values = policyValues(content)

  return (
    <>
      <Section id="doa-diff" title={current ? t('policy.doaDiffTitle', { name: currentName }) : t('policy.doaDiffTitleFirst')}>
        {!diff ? (
          <p className="text-ink">{t('policy.doaDiffFirst')}</p>
        ) : !differs ? (
          <p className="text-ink">{t('policy.doaDiffNone', { name: currentName })}</p>
        ) : (
          <ul aria-label={t('policy.doaDiffLabel')} className="flex flex-col divide-y divide-line border-t border-line">
            {diff.policy.map((p) => (
              <li key={`policy-${p.field}`} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-medium text-ink">{t('policy.doaDiffPolicy', { field: t(`policy.doaPolicy.${p.field}`) })}</span>
                <span className="text-ink">{t('policy.doaDiffValues', { before: words.policyValue(p.field, p.before), after: words.policyValue(p.field, p.after) })}</span>
              </li>
            ))}
            {diff.changed.map((c) => {
              const old = before.get(c.code)
              const now = content.rules.find((r) => r.code === c.code)
              return (
                <li key={`changed-${c.code}`} className="flex flex-col gap-0.5 py-2.5">
                  <span className="font-medium text-ink">{t('policy.doaDiffChanged', { rule: c.code })}</span>
                  {old && now
                    ? c.fields.map((field) => (
                        <span key={field} className="tabular text-ink">
                          {t('policy.doaDiffChange', { field: t(`policy.doaField.${field}`), before: words.ruleField(field, old), after: words.ruleField(field, now) })}
                        </span>
                      ))
                    : null}
                </li>
              )
            })}
            {diff.added.map((code) => {
              const rule = content.rules.find((r) => r.code === code)
              return (
                <li key={`added-${code}`} className="flex flex-col gap-0.5 py-2.5">
                  <span className="font-medium text-ink">{t('policy.doaDiffAdded', { rule: code })}</span>
                  {rule ? <span className="tabular text-ink">{t('policy.doaRuleLine', { documentType: words.documentType(rule.documentType), band: words.band(rule.when.amount), approver: rule.steps.map(words.step).join(', ') })}</span> : null}
                </li>
              )
            })}
            {diff.removed.map((code) => {
              const rule = before.get(code)
              return (
                <li key={`removed-${code}`} className="flex flex-col gap-0.5 py-2.5">
                  <span className="font-medium text-ink">{t('policy.doaDiffRemoved', { rule: code })}</span>
                  {rule ? <span className="tabular text-ink-muted">{t('policy.doaRuleLine', { documentType: words.documentType(rule.documentType), band: words.band(rule.when.amount), approver: rule.steps.map(words.step).join(', ') })}</span> : null}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <Section id="doa-rules" title={t('policy.doaRulesTitle', { count: content.rules.length })}>
        <ul aria-label={t('policy.doaRulesLabel', { name: t('policy.doaVersionRef', { code: content.code, version: content.versionNo }) })} className="flex flex-col divide-y divide-line border-t border-line">
          {content.rules.map((rule) => {
            const fields = changedCodes.get(rule.code)
            return (
              <li key={rule.code} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-ink">
                    <span>{t('policy.doaRuleTitle', { rule: rule.code, documentType: words.documentType(rule.documentType) })}</span>
                    {added.has(rule.code) ? <span className={tagClass}>{t('policy.doaRuleNew')}</span> : null}
                    {fields ? <span className={tagClass}>{t('policy.doaRuleChanged', { fields: fields.map((f) => t(`policy.doaField.${f}`)).join(', ') })}</span> : null}
                  </p>
                  {rule.steps.map((s, i) => (
                    <span key={i} className="break-words text-ink">
                      {rule.steps.length > 1 ? t('policy.doaRuleStepNo', { no: i + 1, step: words.step(s) }) : words.step(s)}
                    </span>
                  ))}
                </div>
                <span className="tabular shrink-0 text-ink sm:text-right">{words.band(rule.when.amount)}</span>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section id="doa-policy" title={t('policy.doaPolicyTitle')}>
        <Facts items={POLICY_ORDER.map((field) => ({ label: t(`policy.doaPolicy.${field}`), value: <span className="tabular">{words.policyValue(field, values[field])}</span> }))} />
      </Section>
    </>
  )
}

/**
 * `doaLinks`: the reader may open DOA versions on the admin pages; `orgAuthorityLink`: the reader may open the list of
 * authority changes. Without them the page shows the references as text and leaves the admin links out.
 */
export async function PolicySubject({ task, locale, doaLinks, orgAuthorityLink }: { task: TaskViewDto; locale: Locale; doaLinks: boolean; orgAuthorityLink: boolean }) {
  const [t, tv, tl] = await Promise.all([getTranslations('tasks'), getTranslations('requestView'), getTranslations('timeline')])
  const policy = task.policy
  if (!policy) return null
  const names = (list: ReadonlyArray<{ name: { th: string; en: string | null } }>) => (list.length ? list.map((m) => nameIn(locale, m.name)).join(', ') : t('policy.facts.none'))

  const facts: Fact[] =
    policy.kind === 'DOA_VERSION'
      ? [
          { label: t('policy.facts.proposedBy'), value: memberName(locale, policy.submittedBy) || t('policy.unknown') },
          ...(policy.submittedAt ? [{ label: t('policy.facts.proposedAt'), value: when(locale, policy.submittedAt) }] : []),
          { label: t('policy.doaEffective'), value: when(locale, policy.effectiveFrom) },
          { label: t('policy.doaRules'), value: t('policy.doaRuleCount', { count: policy.ruleCount }) },
          ...(policy.current ? [{ label: t('policy.doaCurrent'), value: t('policy.doaVersionRef', { code: policy.current.code, version: policy.current.versionNo }) }] : []),
          ...(policy.changeReason ? [{ label: t('policy.doaReason'), value: <span className="whitespace-pre-line">{policy.changeReason}</span> }] : []),
        ]
      : [
          { label: t('policy.facts.proposedBy'), value: memberName(locale, policy.submittedBy) || t('policy.unknown') },
          ...(policy.submittedAt ? [{ label: t('policy.facts.proposedAt'), value: when(locale, policy.submittedAt) }] : []),
          { label: t('policy.facts.effective'), value: when(locale, policy.effectiveFrom) },
          { label: t('policy.facts.reason'), value: <span className="whitespace-pre-line">{policy.reason}</span> },
          ...(policy.impact
            ? [
                { label: t('policy.facts.gains'), value: names(policy.impact.gains) },
                { label: t('policy.facts.loses'), value: names(policy.impact.loses) },
                { label: t('policy.facts.openTasks'), value: t('policy.facts.openTasksCount', { count: policy.impact.openTasks }) },
              ]
            : []),
        ]

  const adminLink =
    policy.kind === 'DOA_VERSION'
      ? doaLinks
        ? { href: doaHref(policy.versionId), text: t('policy.doaOpen') }
        : null
      : orgAuthorityLink
        ? { href: '/admin/org-authority', text: t('policy.openAdmin') }
        : null

  return (
    <div className="flex flex-col gap-6">
      <Section id="what" title={t('policy.whatTitle')}>
        <Facts items={facts} />
        {/* What publishing would leave running under the version in effect (BR-DOA-13): only while it waits for approval */}
        {policy.kind === 'DOA_VERSION' && policy.status === 'PENDING_APPROVAL' && policy.openTasksUnderCurrent > 0 ? <p className="text-ink">{t('policy.doaOpenTasks', { count: policy.openTasksUnderCurrent })}</p> : null}
        {policy.kind === 'DOA_VERSION' && policy.holders.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-medium text-ink">{t('policy.doaHolders')}</h3>
            <ul className="flex flex-col divide-y divide-line border-t border-line">
              {policy.holders.map((h, i) => (
                <li key={`${h.position.code}-${i}`} className="py-2 text-ink">
                  {t('policy.doaHolder', {
                    member: h.member ? nameIn(locale, h.member.name) : t('policy.unknown'),
                    position: h.position.name ? nameIn(locale, h.position.name) : h.position.code,
                    department: h.department ? nameIn(locale, h.department.name) : '',
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {adminLink ? (
          <a href={adminLink.href} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {adminLink.text}
          </a>
        ) : null}
      </Section>

      {policy.kind === 'DOA_VERSION' ? <DoaVersionContent policy={policy} t={t} locale={locale} /> : null}

      {task.route ? (
        <Section id="route" title={tv('route.title')}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink-muted">{tv('route.rule')}</span>
            <DoaRef label={doaRefText(tl, task.route.doa)} href={doaLinks ? doaHref(task.route.doa.versionId) : null} />
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-ink">{tv('route.why')}</h3>
            <p className="break-words text-ink">{routeSentence(tv, tl, locale, task.route, task.subjectType)}</p>
          </div>
        </Section>
      ) : null}
    </div>
  )
}
