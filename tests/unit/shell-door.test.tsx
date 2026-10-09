import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestCatalog } from '@/ui/request-form/catalog'
import { RequestForm, SentConfirmation, type RequestFormActions } from '@/ui/request-form/request-form'
import type { RequestFormData } from '@/ui/request-form/types'
import { currentHref, type NavEntry } from '@/ui/shell/nav-links'
import { DOOR_ASIDE, DOOR_HIDDEN } from '@/ui/shell/new-request-door'
import { NotificationBell } from '@/ui/shell/notification-bell'
import { trailOf } from '@/ui/shell/shell-breadcrumb'
import { isDocumentPage } from '@/ui/shell/shell-frame'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import th from '../../messages/th.json'

// FR-PLT-002 AC1 and FR-PLT-013 AC2 AC3 with §9.9 principle 2 ("ประตูเดียว"): the sidebar marks the one page the member
// is on and names every entry for a collapsed sidebar; the top bar holds the search, the bell, the door to a new request
// — "ขอซื้อ / ขอจ้าง" as the main button — and the user menu, on every page, the door for a member who may create
// requests, except while the page shows the door's own content: the catalogue and the form, at whatever address the
// form has (a new form moves to /requests/[id]/edit with its first save). The confirmation once sent has no form, and
// the door is back. The bell and the user menu open one at a time.

const path = vi.hoisted(() => ({ now: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => path.now }))

const entry = (key: string, href: string, label: string, group = 'main', groupLabel = ''): NavEntry => ({ key, href, label, group, groupLabel })
const NAV: NavEntry[] = [entry('home', '/', 'หน้าแรก'), entry('newRequest', '/requests/new', 'ขอซื้อ / ขอจ้าง'), entry('requests', '/requests', 'คำขอ'), entry('tasks', '/tasks', 'งานอนุมัติ')]
/** The sidebar of §9.10: no door in it (the door is the top bar's), a named group, and the footer's hubs */
const SIDEBAR: NavEntry[] = [
  entry('home', '/', 'หน้าแรก'),
  entry('tasks', '/tasks', 'งานอนุมัติ'),
  entry('requests', '/requests', 'คำขอ'),
  entry('pool', '/procurement/pool', 'กองรอจัดซื้อ', 'procurement', 'จัดซื้อ'),
  entry('settings', '/settings', 'ตั้งค่าของฉัน', 'footer'),
]
const DOOR = { href: '/requests/new', label: 'ขอซื้อ / ขอจ้าง' }

/** The links of the markup, each with whether it is marked as the current page */
const links = (html: string) =>
  [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1]!)?.[1],
    current: m[1]!.includes('aria-current="page"'),
    label: /aria-label="([^"]*)"/.exec(m[1]!)?.[1],
    text: m[2]!.replace(/<[^>]+>/g, ''),
  }))
/** The classes of the links to an address */
const classesOf = (html: string, href: string) =>
  [...html.matchAll(/<a ([^>]*)>/g)].filter((m) => m[1]!.includes(`href="${href}"`)).map((m) => new Set((/class="([^"]*)"/.exec(m[1]!)?.[1] ?? '').split(/\s+/)))
const NAV_RE = /<nav aria-label="เมนูหลัก"[^>]*>[\s\S]*?<\/nav>/g
const headerOf = (html: string) => /<header[^>]*>[\s\S]*?<\/header>/.exec(html)?.[0] ?? ''

const shell = (newRequest?: { href: string; label: string }, extra: { bell?: ReactNode; search?: ReactNode } = {}) =>
  intl(
    <WorkspaceShell
      brand="BCS"
      orgName="DEMO"
      labels={{ skipToContent: 'ข้ามไปเนื้อหา', mainNav: 'เมนูหลัก', account: 'บัญชีของฉัน' }}
      nav={SIDEBAR}
      sidebarOpen
      user={{ name: 'เข้าระบบในชื่อ สมชาย ใจดี', detail: 'DEMO' }}
      account={null}
      newRequest={newRequest}
      {...extra}
    >
      <h1>หน้า</h1>
    </WorkspaceShell>,
  )

beforeEach(() => {
  path.now = '/'
})

describe('[FR-PLT-002/AC1] the menu marks the one page the member is on', () => {
  it.each<[string, string | null]>([
    ['/', '/'],
    ['/requests/new', '/requests/new'],
    ['/requests/new/BUY_GOODS', '/requests/new'],
    ['/requests', '/requests'],
    ['/requests/0199aaaa-0000-7000-8000-000000000001', '/requests'],
    ['/requests/0199aaaa-0000-7000-8000-000000000001/edit', '/requests'],
    ['/tasks/0199aaaa-0000-7000-8000-000000000002', '/tasks'],
    ['/budgets', null],
  ])('%s marks %s', (pathname, marked) => {
    expect(currentHref(pathname, NAV)).toBe(marked)
  })

  it('the sidebar marks one entry with aria-current; a settings page marks its hub', () => {
    path.now = '/settings/pin'
    const marked = links((shell(DOOR).match(NAV_RE) ?? []).join('')).filter((l) => l.current)
    expect(marked.map((l) => l.href)).toEqual(['/settings'])
  })
})

describe('[FR-PLT-013/AC2] the sidebar of §9.10', () => {
  it('draws each entry with its icon and words, named by aria-label for the collapsed sidebar, in its groups', () => {
    path.now = '/tasks'
    const html = shell(DOOR)
    const nav = (html.match(NAV_RE) ?? []).join('')
    expect(links(nav).map((l) => [l.href, l.label, l.text])).toEqual(SIDEBAR.map((e) => [e.href, e.label, e.label]))
    expect(nav).toContain('>จัดซื้อ<')
    // Collapsible to icons, open as the member last left it
    expect(html).toContain('data-collapsible=""')
    expect(html).toContain('data-state="expanded"')
    expect(html).toMatch(/aria-label="ยุบหรือขยายเมนู"|>ยุบหรือขยายเมนู</)
  })

  it('a number beside an entry is read with the entry', () => {
    const html = intl(
      <WorkspaceShell
        brand="BCS"
        orgName="DEMO"
        labels={{ skipToContent: 'ข้าม', mainNav: 'เมนูหลัก', account: 'บัญชีของฉัน' }}
        nav={[{ ...entry('tasks', '/tasks', 'งานอนุมัติ'), count: { value: 3, label: 'เปิดอยู่ 3 งาน' } }]}
        sidebarOpen={false}
        user={{ name: 'สมชาย' }}
        account={null}
      >
        <h1>หน้า</h1>
      </WorkspaceShell>,
    )
    expect(links(html).find((l) => l.href === '/tasks')?.label).toBe('งานอนุมัติ · เปิดอยู่ 3 งาน')
    expect(html).toContain('data-state="collapsed"')
  })

  it.each<[string, boolean]>([
    ['/requests/0199aaaa-0000-7000-8000-000000000001', true],
    ['/tasks/0199aaaa-0000-7000-8000-000000000002', true],
    ['/procurement/pos/0199aaaa-0000-7000-8000-000000000003', true],
    ['/requests', false],
    ['/requests/new', false],
    ['/requests/new/BUY_GOODS', false],
    ['/requests/0199aaaa-0000-7000-8000-000000000001/edit', false],
    ['/procurement/pos', false],
    ['/', false],
  ])('%s is a document page (opens with the sidebar collapsed): %s', (pathname, document) => {
    expect(isDocumentPage(pathname)).toBe(document)
  })

  it('a document page opens collapsed even when the member left the sidebar open', () => {
    path.now = '/requests/0199aaaa-0000-7000-8000-000000000001'
    expect(shell(DOOR)).toContain('data-state="collapsed"')
  })
})

describe('[FR-PLT-013/AC3] the top bar', () => {
  it('holds the search, the bell, the door and the user menu', () => {
    path.now = '/tasks'
    const header = headerOf(shell(DOOR, { search: <button type="button">ค้นหา</button>, bell: <span data-bell="" /> }))
    expect(header).toContain('>ค้นหา<')
    expect(header).toContain('data-bell=""')
    expect(links(header).filter((l) => l.href === '/requests/new').map((l) => l.text)).toEqual(['ขอซื้อ / ขอจ้าง'])
    expect(header).toContain('aria-label="บัญชีของฉัน"')
  })

  it.each<[string, string[]]>([
    ['/', []],
    ['/tasks', []],
    ['/settings/pin', ['/settings', '/settings/pin']],
    ['/admin/doa/abc/edit', ['/admin', '/admin/doa']],
    ['/requests/abc', ['/requests']],
  ])('the trail of %s is %j', (pathname, hrefs) => {
    const pages = [
      { href: '/', label: 'หน้าแรก' },
      { href: '/requests', label: 'คำขอ' },
      { href: '/settings', label: 'ตั้งค่าของฉัน' },
      { href: '/settings/pin', label: 'PIN' },
      { href: '/admin', label: 'ผู้ดูแลองค์กร' },
      { href: '/admin/doa', label: 'DOA' },
    ]
    expect(trailOf(pathname, pages).map((s) => s.href)).toEqual(hrefs)
  })
})

describe('[FR-PLT-002/AC1] the door to a new request is the main button of every page (§9.9 principle 2)', () => {
  it('is drawn once, in the top bar outside the menu, as the main button', () => {
    path.now = '/tasks'
    const html = shell(DOOR)
    const doors = links(html.replace(NAV_RE, '')).filter((l) => l.href === '/requests/new')
    expect(doors.map((d) => d.text)).toEqual(['ขอซื้อ / ขอจ้าง'])
    // Drawn as the main button: a capsule with the primary fill and its text colour, 44 px high on a phone
    const outside = classesOf(headerOf(html), '/requests/new')
    expect(outside.map((c) => ['bg-primary', 'text-primary-foreground', 'rounded-full', 'min-h-11'].every((name) => c.has(name)))).toEqual([true])
  })

  it('is not drawn for a member whose menu has no door (one who may not create requests)', () => {
    path.now = '/tasks'
    expect(links(shell()).filter((l) => l.href === '/requests/new')).toEqual([])
  })

  it('steps aside while the page shows its own content, whatever the address: the shell hides it by what the page holds', () => {
    // The page's content decides, not its address: at every address, the form's two included, the door is drawn …
    for (const pathname of ['/requests/new', '/requests/new/BUY_GOODS', `/requests/${DRAFT_ID}/edit`, '/requests', '/requests/new-supplier', '/']) {
      path.now = pathname
      const html = shell(DOOR).replace(NAV_RE, '')
      expect(links(html).filter((l) => l.href === '/requests/new').length, pathname).toBe(1)
      // … in a wrapper that is hidden while the page holds DOOR_ASIDE
      const wrappers = [...html.matchAll(/<div data-door=""[^>]*class="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&').split(/\s+/))
      expect(wrappers, pathname).toHaveLength(1)
      for (const classes of wrappers) expect(classes, pathname).toContain(DOOR_HIDDEN)
    }
    // The rule's selector names the attribute the door's own content carries
    expect(DOOR_HIDDEN).toBe(`[body:has([${Object.keys(DOOR_ASIDE)[0]}])_&]:hidden`)
  })

  it('the catalogue and the form carry DOOR_ASIDE — the form at both its addresses — and the confirmation once sent does not', () => {
    const aside = (html: string) => html.includes(' data-door-aside=""')
    expect(aside(intl(<RequestCatalog types={[{ code: 'BUY_GOODS', name: 'ซื้อของ', description: null, documentType: 'PURCHASE_REQUEST' }]} drafts={[]} locale="th" />))).toBe(true)
    // A new form (/requests/new/[type]) and a draft opened again (/requests/[id]/edit): the same form, the same mark
    expect(aside(form(null))).toBe(true)
    expect(aside(form(DRAFT))).toBe(true)
    // Sent: the confirmation alone is on the page, so the door shows again for the next request
    const sent = intl(<SentConfirmation ref={null} sent={{ requestId: DRAFT_ID, view: { number: 'PR-2569-00001', waitingFor: [] } }} title="วัสดุ" kind="send" />)
    expect(sent).toContain('ส่งขออนุมัติแล้ว')
    expect(aside(sent)).toBe(false)
  })
})

const DRAFT_ID = '0199aaaa-0000-7000-8000-000000000001'

const intl = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="th" messages={th} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const DATA: RequestFormData = {
  type: { code: 'BUY_GOODS', name: 'ซื้อของ', description: null, documentType: 'PURCHASE_REQUEST' },
  form: { fields: [], visibility: [], rules: [], lines: {} },
  requesterDepartmentName: 'ฝ่ายก่อสร้าง',
  budgetLines: [],
  defaultBudgetLineId: null,
  vatRateBp: 700,
  attachmentKinds: ['OTHER'],
  draft: null,
}

const DRAFT: NonNullable<RequestFormData['draft']> = {
  requestId: DRAFT_ID,
  version: 1,
  status: 'DRAFT',
  title: 'วัสดุ',
  budgetLineId: null,
  priceIncludesVat: false,
  formData: {},
  lines: [],
  quotations: [],
  nonLowestQuoteReason: '',
  attachments: [],
  returnReason: null,
}

const ACTIONS: RequestFormActions = {
  preview: async () => ({ ok: false, code: 'FAILED' }),
  attach: async () => ({ ok: true }),
  detach: async () => ({ ok: true }),
  submit: async () => ({ ok: false, code: 'FAILED' }),
  downloadUrl: async () => null,
  requestUpload: async () => ({ ok: false, reason: 'FAILED' }),
  completeUpload: async () => ({ ok: false, reason: 'FAILED' }),
}

/** The request form as it first draws: a new one, or a draft opened again */
const form = (draft: RequestFormData['draft']) => intl(<RequestForm data={{ ...DATA, draft }} actions={ACTIONS} autosaveUrl="/requests/new/autosave" locale="th" backLink={draft ? 'toCatalog' : 'otherType'} />)

describe('[FR-NOTI-001/AC1] [FR-PLT-013/AC3] the shell’s panels open one at a time (§9.9: no modal over a modal)', () => {
  it('the bell and the user menu of the top bar are one group of details, so opening one closes the other', () => {
    path.now = '/tasks'
    const bell = (
      <NotificationBell
        items={[]}
        unread={2}
        labels={{ button: 'แจ้งเตือน', unreadCount: 'ยังไม่อ่าน 2 รายการ', panelTitle: 'การแจ้งเตือน', newItem: 'ใหม่', markAllRead: 'อ่านทั้งหมดแล้ว', empty: 'ยังไม่มีการแจ้งเตือน', emptyHint: 'งานใหม่จะแสดงที่นี่' }}
        openAction={async () => undefined}
        markAllReadAction={async () => undefined}
      />
    )
    const html = shell(DOOR, { bell })
    const panels = [...html.matchAll(/<details([^>]*)>/g)].map((m) => /\bname="([^"]*)"/.exec(m[1]!)?.[1])
    expect(panels).toHaveLength(2)
    expect(new Set(panels)).toEqual(new Set(['shell-panel']))
  })
})
