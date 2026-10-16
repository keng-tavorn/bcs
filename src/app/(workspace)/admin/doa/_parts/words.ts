import type { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import type { PolicyField, PolicyValue } from '@/server/services/doa/diff'
import type { ApproverView, RuleView } from '@/server/services/doa/view'
import { bandText } from '@/ui/admin-doa/band'
import { DOC_TYPES as DOCUMENT_TYPES, type DocType } from '@/ui/admin-doa/editor-model'
import { nameIn } from '@/ui/admin-org/names'

// Words for the DOA pages in the reader's language: document types, amount bands, approvers, times under the SLA and
// policy values (§9.9: money with thousands separators and two decimals). Names are data: English when the screen is
// in English and the name has one, Thai otherwise.

export type DoaT = Awaited<ReturnType<typeof getTranslations<'adminDoa'>>>

export { DOCUMENT_TYPES }
type DocumentType = DocType
const MINUTES_PER_HOUR = 60

export function doaWords(t: DoaT, locale: string) {
  const person = (p: { nameTh: string; nameEn: string | null }) => nameIn(locale, p)
  const money = (satang: string) => formatSatang(BigInt(satang))
  const documentType = (d: string) => ((DOCUMENT_TYPES as readonly string[]).includes(d) ? t(`documentTypes.${d as DocumentType}`) : d)
  const band = (b: RuleView['band'] | { readonly gt?: string | null; readonly gte?: string | null; readonly lte?: string | null } | null) => {
    const words = bandText(b)
    return t(`band.${words.key}`, words.values)
  }
  const approver = (a: ApproverView) => {
    if (a.kind === 'MEMBER') return t('detail.approver.MEMBER', { name: person(a.member) })
    const position = a.positionNameTh ? `${nameIn(locale, { nameTh: a.positionNameTh, nameEn: a.positionNameEn })} (${a.position})` : a.position
    return t(`detail.approver.${a.kind}`, { position })
  }
  /** The approver without where it is looked for, where space is short (the boundary table): "ผู้จัดการฝ่าย (DM)" */
  const approverShort = (a: ApproverView) => {
    if (a.kind === 'MEMBER') return t('detail.approver.MEMBER', { name: person(a.member) })
    return a.positionNameTh ? `${nameIn(locale, { nameTh: a.positionNameTh, nameEn: a.positionNameEn })} (${a.position})` : a.position
  }
  /** One approver, or a committee with its quorum (S6 · FR-WF-102): "คณะกรรมการ COO (COO), CFO (CFO) ต้องได้ 2 เสียง" */
  const stepApprover = (s: RuleView['steps'][number]) => {
    const c = s.committee
    if (!c) return approver(s.approver)
    const approvers = c.approvers.map(approverShort).join(', ')
    return c.quorum === 'COUNT' ? t('detail.committee.COUNT', { approvers, count: c.quorumCount ?? c.approvers.length }) : t(`detail.committee.${c.quorum}`, { approvers })
  }
  const rulesApprover = (rule: RuleView) => rule.steps.map(stepApprover).join(', ')
  const sla = (minutes: number) => (minutes % MINUTES_PER_HOUR === 0 ? t('detail.sla', { hours: minutes / MINUTES_PER_HOUR }) : t('detail.slaMinutes', { minutes }))
  const rulesSla = (rule: RuleView) => rule.steps.map((s) => sla(s.slaMinutes)).join(', ')
  const policyText = (field: PolicyField, value: PolicyValue) => {
    if (value === null) return t('detail.policy.none')
    if (field === 'stepUpThreshold') return t('detail.policy.amount', { amount: money(String(value)) })
    if (field === 'amountBasis' || field === 'selfApprovalPolicy') return t(`detail.policy.${String(value) as 'GROSS' | 'NET' | 'ESCALATE_NEXT_BAND' | 'BLOCK'}`)
    if (field === 'collapseDuplicateApprovers') return value ? t('detail.policy.on') : t('detail.policy.off')
    return value ? t('detail.policy.yes') : t('detail.policy.no')
  }
  const versionName = (v: { code: string; versionNo: number }) => t('versionName', { code: v.code, version: v.versionNo })
  return { person, money, documentType, band, approver, approverShort, rulesApprover, sla, rulesSla, policyText, versionName }
}

export type DoaWords = ReturnType<typeof doaWords>
