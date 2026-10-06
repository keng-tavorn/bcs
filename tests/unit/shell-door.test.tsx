import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { twMerge } from 'tailwind-merge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestCatalog } from '@/ui/request-form/catalog'
import { RequestForm, SentConfirmation, type RequestFormActions } from '@/ui/request-form/request-form'
import type { RequestFormData } from '@/ui/request-form/types'
import { currentHref, NavLinks, type NavEntry } from '@/ui/shell/nav-links'
import { DOOR_ASIDE, DOOR_HIDDEN } from '@/ui/shell/new-request-door'
import { NotificationBell } from '@/ui/shell/notification-bell'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'
import th from '../../messages/th.json'

// FR-PLT-002 AC1 with §9.9 principle 2 ("ประตูเดียว"): the menu marks the one page the member is on, and the workspace shell
// shows the door to a new request — "ขอซื้อ / ขอจ้าง" as the main button — on every page, for a member whose menu has
// it (one who may create requests), except while the page shows the door's own content: the catalogue and the form, at
// whatever address the form has (a new form moves to /requests/[id]/edit with its first save). The confirmation once
// sent has no form, and the door is back. The phone's menu and the bell open one at a time.

const path = vi.hoisted(() => ({ now: '/' }))
vi.mock('next/navigation', () => ({ usePathname: () => path.now }))

const entry = (key: string, href: string, label: string): NavEntry => ({ key, href, label, group: 'work', groupLabel: 'งานของฉัน' })
const NAV: NavEntry[] = [entry('home', '/', 'หน้าแรก'), entry('newRequest', '/requests/new', 'ขอซื้อ / ขอจ้าง'), entry('requests', '/requests', 'คำขอ'), entry('tasks', '/tasks', 'งานรออนุมัติ')]
const DOOR = { href: '/requests/new', label: 'ขอซื้อ / ขอจ้าง' }

/** The links of the markup, each with whether it is marked as the current page */
const links = (html: string) => [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((m) => ({ href: /href="([^"]*)"/.exec(m[1]!)?.[1], current: m[1]!.includes('aria-current="page"'), text: m[2]!.replace(/<[^>]+>/g, '') }))
/** The classes of the links to an address */
const classesOf = (html: string, href: string) =>
  [...html.matchAll(/<a ([^>]*)>/g)].filter((m) => m[1]!.includes(`href="${href}"`)).map((m) => new Set((/class="([^"]*)"/.exec(m[1]!)?.[1] ?? '').split(/\s+/)))

const shell = (newRequest?: { href: string; label: string }) =>
  renderToStaticMarkup(
    <WorkspaceShell brand="BCS" orgName="DEMO" userLine="เข้าระบบในชื่อ สมชาย ใจดี" labels={{ skipToContent: 'ข้ามไปเนื้อหา', menu: 'เมนู', mainNav: 'เมนูหลัก' }} nav={NAV} account={null} newRequest={newRequest}>
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

  it('the request form marks "ขอซื้อ / ขอจ้าง" alone, not "คำขอ" as well', () => {
    path.now = '/requests/new/BUY_GOODS'
    const marked = links(renderToStaticMarkup(<NavLinks entries={NAV} />)).filter((l) => l.current)
    expect(marked).toEqual([{ href: '/requests/new', current: true, text: 'ขอซื้อ / ขอจ้าง' }])
  })
})

describe('[FR-PLT-002/AC1] the door to a new request is the main button of every page (§9.9 principle 2)', () => {
  it('is drawn twice — in the phone row under the header and in the bar beside the bell — outside the menu, as the main button', () => {
    path.now = '/tasks'
    const html = shell(DOOR)
    const nav = /<nav[^>]*>[\s\S]*?<\/nav>/g
    const doors = links(html.replace(nav, '')).filter((l) => l.href === '/requests/new')
    expect(doors.map((d) => d.text)).toEqual(['ขอซื้อ / ขอจ้าง', 'ขอซื้อ / ขอจ้าง'])
    // Drawn as the main button: the primary fill and its text colour, 44 px high
    const outside = classesOf(html.replace(nav, ''), '/requests/new')
    expect(outside.map((c) => ['bg-primary', 'text-primary-foreground', 'min-h-11'].every((name) => c.has(name)))).toEqual([true, true])
    // The menu keeps its own entry
    expect(links((html.match(nav) ?? []).join('')).filter((l) => l.href === '/requests/new').length).toBeGreaterThan(0)
  })

  it('is not drawn for a member whose menu has no door (one who may not create requests)', () => {
    path.now = '/tasks'
    expect(links(shell().replace(/<nav[^>]*>[\s\S]*?<\/nav>/g, '')).filter((l) => l.href === '/requests/new')).toEqual([])
  })

  it('steps aside while the page shows its own content, whatever the address: the shell hides it by what the page holds', () => {
    // The page's content decides, not its address: at every address, the form's two included, both doors are drawn …
    for (const pathname of ['/requests/new', '/requests/new/BUY_GOODS', `/requests/${DRAFT_ID}/edit`, '/requests', '/requests/new-supplier', '/']) {
      path.now = pathname
      const html = shell(DOOR).replace(/<nav[^>]*>[\s\S]*?<\/nav>/g, '')
      expect(links(html).filter((l) => l.href === '/requests/new').length, pathname).toBe(2)
      // … each in a wrapper — the phone's row too — that is hidden while the page holds DOOR_ASIDE
      const wrappers = [...html.matchAll(/<div data-door=""[^>]*class="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&').split(/\s+/))
      expect(wrappers, pathname).toHaveLength(2)
      for (const classes of wrappers) expect(classes, pathname).toContain(DOOR_HIDDEN)
    }
    // The rule's selector names the attribute the door's own content carries, and the shell's classes keep it
    expect(DOOR_HIDDEN).toBe(`[body:has([${Object.keys(DOOR_ASIDE)[0]}])_&]:hidden`)
    expect(twMerge('border-b border-line bg-surface px-4 py-2 lg:hidden', DOOR_HIDDEN).split(' ')).toContain(DOOR_HIDDEN)
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

describe('[FR-NOTI-001/AC1] [FR-PLT-002/AC1] the shell’s panels open one at a time (§9.9: no modal over a modal)', () => {
  it('the phone’s menu and the bell — in the phone’s header and beside the door — are one group of details, so opening one closes the other', () => {
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
    const html = renderToStaticMarkup(
      <WorkspaceShell brand="BCS" orgName="DEMO" userLine="เข้าระบบในชื่อ สมชาย ใจดี" labels={{ skipToContent: 'ข้ามไปเนื้อหา', menu: 'เมนู', mainNav: 'เมนูหลัก' }} nav={NAV} account={null} bell={bell} newRequest={DOOR}>
        <h1>หน้า</h1>
      </WorkspaceShell>,
    )
    const panels = [...html.matchAll(/<details([^>]*)>/g)].map((m) => /\bname="([^"]*)"/.exec(m[1]!)?.[1])
    expect(panels).toHaveLength(3)
    expect(new Set(panels)).toEqual(new Set(['shell-panel']))
  })
})
