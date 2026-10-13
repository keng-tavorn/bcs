import { getTranslations } from 'next-intl/server'
import type { MemberRefDto, NameDto } from '@/server/queries/requests'
import type { DoaVersionContentDto, PolicySubjectDto, TaskViewDto } from '@/server/queries/tasks'
import { amountBasisChange, authorityChanges, boundaryComparison, type BoundarySide } from '@/server/services/doa/compare'
import { diffVersions, type PolicyField, type PolicyValue, type RuleField } from '@/server/services/doa/diff'
import type { ApproverView, BoundarySideView, BoundaryTableView, CompareView, RuleView } from '@/server/services/doa/view'
import { DoaRef } from '@/ui/request-view/doa-ref'
import { Facts, Section, type Fact } from '@/ui/request-view/facts'
import { Notice } from '@/ui/form/notice'
import type { BoundaryTick } from '@/ui/tasks/policy-decision'
import { AuthorityList, BoundaryCompare, type Baseline } from '../admin/doa/_parts/sections'
import { doaWords as adminDoaWords, type DoaT } from '../admin/doa/_parts/words'
import { doaHref, doaRefText, memberName, money, nameIn, routeSentence, when, type Locale } from './present'
import { WithdrawalNotice } from './withdrawal-notice'

// What a policy task asks the approver to approve (BR-DOA-15, FR-DOA-010 AC1–AC2, FR-DOA-002 AC2, BR-DOA-13): the
// change as one sentence with names, who proposed it and when it takes effect, the reason, and who gains or loses
// authority — or, for a DOA version, what differs from the version it is compared with (the same comparison as the
// version history, FR-DOA-001 AC3), the positions that gain or lose authority and the boundary table the approver ticks
// before approving (FR-DOA-009 AC1, AC3: the drafter's page shows the same, with the same renderers), every rule and the
// policy it publishes, and the tasks still running under the version in effect. The version it is compared with is the
// one the drafter's page, the send and the approval read (src/server/queries/tasks.ts baselineOf). The approver reads
// it all here: they are the task's decider, and the admin pages are for ORG_ADMIN only.

type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>
// The engine's shapes, as the query hands them over (screens import core only for formatting, §4.10)
type DoaRuleSnapshot = DoaVersionContentDto['rules'][number]
type DoaStepSpec = DoaRuleSnapshot['steps'][number]
type ApproverSpec = Extract<DoaStepSpec, { approver: unknown }>['approver']
/** A committee step (S6 · FR-WF-102) */
type CommitteeStep = Extract<DoaStepSpec, { approvers: unknown }>
const isCommittee = (s: DoaStepSpec): s is CommitteeStep => 'approvers' in s
type AmountCondition = NonNullable<DoaRuleSnapshot['when']['amount']>
type DoaDocumentType = DoaRuleSnapshot['documentType']
type DoaPolicy = Extract<PolicySubjectDto, { kind: 'DOA_VERSION' }>

/** The section of the decision page that holds the boundary table, which the approver's tick links to (FR-DOA-009 AC3) */
export const DOA_BOUNDARY_SECTION = 'doa-boundaries'

/** The change as one sentence, e.g. "แต่งตั้ง สมหญิง รักงาน เป็นผู้จัดการฝ่าย ฝ่ายก่อสร้าง" */
export function policyHeadline(t: TasksT, locale: Locale, policy: PolicySubjectDto): string {
  if (policy.kind === 'DOA_VERSION') return t(policy.withdrawal ? 'policy.doaWithdrawalHeadline' : 'policy.doaHeadline', { code: policy.code, version: policy.versionNo })
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

/**
 * A DOA version beside the version it is compared with, by the functions the drafter's page and the services use
 * (src/server/services/doa/compare.ts): who gains or loses authority, the two amount bases when they differ, and the
 * boundary table — of both versions, or of this version alone when it is an organization's first. null when a stored
 * rule of either version cannot be read.
 */
export function doaComparison(policy: DoaPolicy) {
  const content = policy.content
  // The query reads the baseline's content only when there is a baseline
  const before = policy.baselineContent
  if (!content || (policy.baseline !== null && before === null)) return null
  return {
    authority: before ? authorityChanges(before, content) : [],
    basis: before ? amountBasisChange(before, content) : null,
    boundaries: boundaryComparison(before, content),
  }
}

/**
 * The boundary table on the decision page of a DOA version that has one, else null: the approve form then asks for the
 * tick before the code (FR-DOA-009 AC3), as the service asks for it before it approves, and sends it with the version
 * the table compares with (null: the version's own table), so the service approves only the table that was ticked.
 */
export function boundaryTickOf(task: TaskViewDto): BoundaryTick | null {
  if (task.policy?.kind !== 'DOA_VERSION') return null
  // A withdrawal publishes nothing: there is no table to tick (the service reads no tick for it)
  if (task.policy.withdrawal) return null
  if ((doaComparison(task.policy)?.boundaries.length ?? 0) === 0) return null
  return { tableId: DOA_BOUNDARY_SECTION, baselineId: task.policy.baseline?.versionId ?? null }
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
  /** One approver, or a committee with its quorum: "คณะกรรมการ COO, CFO ต้องได้ 2 เสียง" */
  const who = (s: DoaStepSpec): string => {
    if (!isCommittee(s)) return approver(s.approver)
    const approvers = s.approvers.map(approver).join(', ')
    return s.quorum === 'COUNT' ? t('policy.doaCommittee.COUNT', { approvers, count: s.quorumCount ?? s.approvers.length }) : t(`policy.doaCommittee.${s.quorum}`, { approvers })
  }
  const step = (s: DoaStepSpec) => t('policy.doaRuleStep', { approver: who(s), sla: sla(s.slaBusinessMinutes) })
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
        return rule.steps.map(who).join(', ')
      case 'sla':
        return rule.steps.map((s) => sla(s.slaBusinessMinutes)).join(', ')
    }
  }
  return { documentType, band, step, policyValue, ruleField }
}

const POLICY_ORDER: readonly PolicyField[] = ['amountBasis', 'selfApprovalPolicy', 'collapseDuplicateApprovers', 'stepUpThreshold', 'approverMayReceive', 'requesterMayReceive', 'doaAdminSeparated']

function policyValues(c: DoaVersionContentDto): Record<PolicyField, PolicyValue> {
  return {
    amountBasis: c.amountBasis,
    selfApprovalPolicy: c.selfApprovalPolicy,
    collapseDuplicateApprovers: c.collapseDuplicateApprovers,
    stepUpThreshold: c.stepUpThresholdSatang === null ? null : c.stepUpThresholdSatang.toString(),
    approverMayReceive: c.sodPolicy.approverMayReceive,
    requesterMayReceive: c.sodPolicy.requesterMayReceive,
    doaAdminSeparated: c.sodPolicy.doaAdminSeparated === true,
  }
}

/**
 * The comparison in the shapes the renderers of the drafter's page take (src/server/services/doa/view.ts): approvers
 * with the names of their positions or people (a person the page cannot name reads as `unknown`), money as satang text.
 */
function comparisonViews(policy: DoaPolicy, comparison: NonNullable<ReturnType<typeof doaComparison>>, unknown: string) {
  const approver = (a: ApproverSpec): ApproverView => {
    if (a.kind === 'MEMBER') {
      const m = policy.memberNames.get(a.memberId)
      return { kind: 'MEMBER', member: { id: a.memberId, nameTh: m?.name.th ?? unknown, nameEn: m?.name.en ?? null } }
    }
    const p = policy.positionNames.get(a.position)
    return { kind: a.kind, position: a.position, positionNameTh: p?.th ?? null, positionNameEn: p?.en ?? null }
  }
  const side = (s: BoundarySide): BoundarySideView => ({ ruleCode: s.ruleCode, approvers: s.approvers.map(approver) })
  const boundaries: BoundaryTableView[] = comparison.boundaries.map((table) => ({
    documentType: table.documentType,
    rows: table.rows.map((r) => ({ amount: r.amount, before: r.before ? side(r.before) : null, after: side(r.after), changed: r.changed })),
  }))
  const ruleView = (r: DoaRuleSnapshot): RuleView => {
    const amount = r.when.amount
    return {
      code: r.code,
      documentType: r.documentType,
      priority: r.priority,
      band: amount
        ? {
            ...(amount.gt !== undefined ? { gt: amount.gt.toString() } : {}),
            ...(amount.gte !== undefined ? { gte: amount.gte.toString() } : {}),
            ...(amount.lte !== undefined ? { lte: amount.lte.toString() } : {}),
          }
        : null,
      steps: r.steps.map((s) =>
        isCommittee(s)
          ? { approver: approver(s.approvers[0]!), slaMinutes: s.slaBusinessMinutes, committee: { quorum: s.quorum, quorumCount: s.quorumCount ?? null, approvers: s.approvers.map(approver) } }
          : { approver: approver(s.approver), slaMinutes: s.slaBusinessMinutes },
      ),
    }
  }
  const baseline = policy.baseline
  const before = policy.baselineContent
  const compare: CompareView | null =
    baseline && before && policy.content
      ? {
          baseline: {
            id: baseline.versionId,
            code: baseline.code,
            versionNo: baseline.versionNo,
            inEffectNow: baseline.relation === 'IN_EFFECT',
            effectiveFrom: baseline.effectiveFrom.toISOString(),
            policy: policyValues(before),
            rules: before.rules.map(ruleView),
          },
          diff: diffVersions(before, policy.content),
          authority: comparison.authority.map((c) => ({ change: c.change, approver: approver(c.approver), documentType: c.documentType, band: c.band })),
          boundaries,
          basis: comparison.basis,
        }
      : null
  return { compare, boundaries }
}

const tagClass = 'rounded-sm border border-line px-1.5 text-base font-normal text-ink md:text-sm'

/**
 * The diff with the version it is compared with, who gains or loses authority and the boundary table the approver
 * ticks, then the rules and the policy the version publishes. `simulate`: the reader may open the try-out of this
 * version, which those renderers offer beside a change of amount basis.
 */
function DoaVersionContent({ policy, t, tAdmin, locale, simulate }: { policy: DoaPolicy; t: TasksT; tAdmin: DoaT; locale: Locale; simulate: boolean }) {
  const content = policy.content
  const comparison = doaComparison(policy)
  if (!content || !comparison) return <Notice tone="warning">{t('policy.doaUnreadable')}</Notice>
  const words = doaWords(t, locale, { positions: policy.positionNames, members: policy.memberNames })
  // The authority list and the boundary table go through the renderers of the drafter's page, so both read the same
  const views = comparisonViews(policy, comparison, t('policy.unknown'))
  const baseline = policy.baseline
  const baselineName = baseline ? t('policy.doaVersionRef', { code: baseline.code, version: baseline.versionNo }) : ''
  const diff = views.compare?.diff ?? null
  const changedCodes = new Map((diff?.changed ?? []).map((c) => [c.code, c.fields]))
  const added = new Set(diff?.added ?? [])
  const beforeRules = new Map((policy.baselineContent?.rules ?? []).map((r) => [r.code, r]))
  const differs = diff ? diff.policy.length + diff.added.length + diff.removed.length + diff.changed.length > 0 : false
  const values = policyValues(content)
  const diffTitle = !baseline
    ? t('policy.doaDiffTitleFirst')
    : baseline.relation === 'IN_EFFECT'
      ? t('policy.doaDiffTitle', { name: baselineName })
      : baseline.relation === 'NEXT'
        ? t('policy.doaDiffTitleNext', { name: baselineName })
        : t('policy.doaDiffTitleReplaced', { name: baselineName })

  const adminWords = adminDoaWords(tAdmin, locale)
  // The version it is compared with, as those renderers name it: in effect now, or before this one — approved for
  // later, or replaced since (in the past tense)
  const sectionsBaseline: Baseline | null = baseline
    ? { name: adminWords.versionName(baseline), next: baseline.relation !== 'IN_EFFECT', replaced: baseline.relation === 'REPLACED' }
    : null
  // The try-out of this version is an ORG_ADMIN page (admin.doa.simulate): offered only to a reader who may open it,
  // never as a link that ends in a refusal
  const simulateHref = simulate ? `/admin/doa/${policy.versionId}/simulate` : null
  const authorityShown = Boolean(views.compare && sectionsBaseline)
  // Those renderers close their lists with a rule: the section that follows one starts without a rule of its own
  const afterRule = 'border-t-0 pt-0'

  return (
    <>
      <Section id="doa-diff" title={diffTitle}>
        {baseline?.relation === 'NEXT' ? <p className="text-base text-ink-muted md:text-sm">{t('policy.doaDiffNextNote', { name: baselineName, time: when(locale, baseline.effectiveFrom) })}</p> : null}
        {!diff ? (
          <p className="text-ink">{t('policy.doaDiffFirst')}</p>
        ) : !differs ? (
          <p className="text-ink">{t('policy.doaDiffNone', { name: baselineName })}</p>
        ) : (
          <ul aria-label={t('policy.doaDiffLabel')} className="flex flex-col divide-y divide-line border-t border-line">
            {diff.policy.map((p) => (
              <li key={`policy-${p.field}`} className="flex flex-col gap-0.5 py-2.5">
                <span className="font-medium text-ink">{t('policy.doaDiffPolicy', { field: t(`policy.doaPolicy.${p.field}`) })}</span>
                <span className="text-ink">{t('policy.doaDiffValues', { before: words.policyValue(p.field, p.before), after: words.policyValue(p.field, p.after) })}</span>
              </li>
            ))}
            {diff.changed.map((c) => {
              const old = beforeRules.get(c.code)
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
              const rule = beforeRules.get(code)
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

      {views.compare && sectionsBaseline ? (
        <Section id="doa-authority" title={tAdmin('detail.authorityTitle')}>
          <AuthorityList compare={views.compare} baseline={sectionsBaseline} simulateHref={simulateHref} t={tAdmin} words={adminWords} />
        </Section>
      ) : null}

      {views.boundaries.length ? (
        <Section id={DOA_BOUNDARY_SECTION} title={tAdmin('detail.boundaryTitle')} className={authorityShown ? afterRule : undefined}>
          <BoundaryCompare tables={views.boundaries} baseline={sectionsBaseline} basis={comparison.basis} simulateHref={simulateHref} t={tAdmin} words={adminWords} />
        </Section>
      ) : null}

      <Section id="doa-rules" title={t('policy.doaRulesTitle', { count: content.rules.length })} className={authorityShown || views.boundaries.length > 0 ? afterRule : undefined}>
        {/* Each rule beside its band where the list is 36rem wide or more (its own container, not the screen): in the
            workspace's column, never in the one column of a LIFF page, which stacks them at every screen width (§9.9) */}
        <ul aria-label={t('policy.doaRulesLabel', { name: t('policy.doaVersionRef', { code: content.code, version: content.versionNo }) })} className="@container flex flex-col divide-y divide-line border-t border-line">
          {content.rules.map((rule) => {
            const fields = changedCodes.get(rule.code)
            return (
              <li key={rule.code} className="flex flex-col gap-1 py-2.5 @min-[36rem]:flex-row @min-[36rem]:items-start @min-[36rem]:justify-between @min-[36rem]:gap-6">
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
                <span className="tabular shrink-0 text-ink @min-[36rem]:text-right">{words.band(rule.when.amount)}</span>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section id="doa-policy" title={t('policy.doaPolicyTitle')}>
        <Facts columns={2} items={POLICY_ORDER.map((field) => ({ label: t(`policy.doaPolicy.${field}`), value: <span className="tabular">{words.policyValue(field, values[field])}</span> }))} />
      </Section>
    </>
  )
}

/**
 * `doaLinks`: the reader may open DOA versions on the admin pages; `doaSimulate`: the reader may open the try-out of a
 * DOA version; `orgAuthorityLink`: the reader may open the list of authority changes. Without them the page shows the
 * references as text and leaves the admin links out.
 */
export async function PolicySubject({
  task,
  locale,
  doaLinks,
  doaSimulate,
  orgAuthorityLink,
}: {
  task: TaskViewDto
  locale: Locale
  doaLinks: boolean
  doaSimulate: boolean
  orgAuthorityLink: boolean
}) {
  const [t, tv, tl, tAdmin] = await Promise.all([getTranslations('tasks'), getTranslations('requestView'), getTranslations('timeline'), getTranslations('adminDoa')])
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
        {policy.kind === 'DOA_VERSION' && policy.withdrawal ? (
          <WithdrawalNotice withdrawal={policy.withdrawal} version={t('policy.doaVersionRef', { code: policy.code, version: policy.versionNo })} effectiveFrom={policy.effectiveFrom} locale={locale} />
        ) : null}
        <Facts columns={2} items={facts} />
        {/* What publishing would leave running under the version in effect (BR-DOA-13): only while it waits for approval */}
        {policy.kind === 'DOA_VERSION' && policy.status === 'PENDING_APPROVAL' && policy.openTasksUnderCurrent > 0 ? <p className="text-ink">{t('policy.doaOpenTasks', { count: policy.openTasksUnderCurrent })}</p> : null}
        {policy.kind === 'DOA_VERSION' && policy.holders.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold text-ink">{t('policy.doaHolders')}</h3>
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

      {policy.kind === 'DOA_VERSION' ? <DoaVersionContent policy={policy} t={t} tAdmin={tAdmin} locale={locale} simulate={doaSimulate} /> : null}

      {task.route ? (
        <Section id="route" title={tv('route.title')}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-ink-muted">{tv('route.rule')}</span>
            <DoaRef label={doaRefText(tl, task.route.doa)} href={doaLinks ? doaHref(task.route.doa.versionId) : null} />
          </p>
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold text-ink">{tv('route.why')}</h3>
            <p className="break-words text-ink">{routeSentence(tv, tl, locale, task.route, task.subjectType)}</p>
          </div>
        </Section>
      ) : null}
    </div>
  )
}
