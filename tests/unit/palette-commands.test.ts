import { describe, expect, it } from 'vitest'
import { paletteCommands } from '@/app/(workspace)/_shell/commands'
import { visibleMenu } from '@/app/(workspace)/_shell/menu'
import { memberPrincipal } from '@/server/authz'
import { STORED_ROLES, type StoredRole } from '@/server/authz/permissions'

// S16-03 · FR-PLT-014 AC4: the palette's "ไปที่หน้า" are the member's menu entries and nothing else, and every command
// opens a page of that menu — "เริ่มคำขอ <ประเภท>" only for the request types that are on (the layout passes
// listRequestCatalog: active types with a published form), and nothing at all for a member whose menu lacks the door.

const LABELS = { startRequest: (name: string) => `เริ่มคำขอ ${name}`, delegate: 'ตั้งรักษาการ', linkLine: 'ผูก LINE', overdue: 'ดูงานเกินกำหนด' }
const TYPES = [
  { code: 'BUY_GOODS', name: 'ซื้อของ' },
  { code: 'HIRE_SERVICE', name: 'จ้างบริการ' },
]
const navOf = (roles: StoredRole[], modules: Array<'CORE'> = ['CORE']) =>
  visibleMenu(memberPrincipal('m-1', roles), modules, true).map((item) => ({ key: item.key, href: item.href, label: item.key }))

describe('[FR-PLT-014/AC4] commands and pages follow the menu the member sees', () => {
  it('offers to start only the request types that are on, each opening its form', () => {
    const commands = paletteCommands(navOf([]), TYPES, LABELS)
    expect(commands.filter((c) => c.id.startsWith('start:')).map((c) => [c.label, c.href])).toEqual([
      ['เริ่มคำขอ ซื้อของ', '/requests/new/BUY_GOODS'],
      ['เริ่มคำขอ จ้างบริการ', '/requests/new/HIRE_SERVICE'],
    ])
    expect(paletteCommands(navOf([]), [], LABELS).some((c) => c.id.startsWith('start:'))).toBe(false)
  })

  it('every command of every role opens a page that role has in its menu', () => {
    for (const roles of [[], ...STORED_ROLES.map((r) => [r])] as StoredRole[][]) {
      const nav = navOf(roles)
      const hrefs = new Set(nav.map((n) => n.href))
      for (const c of paletteCommands(nav, TYPES, LABELS)) {
        const page = c.id.startsWith('start:') ? '/requests/new' : c.href
        expect(hrefs.has(page), `${roles.join(',') || 'member'} · ${c.id}`).toBe(true)
      }
    }
  })

  it('offers nothing a member without the module may not reach', () => {
    const nav = navOf([], [])
    const commands = paletteCommands(nav, TYPES, LABELS)
    expect(commands.map((c) => c.id)).toEqual(['linkLine'])
    expect(nav.map((n) => n.key)).not.toContain('newRequest')
  })
})
