import { formatSatang } from '@/core/money/format'
import { bandOf } from './band'
import type { AmountBasis, DoaDocumentType, DoaRuleSnapshot, DoaVersionSnapshot, OrgSnapshot } from './types'

// The Thai explanation stored on every route (BR-DOA-10), e.g. "DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 45,000.00 บาท
// (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 → VP ของสายปฏิบัติการ". Screens in English build their
// own sentence from the structured route; this text is the record kept with the route.

const DOCUMENT_TH: Record<DoaDocumentType, string> = {
  PURCHASE_REQUEST: 'คำขอซื้อ',
  PURCHASE_ORDER: 'ใบสั่งซื้อ',
  GR_VARIANCE: 'ผลต่างจากการตรวจรับ',
  DOA_CHANGE: 'การเปลี่ยน DOA',
  ORG_AUTHORITY_CHANGE: 'การเปลี่ยนโครงสร้างอำนาจ',
}

const BASIS_TH: Record<AmountBasis, string> = { GROSS: 'รวม VAT', NET: 'ก่อน VAT' }

export function bandTextTh(rule: DoaRuleSnapshot): string | null {
  if (!rule.when.amount) return null
  const { lower, upper } = bandOf(rule.when.amount)
  const from = lower !== null && lower > 0n ? `มากกว่า ${formatSatang(lower)}` : null
  const to = upper !== null ? `ไม่เกิน ${formatSatang(upper)}` : null
  if (from && to) return `อยู่ในช่วง${from} ถึง${to}`
  if (from) return `อยู่ในช่วง${from}`
  if (to) return `อยู่ในช่วง${to}`
  return null
}

export interface ExplainedStep {
  readonly resolvedFrom: string
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
}

function approverTh(step: ExplainedStep, org: OrgSnapshot): string {
  const name = (id: string) => org.members.find((m) => m.id === id)?.displayNameTh ?? id
  const position = /^POSITION:([^@]+)@(.+)$/.exec(step.resolvedFrom)
  let who: string
  if (position) {
    const department = org.departments.find((d) => d.code === position[2])
    const root = department?.parentId === null
    who = root ? position[1]! : `${position[1]} ของ${department?.nameTh ?? position[2]}`
  } else {
    who = name(step.assigneeMemberId)
  }
  return step.principalMemberId ? `${who} (${name(step.assigneeMemberId)} รักษาการแทน ${name(step.principalMemberId)})` : who
}

export function explainRouteTh(input: {
  version: DoaVersionSnapshot
  documentType: DoaDocumentType
  basisAmount: bigint | null
  amountBasis: AmountBasis
  rule: DoaRuleSnapshot
  escalatedFrom: { rule: DoaRuleSnapshot; conflicting: ExplainedStep[] } | null
  steps: readonly ExplainedStep[]
  org: OrgSnapshot
}): string {
  const { version, documentType, basisAmount, amountBasis, rule, escalatedFrom, steps, org } = input
  const amountRule = escalatedFrom?.rule ?? rule
  // Thai joins the document name and its amount without a space: "คำขอซื้อยอด 45,000.00 บาท (รวม VAT)"
  const subject = basisAmount !== null ? `${DOCUMENT_TH[documentType]}ยอด ${formatSatang(basisAmount)} บาท (${BASIS_TH[amountBasis]})` : DOCUMENT_TH[documentType]
  const parts = [`${version.code} ฉบับ ${version.versionNo} ข้อ ${rule.code}:`, subject]
  const band = bandTextTh(amountRule)
  if (band) parts.push(escalatedFrom ? `${band} ของข้อ ${amountRule.code}` : band)
  if (escalatedFrom) {
    const first = escalatedFrom.conflicting.map((s) => approverTh(s, org)).join(' และ ')
    parts.push(`→ ${first} มีส่วนเกี่ยวข้องกับเอกสารนี้ จึงยกไปข้อ ${rule.code} ของช่วงวงเงินถัดไป`)
  }
  parts.push(`→ ${steps.map((s) => approverTh(s, org)).join(' → ')}`)
  return parts.join(' ')
}
