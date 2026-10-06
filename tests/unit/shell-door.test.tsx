import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentHref, NavLinks, type NavEntry } from '@/ui/shell/nav-links'
import { atDoor } from '@/ui/shell/new-request-door'
import { NotificationBell } from '@/ui/shell/notification-bell'
import { WorkspaceShell } from '@/ui/shell/workspace-shell'

// FR-PLT-002 AC1 with §9.9 principle 2 ("ประตูเดียว"): the menu marks the one page the member is on, and the workspace shell
// shows the door to a new request — "ขอซื้อ / ขอจ้าง" as the main button — on every page, for a member whose menu has
// it (one who may create requests), except on the door's own pages. The phone's menu and the bell open one at a time.

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

  it('steps aside on its own pages: the catalogue and the form', () => {
    for (const [pathname, at] of [
      ['/requests/new', true],
      ['/requests/new/BUY_GOODS', true],
      ['/requests', false],
      ['/requests/new-supplier', false],
      ['/', false],
    ] as const) {
      expect(atDoor(pathname, DOOR.href), pathname).toBe(at)
      path.now = pathname
      expect(links(shell(DOOR).replace(/<nav[^>]*>[\s\S]*?<\/nav>/g, '')).filter((l) => l.href === '/requests/new').length, pathname).toBe(at ? 0 : 2)
    }
  })
})

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
