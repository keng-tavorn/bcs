import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HomeT } from '@/app/(workspace)/_tracking/home-present'
import { liffHomeDestination, liffTodoRows } from '@/app/liff/home/present'
import { TODO_KEYS, TODO_TONE } from '@/server/services/home/todo-keys'
import { LiffApprovalsList, LiffHomeEmpty, LiffHomeError, LiffTodoList } from '@/ui/liff/home/home-parts'
import th from '../../messages/th.json'

// S17-02 · the parts of /liff/home (FR-LINE-302 · BR-LINE-18): where each row leads from LINE (a LIFF page when there is
// one, the web outside LINE otherwise · AC2), a part that could not load (AC3), a member with nothing waiting (AC4), and
// "รอฉันอนุมัติ" opening each task's LIFF page (AC5). The numbers are the web home's services: tests/integration/liff-home.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }))
vi.mock('@/ui/liff/liff-provider', () => ({ useLiff: () => ({ openExternal: () => undefined }) }))

const homeT = createTranslator({ locale: 'th', messages: th, namespace: 'home' }) as unknown as HomeT
const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('[FR-LINE-302/AC2] a home row opens its LIFF page, or the web outside LINE', () => {
  it('lists with a LIFF page open it whole (a LIFF list has no filter); the others stay on the web with their filter', () => {
    expect(liffHomeDestination('/tasks?due=overdue')).toEqual({ href: '/liff/tasks', inLiff: true })
    expect(liffHomeDestination('/requests?status=returned&scope=mine')).toEqual({ href: '/liff/track', inLiff: true })
    expect(liffHomeDestination('/requests?scope=following')).toEqual({ href: '/liff/track', inLiff: true })
    expect(liffHomeDestination(`/requests/${ID}`)).toEqual({ href: `/liff/requests/${ID}`, inLiff: true })
    expect(liffHomeDestination(`/tasks/${ID}`)).toEqual({ href: `/liff/tasks/${ID}`, inLiff: true })
    expect(liffHomeDestination('/finance/invoices?gr=posted')).toEqual({ href: '/finance/invoices?gr=posted', inLiff: false })
    expect(liffHomeDestination('/procurement/pool')).toEqual({ href: '/liff/procurement', inLiff: true })
    expect(liffHomeDestination('/receiving')).toEqual({ href: '/liff/gr', inLiff: true })
    expect(liffHomeDestination('/procurement/pos?status=approved')).toEqual({ href: '/procurement/pos?status=approved', inLiff: false })
  })

  it('every to-do row of the web home gets a destination, the ones of a requester and an approver in LIFF', () => {
    const rows = liffTodoRows(homeT, { rows: TODO_KEYS.map((key) => ({ key, count: 2, tone: TODO_TONE[key] })), openTasks: 0 })
    expect(Object.fromEntries(rows.map((r) => [r.key, r.to.inLiff]))).toEqual({
      OVERDUE_TASKS: true,
      RETURNED: true,
      QUESTIONS: true,
      RECEIVING: true,
      POOL: true,
      PO_APPROVED: false,
      INVOICES: false,
      EXPORTS: false,
      DRAFTS: true,
    })
    expect(rows[0]).toMatchObject({ text: 'งานอนุมัติเกินกำหนด 2 รายการ', tone: 'danger' })
  })

  it('a LIFF row is a light link; a web row is a link that says it opens in the browser', () => {
    const html = renderToStaticMarkup(
      <LiffTodoList
        label="สิ่งที่คุณต้องทำ"
        webHint="เปิดในเบราว์เซอร์นอก LINE"
        rows={[
          { key: 'OVERDUE_TASKS', text: 'งานอนุมัติเกินกำหนด 2 รายการ', tone: 'danger', to: { href: '/liff/tasks', inLiff: true } },
          { key: 'POOL', text: 'บรรทัดรอจัดซื้อ 3 บรรทัด', tone: 'neutral', to: { href: '/procurement/pool', inLiff: false } },
        ]}
      />,
    )
    expect(html).toContain('<ul aria-label="สิ่งที่คุณต้องทำ"')
    expect(html).toMatch(/<a href="\/liff\/tasks"[^>]*>งานอนุมัติเกินกำหนด 2 รายการ<\/a>/)
    expect(html).toMatch(/<a href="\/procurement\/pool"[^>]*>บรรทัดรอจัดซื้อ 3 บรรทัด<span class="sr-only"> \(เปิดในเบราว์เซอร์นอก LINE\)<\/span><\/a>/)
  })
})

describe('[FR-LINE-302/AC3] a part that could not load', () => {
  it('says so inside itself as an alert, with a button to try again', () => {
    const html = renderToStaticMarkup(<LiffHomeError title="โหลดส่วนรอฉันอนุมัติไม่สำเร็จ" hint="ส่วนอื่นยังใช้ได้ตามปกติ" retry="ลองใหม่" />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('โหลดส่วนรอฉันอนุมัติไม่สำเร็จ')
    expect(html).toMatch(/<button type="button"[^>]*>ลองใหม่<\/button>/)
  })
})

describe('[FR-LINE-302/AC4] a member with nothing waiting', () => {
  it('is told so with the start of a request (when they may make one) and their own requests', () => {
    const mine = { href: '/liff/track', label: 'ดูคำขอของฉัน' }
    const can = renderToStaticMarkup(<LiffHomeEmpty title="ไม่มีงานที่ต้องทำตอนนี้" hint="…" start={{ href: '/liff/requests/new', label: 'เริ่มคำขอใหม่' }} mine={mine} />)
    expect(can).toMatch(/<a href="\/liff\/requests\/new"[^>]*>เริ่มคำขอใหม่<\/a>/)
    expect(can).toMatch(/<a href="\/liff\/track"[^>]*>ดูคำขอของฉัน<\/a>/)
    const cannot = renderToStaticMarkup(<LiffHomeEmpty title="ไม่มีงานที่ต้องทำตอนนี้" hint="…" start={null} mine={mine} />)
    expect(cannot).not.toContain('/liff/requests/new')
  })
})

describe('[FR-LINE-302/AC5] "รอฉันอนุมัติ" lists the tasks waiting, REVIEW tasks among them', () => {
  const labels = { list: 'งานรอฉันอนุมัติทั้งหมด', summary: 'ทั้งหมด 1 งาน · เกินกำหนด 0 · รอผู้ขอตอบ 0', empty: 'ยังไม่มีงานรออนุมัติ', all: { href: '/liff/tasks', text: 'ดูงานรออนุมัติทั้งหมด (1 งาน)' } }

  it('each row opens its LIFF decision page, with its SLA as the badge of §9.10', () => {
    const html = renderToStaticMarkup(
      <LiffApprovalsList
        labels={labels}
        data={{ count: 1, overdue: 0, info: 0, rows: [{ id: ID, href: `/liff/tasks/${ID}`, title: 'PR-2569-00012 · งานเหมาก่อสร้างอาคารเก็บของ', kindLabel: 'คำขอ', meta: 'ผู้จัดการโครงการ · ก่อสร้าง', amount: null, sla: { key: 'OPEN', label: 'ยังไม่ถึงกำหนด' }, forName: null }] }}
      />,
    )
    expect(html).toContain('ทั้งหมด 1 งาน · เกินกำหนด 0 · รอผู้ขอตอบ 0')
    expect(html).toMatch(new RegExp(`<a href="/liff/tasks/${ID}"[^>]*>PR-2569-00012 · งานเหมาก่อสร้างอาคารเก็บของ</a>`))
    expect(html).toContain('ยังไม่ถึงกำหนด')
    expect(html).toMatch(/<a href="\/liff\/tasks"[^>]*>ดูงานรออนุมัติทั้งหมด \(1 งาน\)<\/a>/)
  })

  it('none waiting: the line that says so, no list', () => {
    const html = renderToStaticMarkup(<LiffApprovalsList labels={{ ...labels, all: null }} data={{ count: 0, overdue: 0, info: 0, rows: [] }} />)
    expect(html).toBe('<p class="text-ink-muted">ยังไม่มีงานรออนุมัติ</p>')
  })
})
