import { formatSatang } from '@/core/money/format'
import { bandOf } from './band'
import { DOC_TYPE_TRAITS, type AmountBasis, type DoaDocumentType, type DoaRuleSnapshot, type DoaVersionSnapshot, type OrgSnapshot } from './types'

// The Thai explanation stored on every route (BR-DOA-10), e.g. "DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 45,000.00 บาท
// (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 → VP ของสายปฏิบัติการ". Screens in English build their
// own sentence from the structured route; this text is the record kept with the route.

const DOCUMENT_TH: Record<DoaDocumentType, string> = {
  PURCHASE_REQUEST: 'คำขอซื้อ',
  PURCHASE_ORDER: 'ใบสั่งซื้อ',
  GR_VARIANCE: 'ผลต่างจากการตรวจรับ',
  DOA_CHANGE: 'การเปลี่ยน DOA',
  ORG_AUTHORITY_CHANGE: 'การเปลี่ยนโครงสร้างอำนาจ',
  BUDGET_TRANSFER: 'การโอนงบ',
  OVER_BUDGET: 'การขออนุมัติเกินงบ',
  INVOICE_EXCEPTION: 'ใบแจ้งหนี้ที่ไม่ตรงกับใบสั่งซื้อ',
  PO_CHANGE: 'การแก้ไขใบสั่งซื้อ',
  PAYMENT_RUN: 'รอบจ่ายเงิน',
  BANK_ACCOUNT_CHANGE: 'การเปลี่ยนบัญชีธนาคาร',
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
  /** A committee step (S6): its slots and quorum */
  readonly committee?: { readonly quorum: 'ALL' | 'ANY' | 'COUNT'; readonly quorumCount: number | null; readonly slots: readonly ExplainedStep[] }
}

const QUORUM_TH = { ALL: 'ต้องได้ทุกเสียง', ANY: 'คนใดคนหนึ่ง' } as const

/** "คณะกรรมการ (COO, CFO, ผู้จัดการฝ่ายของฝ่ายบัญชี) ต้องได้ 2 เสียง" (BR-WF-04: MAJORITY is already a count here) */
function stepTh(step: ExplainedStep, org: OrgSnapshot): string {
  const c = step.committee
  if (!c) return approverTh(step, org)
  const quorum = c.quorum === 'COUNT' ? `ต้องได้ ${c.quorumCount ?? c.slots.length} เสียง` : QUORUM_TH[c.quorum]
  return `คณะกรรมการ (${c.slots.map((x) => approverTh(x, org)).join(', ')}) ${quorum}`
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
  /** The bands skipped because their approvers conflict, in order (BR-DOA-06) */
  escalations: readonly { rule: DoaRuleSnapshot; conflicting: ExplainedStep[] }[]
  steps: readonly ExplainedStep[]
  org: OrgSnapshot
}): string {
  const { version, documentType, basisAmount, amountBasis, rule, escalations, steps, org } = input
  const amountRule = escalations[0]?.rule ?? rule
  // Thai joins the document name and its amount without a space: "คำขอซื้อยอด 45,000.00 บาท (รวม VAT)". A type whose
  // amount never carries VAT (BR-DOA-21: transfers, over-budget, payment runs) names no basis: both give the same amount
  const traits = DOC_TYPE_TRAITS[documentType]
  const basis = traits.amount === 'REQUIRED' && !traits.vat ? '' : ` (${BASIS_TH[amountBasis]})`
  const subject = basisAmount !== null ? `${DOCUMENT_TH[documentType]}ยอด ${formatSatang(basisAmount)} บาท${basis}` : DOCUMENT_TH[documentType]
  const parts = [`${version.code} ฉบับ ${version.versionNo} ข้อ ${rule.code}:`, subject]
  const band = bandTextTh(amountRule)
  if (band) parts.push(escalations.length ? `${band} ของข้อ ${amountRule.code}` : band)
  escalations.forEach((skipped, i) => {
    const who = skipped.conflicting.map((s) => approverTh(s, org)).join(' และ ')
    const to = escalations[i + 1]?.rule ?? rule
    parts.push(`→ ${who} มีส่วนเกี่ยวข้องกับเอกสารนี้ จึงยกไปข้อ ${to.code} ของช่วงวงเงินถัดไป`)
  })
  parts.push(`→ ${steps.map((s) => stepTh(s, org)).join(' → ')}`)
  return parts.join(' ')
}
