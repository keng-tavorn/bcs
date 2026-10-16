import { createTranslator } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { approvalsView, firstName, FOLLOWING_HREF, onTimeView, TODO_HREF, todoView, type HomeT } from '@/app/(workspace)/_tracking/home-present'
import { loadInvoiceFilters, loadPoFilters, loadRequestFilters, loadTaskFilters } from '@/app/(workspace)/_tracking/list-filters'
import type { ViewT } from '@/app/(workspace)/_tracking/present'
import type { TasksT } from '@/app/(workspace)/_tracking/rows'
import { countOf, figureOf } from '@/server/queries/on-time'
import type { InboxTaskDto } from '@/server/queries/tasks'
import type { OnTimeRowDto } from '@/server/services/home'
import { TODO_KEYS, TODO_TONE } from '@/server/services/home/todo-keys'
import { NuqsTestingAdapter } from 'nuqs/adapters/testing'
import { ApprovalsTabsInAddress } from '@/ui/home/approvals-tabs'
import { CardError } from '@/ui/home/card-error'
import { HomeCardSkeleton } from '@/ui/home/home-cards'
import { HomeHero } from '@/ui/home/home-hero'
import { TODO_SHOWN, TodoList } from '@/ui/home/todo-list'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S16-09 · the home page "งานของฉัน" as the reader sees it (spec §9.10, FR-VIS-006): every to-do row links to the list of
// exactly what it counts, with the filter in the address and read back the same by that list's page; the texts of §9.10
// in Thai and English; the greeting by first name; the chips; the on-time change in words with its arrow; the tab rows
// with the amount the DOA counted and "แทนคุณ…"; a card loading and a card failing on its own. The numbers themselves
// are the services', tested on the seed: tests/integration/home.test.ts.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

type Locale = 'th' | 'en'
const MESSAGES = { th, en } as const
const homeT = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'home' }) as unknown as HomeT
const tasksT = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'tasks' }) as unknown as TasksT
const viewT = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'requestView' }) as unknown as ViewT

describe('[FR-VIS-006/AC2] every to-do row opens the list of exactly what it counts (§9.10)', () => {
  it('the links of the table of §9.10, each with the filter of its count', () => {
    expect(TODO_HREF).toEqual({
      OVERDUE_TASKS: '/tasks?due=overdue',
      RETURNED: '/requests?status=returned&scope=mine',
      QUESTIONS: '/requests?scope=mine&info=open',
      RECEIVING: '/receiving',
      POOL: '/procurement/pool',
      PO_APPROVED: '/procurement/pos?status=approved',
      INVOICES: '/finance/invoices?gr=posted',
      EXPORTS: '/finance/exports',
      DRAFTS: '/requests?status=draft&scope=mine',
    })
    expect(FOLLOWING_HREF).toBe('/requests?scope=following')
  })

  it('each list’s page reads its link back as the filter the count used, a status in any case', () => {
    const query = (href: string) => new URLSearchParams(href.split('?')[1] ?? '')
    expect(loadTaskFilters(query(TODO_HREF.OVERDUE_TASKS))).toEqual({ due: 'overdue' })
    expect(loadRequestFilters(query(TODO_HREF.RETURNED))).toEqual({ q: null, status: 'RETURNED', scope: 'mine', info: null })
    expect(loadRequestFilters(query(TODO_HREF.QUESTIONS))).toEqual({ q: null, status: null, scope: 'mine', info: 'open' })
    expect(loadRequestFilters(query(TODO_HREF.DRAFTS))).toEqual({ q: null, status: 'DRAFT', scope: 'mine', info: null })
    expect(loadRequestFilters(query(FOLLOWING_HREF))).toMatchObject({ scope: 'following' })
    expect(loadPoFilters(query(TODO_HREF.PO_APPROVED))).toEqual({ q: null, status: 'APPROVED' })
    expect(loadInvoiceFilters(query(TODO_HREF.INVOICES))).toEqual({ q: null, gr: 'posted' })
    // links written before (upper case) still work; anything else is no filter
    expect(loadPoFilters(new URLSearchParams('status=PENDING_APPROVAL'))).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(loadRequestFilters(new URLSearchParams('status=nonsense&scope=everyone'))).toMatchObject({ status: null, scope: null })
  })

  it('the rows read as §9.10 writes them, with the count, in Thai and English', () => {
    const rows = TODO_KEYS.map((key) => ({ key, count: 3, tone: TODO_TONE[key] }))
    expect(todoView(homeT('th'), rows).map((r) => r.text)).toEqual([
      'งานอนุมัติเกินกำหนด 3 รายการ',
      'คำขอที่ถูกตีกลับรอแก้ 3 ใบ',
      'คำถามจากผู้อนุมัติรอคำตอบ 3 ข้อ',
      'PO รอตรวจรับ 3 ใบ',
      'บรรทัดรอจัดซื้อ 3 บรรทัด',
      'PO อนุมัติแล้วรอส่งผู้ขาย 3 ใบ',
      'ใบกำกับรอยืนยัน 3 PO',
      'พร้อมส่งออก Express 3 รายการ',
      'ร่างคำขอของฉัน 3 ใบ',
    ])
    expect(todoView(homeT('en'), [{ key: 'OVERDUE_TASKS', count: 1, tone: 'DANGER' }])[0]!.text).toBe('1 overdue approval task')
    expect(todoView(homeT('th'), rows).map((r) => r.tone)).toEqual(['danger', 'warn', 'warn', 'neutral', 'neutral', 'neutral', 'neutral', 'neutral', 'neutral'])
  })

  it('six rows at most, then "ดูทั้งหมด" for the rest; each row a link with its icon and words', () => {
    const rows = todoView(
      homeT('th'),
      TODO_KEYS.map((key) => ({ key, count: 2, tone: TODO_TONE[key] })),
    )
    const html = renderToStaticMarkup(<TodoList rows={rows} label="สิ่งที่คุณต้องทำ" more="ดูทั้งหมด (9 รายการ)" less="แสดงน้อยลง" />)
    expect(html.match(/<li /g)).toHaveLength(TODO_SHOWN)
    expect(html).toContain('href="/tasks?due=overdue"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('ดูทั้งหมด (9 รายการ)')
    expect(renderToStaticMarkup(<TodoList rows={rows.slice(0, 3)} label="x" more="m" less="l" />)).not.toContain('aria-expanded')
  })
})

describe('[FR-VIS-006/AC3] on-time rows: the percent, the change in words with an arrow, and where each opens', () => {
  const row = (key: OnTimeRowDto['key'], current: [number, number], previous: [number, number], insightsDepartmentId: string | null = null): OnTimeRowDto => ({
    key,
    figure: figureOf(countOf(...current), countOf(...previous)),
    insightsDepartmentId,
  })

  it('"80% · ลดลง 13 จุดจาก 30 วันก่อน" as §9.10 writes it; up, the same, or no change when there was nothing before', () => {
    const [down, up, same, fresh, none] = onTimeView(homeT('th'), [row('MINE', [8, 2], [14, 1]), row('ORG', [9, 1], [8, 2]), row('QUEUE', [1, 1], [2, 2]), row('DEPARTMENT', [3, 1], [0, 0], 'd-1'), row('ORG', [0, 0], [3, 0])])
    expect(down).toMatchObject({ label: 'งานของฉัน', value: '80%', delta: { direction: 'down', text: 'ลดลง 13 จุดจาก 30 วันก่อน' }, counts: 'ทัน 8 · ไม่ทัน 2', href: '/tasks?due=overdue' })
    expect(up).toMatchObject({ label: 'ทั้งองค์กร', value: '90%', delta: { direction: 'up', text: 'เพิ่มขึ้น 10 จุดจาก 30 วันก่อน' }, href: '/insights?range=30d' })
    expect(same).toMatchObject({ label: 'คิวจัดซื้อ', delta: { direction: 'same', text: 'เท่ากับ 30 วันก่อน' } })
    expect(fresh).toMatchObject({ label: 'แผนกของฉัน', value: '75%', delta: null, href: '/insights?range=30d&dept=d-1' })
    expect(none).toMatchObject({ value: null, none: 'ยังไม่มีงานใน 30 วันนี้' })
    expect(onTimeView(homeT('en'), [row('MINE', [8, 2], [14, 1])])[0]!.delta!.text).toBe('Down 13 points from the 30 days before')
  })
})

describe('[FR-VIS-006/AC5] the tabs of "รอฉันอนุมัติ": the amount the DOA counted, the SLA badge and "แทนคุณ…"', () => {
  const task = (over: Partial<InboxTaskDto>): InboxTaskDto => ({
    id: 't-1',
    status: 'OPEN',
    subjectType: 'REQUEST',
    subjectId: 'r-1',
    subject: {
      kind: 'REQUEST',
      requestId: 'r-1',
      number: 'PR-2569-00012',
      title: 'ปูนซีเมนต์',
      requester: { id: 'm-req', name: { th: 'สมชาย ใจดี', en: 'Somchai Jaidee' } },
      department: { id: 'd-con', code: 'CON', name: { th: 'ฝ่ายก่อสร้าง', en: 'Construction' }, isRoot: false },
      grossSatang: 4_500_000n,
      netSatang: 4_205_607n,
    },
    assignedAt: new Date('2026-10-05T03:00:00Z'),
    dueAt: new Date('2026-10-06T02:00:00Z'),
    waitingMinutes: 90,
    overdue: true,
    holding: { kind: 'FOR', member: { id: 'm-vp', name: { th: 'วีระ ปฏิบัติการ', en: 'Weera Patibatkarn' } } },
    stepUp: false,
    review: false,
    amountSatang: 4_205_607n,
    question: null,
    ...over,
  })
  const views = (tasks: InboxTaskDto[]) =>
    approvalsView(homeT('th'), tasksT('th'), viewT('th'), 'th', {
      all: { count: tasks.length, rows: tasks },
      overdue: { count: tasks.filter((t) => t.overdue).length, rows: tasks.filter((t) => t.overdue) },
      info: { count: 0, rows: [] },
    })

  it('a row: the kind, number and title, who asked from where, the DOA amount, its SLA and whom the member acts for', () => {
    const [all, overdue, info] = views([task({}), task({ id: 't-2', overdue: false, holding: null, dueAt: null })])
    expect(all!.label).toBe('ทั้งหมด (2)')
    expect(overdue!.label).toBe('เกินกำหนด (1)')
    expect(info).toMatchObject({ label: 'รอผู้ขอตอบ (0)', rows: [], empty: 'ไม่มีงานที่รอผู้ขอตอบ', seeAll: null })
    expect(all!.rows[0]).toMatchObject({
      href: '/tasks/t-1',
      kind: 'REQUEST',
      title: 'PR-2569-00012 · ปูนซีเมนต์',
      meta: 'สมชาย ใจดี · ฝ่ายก่อสร้าง',
      amount: 'ยอดตามฐาน DOA 42,056.07 บาท',
      sla: { key: 'OVERDUE', label: 'เกินกำหนด' },
      forName: 'แทนคุณวีระ',
    })
    expect(all!.rows[1]).toMatchObject({ sla: { key: 'OPEN', label: 'ยังไม่ถึงกำหนด' }, forName: null })
    expect(overdue!.seeAll).toEqual({ href: '/tasks?due=overdue', text: 'ดูงานที่เกินกำหนดทั้งหมด (1 งาน)' })
    const tabs = (query: string) =>
      renderToStaticMarkup(
        <NuqsTestingAdapter searchParams={query}>
          <ApprovalsTabsInAddress label="งานรอฉันอนุมัติแยกตามสถานะ" tabs={[all!, overdue!, info!]} />
        </NuqsTestingAdapter>,
      )
    const html = tabs('')
    expect(html).toContain('role="tablist"')
    // the tab chosen is in the address, so a link opens it (§9.10): none is "ทั้งหมด", ?approvals=overdue the overdue one
    expect(html).toMatch(/aria-selected="true"[^>]*>ทั้งหมด \(2\)/)
    expect(tabs('?approvals=overdue')).toMatch(/aria-selected="true"[^>]*>เกินกำหนด \(1\)/)
    expect(html).toContain('href="/tasks/t-1"')
    // no button to decide in the list: the decision page shows the amount, budget and DOA first (§9.9 ข้อ 5)
    expect(html).not.toMatch(/อนุมัติ<\/button>/)
  })

  it('a task waiting for the requester says so', () => {
    const [all] = views([task({ status: 'INFO_REQUESTED', overdue: false, holding: null })])
    expect(all!.rows[0]!.sla).toEqual({ key: 'INFO_REQUESTED', label: 'รอผู้ขอตอบ' })
  })
})

describe('[FR-VIS-006/AC1] the greeting, the search field and the three chips', () => {
  it('greets by the first word of the display name, in Thai and English (§9.10)', () => {
    expect(firstName('สมชาย ใจดี')).toBe('สมชาย')
    expect(homeT('th')('greeting', { name: firstName('สมชาย ใจดี') })).toBe('สวัสดี คุณสมชาย วันนี้ต้องการทำอะไร')
    expect(homeT('en')('greeting', { name: firstName('Somchai Jaidee') })).toBe('Hello Somchai. What would you like to do today?')
  })

  const texts = {
    greeting: 'สวัสดี คุณสมชาย วันนี้ต้องการทำอะไร',
    search: 'ค้นหาเลขเอกสาร ผู้ขาย หรือเมนู',
    shortcutMac: '⌘K',
    shortcutOther: 'Ctrl K',
    chips: { label: 'ทางลัดของหน้าแรก', mine: 'งานของฉัน', newRequest: 'เริ่มคำขอใหม่', suppliers: 'ผู้ขายและราคา' },
  }

  it('"งานของฉัน" is the view shown (pressed); "เริ่มคำขอใหม่" opens the dialog of FR-INT-010, a link to the catalogue without script; "ผู้ขายและราคา" the register', () => {
    const html = renderToStaticMarkup(<HomeHero texts={texts} canRequest />)
    expect(html).toContain('<h1 id="home-greeting"')
    expect(html).toContain('ค้นหาเลขเอกสาร ผู้ขาย หรือเมนู')
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*งานของฉัน/)
    expect(html).toMatch(/<a [^>]*aria-haspopup="dialog"[^>]*href="\/requests\/new"|<a [^>]*href="\/requests\/new"[^>]*aria-haspopup="dialog"/)
    expect(html).toContain('href="/suppliers"')
  })

  it('a member who may not create requests gets no chip to start one', () => {
    const html = renderToStaticMarkup(<HomeHero texts={texts} canRequest={false} />)
    expect(html).not.toContain('/requests/new')
    expect(html).toContain('ผู้ขายและราคา')
  })
})

describe('[FR-VIS-006/AC6] each card loads on its own and says in itself when it cannot', () => {
  it('a loading card keeps its title and says what loads, for screen readers', () => {
    const html = renderToStaticMarkup(<HomeCardSkeleton id="home-todo" title="สิ่งที่ต้องทำ" loading="กำลังโหลดสิ่งที่ต้องทำ" />)
    expect(html).toContain('สิ่งที่ต้องทำ</h2>')
    expect(html).toContain('role="status"')
    expect(html).toContain('กำลังโหลดสิ่งที่ต้องทำ')
  })

  it('a card that failed says what happened and offers to load it again', () => {
    const t = homeT('th')
    const html = renderToStaticMarkup(<CardError title={t('error.title', { card: t('cards.todo') })} hint={t('error.hint')} retry={t('error.retry')} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('โหลดการ์ดสิ่งที่ต้องทำไม่สำเร็จ')
    expect(html).toContain('โหลดการ์ดนี้อีกครั้ง')
  })
})
