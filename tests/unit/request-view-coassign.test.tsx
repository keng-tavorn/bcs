import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { stageText, timelineItems, type TimelineT, type ViewT } from '@/app/(workspace)/_tracking/present'
import type { StageDto, TrackEntryDto, WaitingApproverDto } from '@/server/queries/requests'
import { StepApprovers } from '@/ui/request-view/step-approvers'

// NEW-46 on the request page (FR-INT-008 AC1, BR-SLA-04): an escalated step waits for its first assignee and for the
// co-assignee alike. The "now" line names both, joined as the reader's language says "or", and the route's step lists
// both with their positions and says that whoever decides first decides. A step with one approver reads as before.

const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)) as unknown as ViewT

const dm = { id: 'm-dm', name: { th: 'ดำรง ก่อสร้างไทย', en: 'Damrong Construction' } }
const coo = { id: 'm-coo', name: { th: 'ชัยวัฒน์ ปฏิบัติการใหญ่', en: 'Chaiwat COO' } }
const dmRole = { kind: 'POSITION' as const, positionCode: 'DM', position: { th: 'ผู้จัดการฝ่าย', en: 'Department manager' }, department: { th: 'ฝ่ายก่อสร้าง', en: 'Construction' }, orgWide: false }
const cooRole = { kind: 'POSITION' as const, positionCode: 'COO', position: { th: 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', en: 'Chief operating officer' }, department: null, orgWide: true }
const since = new Date('2026-10-05T02:00:00Z')
const waiting = (taskId: string, assignee: typeof dm, role: WaitingApproverDto['role']): WaitingApproverDto => ({ taskId, assignee, onBehalfOf: null, role, since, waitingMinutes: 600, dueAt: since, overdue: true })

const stage: StageDto = {
  kind: 'APPROVER',
  ...waiting('t-dm', dm, dmRole),
  stepNo: 1,
  stepCount: 2,
  approvers: [waiting('t-dm', dm, dmRole), waiting('t-coo', coo, cooRole)],
}

describe('[FR-INT-008/AC1] an escalated step names everyone who may decide it (NEW-46)', () => {
  it('"now" names the first assignee and the co-assignee with their positions, joined by "หรือ" / "or"', () => {
    const dmPosition = `role.positionIn${JSON.stringify({ position: 'ผู้จัดการฝ่าย', department: 'ฝ่ายก่อสร้าง' })}`
    expect(stageText(t, 'th', stage, true)).toBe(`stage.APPROVER${JSON.stringify({ name: `ดำรง ก่อสร้างไทย (${dmPosition}) หรือ ชัยวัฒน์ ปฏิบัติการใหญ่ (ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ)` })}`)
    const dmPositionEn = `role.positionIn${JSON.stringify({ position: 'Department manager', department: 'Construction' })}`
    expect(stageText(t, 'en', stage, true)).toBe(`stage.APPROVER${JSON.stringify({ name: `Damrong Construction (${dmPositionEn}) or Chaiwat COO (Chief operating officer)` })}`)
  })

  it('a step with one approver reads as before, with or without the list', () => {
    const one = { ...stage, approvers: [waiting('t-dm', dm, dmRole)] }
    const { approvers: _approvers, ...without } = stage
    const expected = `stage.APPROVER${JSON.stringify({ name: `ดำรง ก่อสร้างไทย (role.positionIn${JSON.stringify({ position: 'ผู้จัดการฝ่าย', department: 'ฝ่ายก่อสร้าง' })})` })}`
    expect(stageText(t, 'th', one, true)).toBe(expected)
    expect(stageText(t, 'th', without, true)).toBe(expected)
  })

  it('the route’s step lists both approvers with their positions, and says whoever decides first decides', () => {
    const html = renderToStaticMarkup(
      <StepApprovers
        title="ขั้นที่ 1"
        approvers={[
          { key: 't-dm', name: 'ดำรง ก่อสร้างไทย', role: 'ผู้จัดการฝ่าย ฝ่ายก่อสร้าง' },
          { key: 't-coo', name: 'หรือ ชัยวัฒน์ ปฏิบัติการใหญ่', role: 'ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ', actingFor: undefined },
        ]}
        note="ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้"
      />,
    )
    const items = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '|'))
    expect(items).toEqual(['|ดำรง ก่อสร้างไทย||ผู้จัดการฝ่าย ฝ่ายก่อสร้าง|', '|หรือ ชัยวัฒน์ ปฏิบัติการใหญ่||ประธานเจ้าหน้าที่ฝ่ายปฏิบัติการ|'])
    expect(html).toContain('<p class="font-medium text-ink">ขั้นที่ 1</p>')
    expect(html).toContain('ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้')
  })

  it('names whom a delegate holding one of the tasks acts for (BR-DLG-04)', () => {
    const html = renderToStaticMarkup(<StepApprovers title="ขั้นที่ 1" approvers={[{ key: 'a', name: 'สมหญิง รักงาน', role: 'ผู้จัดการฝ่าย', actingFor: 'รักษาการแทน ดำรง ก่อสร้างไทย' }]} note="n" />)
    expect(html).toContain('<span class="text-ink-muted">รักษาการแทน ดำรง ก่อสร้างไทย</span>')
  })
})

describe('[FR-INT-008/AC1] the escalated flag of BR-SLA-04: the step and its decision say the band above joined it past its time', () => {
  const tl = ((key: string, values?: Record<string, unknown>) => (values ? `${key}${JSON.stringify(values)}` : key)) as unknown as TimelineT
  const decided: TrackEntryDto = {
    key: 'e1',
    state: 'done',
    what: 'APPROVED',
    at: since,
    channel: 'WEB',
    actor: coo,
    onBehalfOf: null,
    role: cooRole,
    expected: null,
    doa: { versionId: 'v1', code: 'DOA-DEMO', versionNo: 1, ruleCode: 'PR-01' },
    note: null,
    other: null,
    number: null,
    stepNo: null,
    waitingMinutes: null,
    dueAt: null,
    overdue: false,
  }

  it('the stamp keeps the route’s own rule and adds the flag under the decider; without it the stamp reads as before', () => {
    const [flagged] = timelineItems(t, tl, 'th', [{ ...decided, escalated: true }])
    expect(flagged).toMatchObject({ actor: 'ชัยวัฒน์ ปฏิบัติการใหญ่', onBehalfOf: 'timeline.escalated', doaRef: `doaRef${JSON.stringify({ code: 'DOA-DEMO', version: 1, rule: 'PR-01' })}`, stamp: true })
    const [plain] = timelineItems(t, tl, 'th', [decided])
    expect(plain).not.toHaveProperty('onBehalfOf')
    // A delegate who decided an escalated step: both lines, in one
    const [both] = timelineItems(t, tl, 'th', [{ ...decided, escalated: true, onBehalfOf: dm }])
    expect(both!.onBehalfOf).toBe(`actingFor${JSON.stringify({ name: 'ดำรง ก่อสร้างไทย' })} · timeline.escalated`)
  })

  it('the route’s step with both approvers carries the mark above "whoever decides first"', () => {
    const html = renderToStaticMarkup(<StepApprovers title="ขั้นที่ 1" approvers={[{ key: 'a', name: 'ดำรง ก่อสร้างไทย' }, { key: 'b', name: 'หรือ ชัยวัฒน์ ปฏิบัติการใหญ่' }]} mark="ส่งต่อเมื่อเลยกำหนด ผู้อนุมัติระดับถัดไปร่วมพิจารณา" note="ผู้ที่ตัดสินก่อนเป็นผู้ตัดสินขั้นนี้" />)
    expect(html.indexOf('ส่งต่อเมื่อเลยกำหนด')).toBeGreaterThan(html.indexOf('หรือ ชัยวัฒน์'))
    expect(html.indexOf('ส่งต่อเมื่อเลยกำหนด')).toBeLessThan(html.indexOf('ผู้ที่ตัดสินก่อน'))
    expect(renderToStaticMarkup(<StepApprovers title="ขั้นที่ 1" approvers={[{ key: 'a', name: 'x' }]} note="n" />)).not.toContain('undefined')
  })
})
