import { describe, expect, it } from 'vitest'
import { when, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import { docTimelineItems, waitingOf, type PoT } from '@/app/(workspace)/procurement/pos/_parts/present'
import type { DocTrackEntryDto, PoWaitingDto } from '@/server/queries/purchase-orders'
import type { ApproverRoleDto, MemberRefDto, WaitingApproverDto } from '@/server/queries/requests'

// NEW-46 on a purchase order and a receiving variance (FR-INT-008 AC1, BR-SLA-04), as the PO list, the PO page and the
// decision pages say it (src/app/(workspace)/procurement/pos/_parts/present.ts): an escalated step waits for its first
// approver and for the co-assignee alike, so "now" names both with their positions, joined as the reader's language
// says "or", oldest task first; a decision on that step carries the escalated flag beside its DOA reference. A step with
// one approver reads as before.

const fake = (key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)
const t = fake as unknown as PoT
const tv = fake as unknown as ViewT
const tl = ((key: string, values?: Record<string, unknown>) => (key === 'doaRef' && values ? `${String(values.code)} v${String(values.version)} ${String(values.rule)}` : fake(key, values))) as unknown as TimelineT

const coo: MemberRefDto = { id: 'm-coo', name: { th: 'ชัยวัฒน์ ปฏิบัติการใหญ่', en: 'Chaiwat COO' } }
const ceo: MemberRefDto = { id: 'm-ceo', name: { th: 'สมศักดิ์ บริหารดี', en: 'Somsak CEO' } }
const asst: MemberRefDto = { id: 'm-asst', name: { th: 'อารี ผู้ช่วย', en: null } }
const cooRole: ApproverRoleDto = { kind: 'POSITION', positionCode: 'COO', position: { th: 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', en: 'Chief operating officer' }, department: null, orgWide: true }
const ceoRole: ApproverRoleDto = { kind: 'POSITION', positionCode: 'CEO', position: { th: 'ประธานเจ้าหน้าที่บริหาร', en: 'Chief executive officer' }, department: null, orgWide: true }
const since = new Date('2026-10-07T03:00:00Z')
const approver = (taskId: string, assignee: MemberRefDto, role: ApproverRoleDto, onBehalfOf: MemberRefDto | null = null): WaitingApproverDto => ({ taskId, assignee, onBehalfOf, role, since, waitingMinutes: 600, dueAt: since, overdue: true })
const escalatedStep: PoWaitingDto = { kind: 'APPROVER', assignee: coo, onBehalfOf: null, role: cooRole, waitingMinutes: 600, dueAt: since, overdue: true, approvers: [approver('t-coo', coo, cooRole), approver('t-ceo', ceo, ceoRole)] }

function entry(over: Partial<DocTrackEntryDto>): DocTrackEntryDto {
  return {
    key: 'k',
    state: 'done',
    what: 'APPROVED',
    at: new Date('2026-10-07T04:00:00Z'),
    channel: 'WEB',
    actor: ceo,
    onBehalfOf: null,
    role: ceoRole,
    expected: null,
    doa: { versionId: 'v-1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PO-01' },
    note: null,
    detail: null,
    other: null,
    waitingMinutes: null,
    dueAt: null,
    overdue: false,
    ...over,
  }
}

describe('[FR-INT-008/AC1] a PO or a variance on an escalated step names everyone who may decide it (BR-SLA-04, NEW-46)', () => {
  it('"now" names the first approver and the co-assignee with their positions, joined by "หรือ" / "or"; the time is the first one’s', () => {
    expect(waitingOf(t, tv, 'th', escalatedStep)).toEqual({
      now: `waiting.APPROVER${JSON.stringify({ name: 'ชัยวัฒน์ ปฏิบัติการใหญ่ (ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ) หรือ สมศักดิ์ บริหารดี (ประธานเจ้าหน้าที่บริหาร)' })}`,
      states: [
        { kind: 'waiting', text: `waiting.hours${JSON.stringify({ hours: 10 })}` },
        { kind: 'overdue', text: `waiting.overdue${JSON.stringify({ time: when('th', since) })}` },
      ],
    })
    expect(waitingOf(t, tv, 'en', escalatedStep).now).toBe(`waiting.APPROVER${JSON.stringify({ name: 'Chaiwat COO (Chief operating officer) or Somsak CEO (Chief executive officer)' })}`)
  })

  it('one approver reads as before; a delegate says whom they act for', () => {
    const one: PoWaitingDto = { ...escalatedStep, approvers: [approver('t-coo', coo, cooRole)] }
    expect(waitingOf(t, tv, 'th', one).now).toBe(`waiting.APPROVER${JSON.stringify({ name: 'ชัยวัฒน์ ปฏิบัติการใหญ่ (ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ)' })}`)
    const held: PoWaitingDto = { ...escalatedStep, assignee: asst, onBehalfOf: coo, approvers: [approver('t-coo', asst, cooRole, coo), approver('t-ceo', ceo, ceoRole)] }
    const actingFor = `waiting.actingFor${JSON.stringify({ name: 'อารี ผู้ช่วย', principal: 'ชัยวัฒน์ ปฏิบัติการใหญ่' })}`
    expect(waitingOf(t, tv, 'th', held).now).toBe(`waiting.APPROVER${JSON.stringify({ name: `${actingFor} (ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ) หรือ สมศักดิ์ บริหารดี (ประธานเจ้าหน้าที่บริหาร)` })}`)
    // Nobody found to wait for
    expect(waitingOf(t, tv, 'th', { ...escalatedStep, assignee: null, approvers: [] }).now).toBe('waiting.APPROVER_UNKNOWN')
  })

  it('the decision on an escalated step is stamped with its DOA reference and the escalated flag, beside whom a delegate acted for', () => {
    const [flagged, delegated, plain] = docTimelineItems(
      t,
      tv,
      tl,
      'th',
      [entry({ key: 'a', escalated: true }), entry({ key: 'b', actor: asst, onBehalfOf: coo, escalated: true }), entry({ key: 'c' })],
      { doaLinks: false },
    )
    expect(flagged).toMatchObject({ id: 'a', stamp: true, doaRef: 'DOA-DEMO v1 PO-01', onBehalfOf: 'timeline.escalated' })
    expect(delegated).toMatchObject({ id: 'b', onBehalfOf: `actingFor${JSON.stringify({ name: 'ชัยวัฒน์ ปฏิบัติการใหญ่' })} · timeline.escalated` })
    expect(plain).toMatchObject({ id: 'c', stamp: true, doaRef: 'DOA-DEMO v1 PO-01' })
    expect(plain).not.toHaveProperty('onBehalfOf')
  })
})
