import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { backtestModel, loadText, memberNameOf, sideErrorKey, subjectTypeKey, type BacktestDoneDto, type BacktestViewDto } from '@/ui/backtest/model'
import { BacktestPanel } from '@/ui/backtest/panel'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S6-07 (FR-DOA-103 AC1 AC3 · BR-WF-13 · BR-DOA-14): what the 90-day backtest panel shows from the service's answer —
// the window, the counts, the load per person as +n / −n with names, only the documents whose route changes with both
// sides named and an engine refusal in words — and the panel's states as it first draws: not run yet, done with
// changes, done with none, waiting for the job, failed. The answers themselves: tests/integration/backtest.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }))

const DONE: BacktestDoneDto = {
  status: 'DONE',
  from: '2026-07-08T03:00:00.000Z',
  to: '2026-10-06T03:00:00.000Z',
  documentCount: 3,
  result: {
    rows: [
      { ref: 'r-moved', current: { rule: 'PR-02', approvers: ['m-vp'], reviewers: [], error: null }, draft: { rule: 'PR-01', approvers: ['m-dm'], reviewers: ['m-leg'], error: null }, changed: true },
      { ref: 'r-same', current: { rule: 'PR-01', approvers: ['m-dm'], reviewers: [], error: null }, draft: { rule: 'PR-01', approvers: ['m-dm'], reviewers: [], error: null }, changed: false },
      { ref: 'r-refused', current: { rule: 'PO-01', approvers: ['m-dm'], reviewers: [], error: null }, draft: { rule: null, approvers: [], reviewers: [], error: 'APPROVER_NOT_FOUND' }, changed: true },
    ],
    summary: { total: 3, changed: 2, load: { 'm-dm': -1, 'm-leg': 1, 'm-vp': -1, 'm-zero': 0 } },
  },
  documents: [
    { ref: 'r-moved', subjectType: 'REQUEST', label: 'PR-2569-0001 เครื่องตัดคอนกรีต', sentAt: '2026-09-01T03:00:00.000Z' },
    { ref: 'r-same', subjectType: 'REQUEST', label: 'PR-2569-0002 ถุงมือ', sentAt: '2026-09-02T03:00:00.000Z' },
    { ref: 'r-refused', subjectType: 'PURCHASE_ORDER', label: 'PO-2569-0001', sentAt: '2026-09-03T03:00:00.000Z' },
  ],
  members: { 'm-vp': { th: 'วิชัย สายปฏิบัติ', en: 'Wichai' }, 'm-dm': { th: 'ดนัย ก่อสร้าง', en: null }, 'm-leg': { th: 'ลลิตา กฎหมาย', en: 'Lalita' } },
}

describe('[FR-DOA-103/AC1] the backtest model', () => {
  it('keeps only the documents whose route changes, names both sides and says a refusal as its key', () => {
    const m = backtestModel(DONE, 'th')
    expect(m).toMatchObject({ from: DONE.from, to: DONE.to, total: 3, changed: 2 })
    expect(m.rows.map((r) => r.ref)).toEqual(['r-moved', 'r-refused'])
    expect(m.rows[0]).toEqual({
      ref: 'r-moved',
      label: 'PR-2569-0001 เครื่องตัดคอนกรีต',
      subjectType: 'REQUEST',
      sentAt: '2026-09-01T03:00:00.000Z',
      current: { rule: 'PR-02', approvers: ['วิชัย สายปฏิบัติ'], reviewers: [], error: null },
      draft: { rule: 'PR-01', approvers: ['ดนัย ก่อสร้าง'], reviewers: ['ลลิตา กฎหมาย'], error: null },
    })
    expect(m.rows[1]!.draft.error).toEqual({ key: 'APPROVER_NOT_FOUND', code: 'APPROVER_NOT_FOUND' })
    expect(m.rows[1]!.subjectType).toBe('PURCHASE_ORDER')
  })

  it('lists who gets more tasks first, then fewer, by name, as +n and −n; a zero is left out', () => {
    expect(backtestModel(DONE, 'th').load).toEqual([
      { memberId: 'm-leg', name: 'ลลิตา กฎหมาย', delta: 1, text: '+1' },
      { memberId: 'm-dm', name: 'ดนัย ก่อสร้าง', delta: -1, text: '−1' },
      { memberId: 'm-vp', name: 'วิชัย สายปฏิบัติ', delta: -1, text: '−1' },
    ])
    // English names when given, Thai otherwise
    expect(backtestModel(DONE, 'en').load.map((l) => l.name)).toEqual(['Lalita', 'Wichai', 'ดนัย ก่อสร้าง'])
  })

  it('says load, names, refusals and kinds of document it does not know plainly', () => {
    expect(loadText(3)).toBe('+3')
    expect(loadText(-2)).toBe('−2')
    expect(memberNameOf(DONE.members, 'm-unknown', 'th')).toBe('m-unknown')
    expect(memberNameOf(DONE.members, 'm-dm', 'en')).toBe('ดนัย ก่อสร้าง')
    expect(sideErrorKey('REVIEWER_NOT_FOUND')).toBe('REVIEWER_NOT_FOUND')
    expect(sideErrorKey('SOMETHING_ELSE')).toBe('OTHER')
    expect(subjectTypeKey('VARIANCE')).toBe('VARIANCE')
    expect(subjectTypeKey('ORG_AUTHORITY_CHANGE')).toBe('OTHER')
  })
})

function render(node: ReactNode, locale: 'th' | 'en' = 'th') {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )
}

const actions = { run: vi.fn(), reread: vi.fn() }
const panel = (initial: BacktestViewDto | null, locale: 'th' | 'en' = 'th', purpose: 'draft' | 'withdrawal' = 'draft') =>
  render(<BacktestPanel kind="DOA_VERSION" versionId="v-1" versionName="DOA-TEST ฉบับ 2" purpose={purpose} initial={initial} {...actions} />, locale)

describe('[FR-DOA-103/AC1] [FR-DOA-103/AC3] [BR-WF-13] the backtest panel', () => {
  it('before it runs: what it does and the one button, nothing else', () => {
    const html = panel(null)
    expect(html).toContain('ลองใช้ DOA-TEST ฉบับ 2 กับเอกสารทุกฉบับที่ส่งใน 90 วันที่ผ่านมา')
    expect(html).toContain('>ย้อนทดสอบ 90 วัน</button>')
    expect(html).not.toContain('เปลี่ยนเส้นทาง')
  })

  it('for a withdrawal it says what withdrawing avoids', () => {
    expect(panel(null, 'th', 'withdrawal')).toContain('ถ้าถอนฉบับนี้ ความเปลี่ยนแปลงเหล่านี้จะไม่เกิดขึ้น')
  })

  it('done: the window, the counts, the load as +n / −n beside the names and each changed document on both sides', () => {
    const html = panel(DONE)
    expect(html).toContain('เอกสาร 3 ฉบับ · เปลี่ยนเส้นทาง 2 ฉบับ')
    expect(html).toContain('ภาระงานต่อคนถ้าใช้ฉบับนี้')
    expect(html).toContain('ลลิตา กฎหมาย')
    expect(html).toContain('+1 งาน')
    expect(html).toContain('−1 งาน')
    expect(html).toContain('เอกสารที่เปลี่ยนเส้นทาง (2)')
    expect(html).toContain('PR-2569-0001 เครื่องตัดคอนกรีต')
    expect(html).toContain('คำขอซื้อ/จ้าง')
    expect(html).toContain('ข้อ PR-02')
    expect(html).toContain('ผู้อนุมัติ: วิชัย สายปฏิบัติ')
    expect(html).toContain('ผู้ตรวจ: ลลิตา กฎหมาย')
    expect(html).toContain('หาผู้อนุมัติไม่ได้ ตำแหน่งที่ข้อนี้อ้างว่างอยู่')
    // The unchanged document is not listed
    expect(html).not.toContain('ถุงมือ')
    expect(html).toContain('>ย้อนทดสอบอีกครั้ง</button>')
  })

  it('done with nothing changed, and with no documents: says so and what it means', () => {
    const same: BacktestDoneDto = { ...DONE, result: { rows: [DONE.result.rows[1]!], summary: { total: 1, changed: 0, load: {} } } }
    expect(panel(same)).toContain('ไม่มีเอกสารใดเปลี่ยนเส้นทาง')
    const none: BacktestDoneDto = { ...DONE, documentCount: 0, result: { rows: [], summary: { total: 0, changed: 0, load: {} } }, documents: [], members: {} }
    expect(panel(none)).toContain('ไม่มีเอกสารที่ส่งใน 90 วันที่ผ่านมา จึงยังเทียบไม่ได้')
  })

  it('waiting for the job: how many documents and a button to look again; failed: to run again', () => {
    const pending = panel({ status: 'PENDING', runId: '0190a4c2-0000-7000-8000-000000000001', documentCount: 612 })
    expect(pending).toContain('เอกสารในช่วงนี้มี 612 ฉบับ จึงคำนวณเป็นงานเบื้องหลัง')
    expect(pending).toContain('ดูผลอีกครั้ง</button>')
    expect(panel({ status: 'FAILED', runId: '0190a4c2-0000-7000-8000-000000000001', documentCount: 612 })).toContain('คำนวณเอกสาร 612 ฉบับไม่สำเร็จ')
  })

  it('in English', () => {
    const html = panel(DONE, 'en')
    expect(html).toContain('3 documents · 2 change route')
    expect(html).toContain('+1 tasks')
    expect(html).toContain('Approvers: Wichai')
  })
})
