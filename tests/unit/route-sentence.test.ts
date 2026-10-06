import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { routeSentence, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import type { ApproverRoleDto, MemberRefDto, RouteDto, RouteStepDto } from '@/server/queries/requests'
import en from '../../messages/en.json'

// BR-DOA-10 · "Why this route" in English (src/app/(workspace)/_tracking/present.ts routeSentence), built from the route
// as the Thai record (RouteDto.explanationTh, src/core/doa/explain.ts) is: it names whom the rule gave each step — the
// step's first task (RouteStepDto.ruleApprover), or the approver its rule expects for a step not started yet — never
// whoever decided an escalated step in their place (BR-SLA-04, NEW-46: the co-assignee who decided first is the step's
// `approver`). A comma ends the amount and its band before "goes to". Real English messages.

const t = createTranslator({ locale: 'en', messages: en, namespace: 'requestView' }) as unknown as ViewT
const tl = createTranslator({ locale: 'en', messages: en, namespace: 'timeline' }) as unknown as TimelineT

const dm: MemberRefDto = { id: 'm-dm', name: { th: 'ดำรง ก่อสร้างไทย', en: 'Damrong Construction' } }
const vp: MemberRefDto = { id: 'm-vp', name: { th: 'วารี ปฏิบัติการ', en: 'Varee Operations' } }
const asst: MemberRefDto = { id: 'm-asst', name: { th: 'อัศวิน ผู้ช่วย', en: 'Atsawin Assistant' } }
const dmRole: ApproverRoleDto = { kind: 'POSITION', positionCode: 'DM', position: { th: 'ผู้จัดการฝ่าย', en: 'Department manager' }, department: { th: 'ฝ่ายก่อสร้าง', en: 'Construction' }, orgWide: false }
const vpRole: ApproverRoleDto = { kind: 'POSITION', positionCode: 'VP', position: { th: 'รองประธาน', en: 'Vice president' }, department: { th: 'สายปฏิบัติการ', en: 'Operations' }, orgWide: false }

const step = (more: Partial<RouteStepDto>): RouteStepDto => ({
  stepNo: 1,
  status: 'DONE',
  approver: null,
  onBehalfOf: null,
  role: null,
  expected: null,
  taskStatus: null,
  decision: null,
  decidedAt: null,
  open: [],
  escalation: null,
  ruleApprover: null,
  ...more,
})
const route = (steps: RouteStepDto[], more: Partial<RouteDto> = {}): RouteDto => ({
  id: 'r-1',
  routeNo: 1,
  status: 'COMPLETED',
  doa: { versionId: 'v-1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-01' },
  escalatedFromRuleCode: null,
  amountBasis: 'GROSS',
  basisSatang: 1_000_000n,
  explanationTh: 'DOA-DEMO ฉบับ 1 ข้อ PR-01: คำขอซื้อยอด 10,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 20,000.00 → DM ของฝ่ายก่อสร้าง',
  band: { lowerSatang: 0n, upperSatang: 2_000_000n },
  steps,
  createdAt: new Date('2026-10-05T02:00:00Z'),
  ...more,
})
const OPENING = 'DOA-DEMO version 1 rule PR-01: a purchase request of 10,000.00 baht (incl. VAT) is in the band up to 20,000.00'

/** The step of PR-01 escalated past its time: the VP of the band above joined it and decided first */
const decidedByCoAssignee = step({ approver: vp, role: vpRole, taskStatus: 'APPROVED', decision: 'APPROVE', decidedAt: new Date('2026-10-06T09:30:00Z'), escalation: 'CO_ASSIGNED', ruleApprover: { approver: dm, onBehalfOf: null, role: dmRole } })

describe('[FR-DOA-003/AC2] the English "Why this route" names whom the rule gave each step, as the Thai record does', () => {
  it('an escalated step the co-assignee decided names the DM the rule gave it, not the VP who decided; a comma before "goes to"', () => {
    expect(routeSentence(t, tl, 'en', route([decidedByCoAssignee]), 'REQUEST')).toBe(`${OPENING}, goes to Damrong Construction (Department manager, Construction)`)
    // The Thai reader gets the record kept with the route, which names the DM's position
    expect(routeSentence(t, tl, 'th', route([decidedByCoAssignee]), 'REQUEST')).toBe('DOA-DEMO ฉบับ 1 ข้อ PR-01: คำขอซื้อยอด 10,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 20,000.00 → DM ของฝ่ายก่อสร้าง')
  })

  it('a step that waits for its turn names the approver its rule expects; a delegate the rule’s step went to says whom they act for', () => {
    const later = step({ stepNo: 2, status: 'WAITING', expected: { kind: 'POSITION', positionCode: 'COO', position: { th: 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', en: 'Chief operating officer' } } })
    expect(routeSentence(t, tl, 'en', route([decidedByCoAssignee, later]), 'REQUEST')).toBe(`${OPENING}, goes to Damrong Construction (Department manager, Construction), Chief operating officer`)
    const held = step({ status: 'ACTIVE', approver: asst, onBehalfOf: dm, role: dmRole, taskStatus: 'OPEN', ruleApprover: { approver: asst, onBehalfOf: dm, role: dmRole } })
    expect(routeSentence(t, tl, 'en', route([held]), 'REQUEST')).toBe(`${OPENING}, goes to Atsawin Assistant (acting for Damrong Construction · Department manager, Construction)`)
  })

  it('a route the engine only previewed (no ruleApprover) names the approver it would go to; a route without an amount reads from its document', () => {
    const { ruleApprover: _ruleApprover, ...preview } = step({ status: 'WAITING', approver: dm, role: dmRole })
    expect(routeSentence(t, tl, 'en', route([preview]), 'PURCHASE_ORDER')).toBe(
      'DOA-DEMO version 1 rule PR-01: a purchase order of 10,000.00 baht (incl. VAT) is in the band up to 20,000.00, goes to Damrong Construction (Department manager, Construction)',
    )
    const ceo = step({ ruleApprover: { approver: { id: 'm-ceo', name: { th: 'ชาญ ผู้บริหาร', en: null } }, onBehalfOf: null, role: { kind: 'POSITION', positionCode: 'CEO', position: { th: 'CEO', en: null }, department: null, orgWide: true } } })
    expect(routeSentence(t, tl, 'en', route([ceo], { doa: { versionId: 'v-1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'DOA-CHG-01' }, basisSatang: null, band: null }), 'DOA_VERSION')).toBe(
      'DOA-DEMO version 1 rule DOA-CHG-01: DOA change, goes to ชาญ ผู้บริหาร (CEO)',
    )
  })
})
