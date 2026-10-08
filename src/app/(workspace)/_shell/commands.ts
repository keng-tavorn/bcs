import type { MenuKey } from './menu'

// The ⌘K palette's "ไปที่หน้า" and "คำสั่ง" groups (FR-PLT-014 AC4, §9.10): pages are exactly the entries of the
// member's menu (visibleMenu), and a command is offered only when the page it opens is in that menu — "เริ่มคำขอ
// <ประเภท>" only for the request types that are switched on (listRequestCatalog: active, with a published form).
// Offering is convenience: every page and service checks permissions again (BR-AUTH-05).

export interface PaletteNavEntry {
  readonly key: MenuKey
  readonly href: string
  readonly label: string
}

export interface PaletteCommand {
  readonly id: string
  readonly label: string
  readonly href: string
}

export interface PaletteCommandLabels {
  readonly startRequest: (typeName: string) => string
  readonly delegate: string
  readonly linkLine: string
  readonly overdue: string
}

/** The commands of this member: what their menu reaches, the request types the organization has on */
export function paletteCommands(nav: readonly PaletteNavEntry[], requestTypes: ReadonlyArray<{ readonly code: string; readonly name: string }>, labels: PaletteCommandLabels): PaletteCommand[] {
  const has = (key: MenuKey) => nav.some((item) => item.key === key)
  return [
    ...(has('newRequest') ? requestTypes.map((t) => ({ id: `start:${t.code}`, label: labels.startRequest(t.name), href: `/requests/new/${encodeURIComponent(t.code)}` })) : []),
    ...(has('delegation') ? [{ id: 'delegate', label: labels.delegate, href: '/settings/delegation' }] : []),
    ...(has('lineLink') ? [{ id: 'linkLine', label: labels.linkLine, href: '/settings/line' }] : []),
    // The inbox lists the tasks due first at the top, with how long each has waited
    ...(has('tasks') ? [{ id: 'overdue', label: labels.overdue, href: '/tasks' }] : []),
  ]
}
