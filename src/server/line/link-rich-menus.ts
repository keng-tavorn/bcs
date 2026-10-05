import type { LineRichMenu, LineRichMenuBounds, LineRichMenuImageType } from '@/integrations/line'
import { LINE_RICH_MENU_HEIGHT_PX, LINE_RICH_MENU_IMAGE_MAX_BYTES, LINE_RICH_MENU_WIDTH_PX } from '@/lib/constants'
import { liffLink } from './webhook/messages'

// The two rich menus of §9.5 (FR-LINE-004): UNLINKED is the account's default, so everyone who has not linked sees
// "ผูกบัญชี" and "ช่วยเหลือ"; LINKED is linked to each member's LINE user once they link, with the four buttons
// "ขอซื้อ", "งานรออนุมัติ", "ติดตามสถานะ" and "ช่วยเหลือ". Every button opens a page of the LIFF app (§9.4) through the
// one deep-link helper (liffLink). One definition serves the requests to LINE (src/server/services/line-link) and the
// pictures drawn by `pnpm line:richmenu --images` (assets/line), so a tap always lands on the button it shows.

export const LINE_RICH_MENU_KINDS = ['UNLINKED', 'LINKED'] as const
export type LineRichMenuKind = (typeof LINE_RICH_MENU_KINDS)[number]

export interface LineRichMenuButton {
  readonly key: 'link' | 'help' | 'request' | 'tasks' | 'track'
  /** The LIFF page it opens (§9.4, §9.5) */
  readonly path: '/link' | '/help' | '/requests/new' | '/tasks' | '/track'
  /** The words on the picture (§9.5), also the action's label that LINE reads aloud */
  readonly label: string
  /** The one main action of the menu, drawn filled (§9.9: one emphasis per screen) */
  readonly primary: boolean
}

interface LineRichMenuLayout {
  readonly columns: number
  readonly rows: number
  /** Row by row, left to right */
  readonly buttons: readonly LineRichMenuButton[]
}

export const LINE_RICH_MENU_LAYOUTS: Readonly<Record<LineRichMenuKind, LineRichMenuLayout>> = {
  UNLINKED: {
    columns: 2,
    rows: 1,
    buttons: [
      { key: 'link', path: '/link', label: 'ผูกบัญชี', primary: true },
      { key: 'help', path: '/help', label: 'ช่วยเหลือ', primary: false },
    ],
  },
  LINKED: {
    columns: 2,
    rows: 2,
    buttons: [
      { key: 'request', path: '/requests/new', label: 'ขอซื้อ', primary: true },
      { key: 'tasks', path: '/tasks', label: 'งานรออนุมัติ', primary: false },
      { key: 'track', path: '/track', label: 'ติดตามสถานะ', primary: false },
      { key: 'help', path: '/help', label: 'ช่วยเหลือ', primary: false },
    ],
  },
}

/** Text of the bar under the chat that opens and closes the menu (LINE: at most 14 characters) */
export const LINE_RICH_MENU_CHAT_BAR_TEXT = 'เมนู BCS'

/** The picture of each menu in assets/line (2500 × 843 PNG, drawn by `pnpm line:richmenu --images`) */
export const LINE_RICH_MENU_IMAGE_FILES: Readonly<Record<LineRichMenuKind, string>> = {
  UNLINKED: 'richmenu-unlinked.png',
  LINKED: 'richmenu-linked.png',
}

export interface LineRichMenuCell {
  readonly button: LineRichMenuButton
  readonly bounds: LineRichMenuBounds
}

/** Where `index` of `count` equal parts of `total` starts; the last part takes what does not divide (843 = 421 + 422) */
const edge = (total: number, count: number, index: number) => Math.floor((total * index) / count)

/** The tappable area of every button: equal cells over the whole picture, no gaps */
export function lineRichMenuCells(kind: LineRichMenuKind): LineRichMenuCell[] {
  const layout = LINE_RICH_MENU_LAYOUTS[kind]
  return layout.buttons.map((button, i) => {
    const column = i % layout.columns
    const row = Math.floor(i / layout.columns)
    const x = edge(LINE_RICH_MENU_WIDTH_PX, layout.columns, column)
    const y = edge(LINE_RICH_MENU_HEIGHT_PX, layout.rows, row)
    return {
      button,
      bounds: {
        x,
        y,
        width: edge(LINE_RICH_MENU_WIDTH_PX, layout.columns, column + 1) - x,
        height: edge(LINE_RICH_MENU_HEIGHT_PX, layout.rows, row + 1) - y,
      },
    }
  })
}

/**
 * The name LINE keeps for a menu of this channel: "bcs:<channelKey>:<kind>:<made at, ms since 1970>". The channel key
 * (public, one per organization) keeps the menus of one organization apart from anything else made on the same LINE
 * account, so a replace takes down only what BCS made for this organization; the time lets it take down only what was
 * made before it, never the menus of a replace that started after it.
 */
export function lineRichMenuName(kind: LineRichMenuKind, channelKey: string, madeAt: Date): string {
  return `${lineRichMenuNamePrefix(channelKey)}${kind}:${madeAt.getTime()}`
}

export function lineRichMenuNamePrefix(channelKey: string): string {
  return `bcs:${channelKey}:`
}

/**
 * When a menu named by lineRichMenuName for this channel was made; 0 for a menu of this channel without a time (made
 * before names carried one, or by hand: older than anything a replace makes); null for a menu of anything else.
 */
export function lineRichMenuMadeAt(name: string, channelKey: string): number | null {
  const prefix = lineRichMenuNamePrefix(channelKey)
  if (!name.startsWith(prefix)) return null
  const at = /^(?:UNLINKED|LINKED):(\d{1,15})$/.exec(name.slice(prefix.length))?.[1]
  return at === undefined ? 0 : Number(at)
}

/** The rich menu object LINE takes (POST /v2/bot/richmenu) for the organization's LIFF app */
export function lineRichMenuDefinition(kind: LineRichMenuKind, channel: { readonly liffId: string; readonly channelKey: string }, madeAt: Date): LineRichMenu {
  return {
    size: { width: LINE_RICH_MENU_WIDTH_PX, height: LINE_RICH_MENU_HEIGHT_PX },
    // Shown open when the chat opens: the buttons are how BCS is used in LINE
    selected: true,
    name: lineRichMenuName(kind, channel.channelKey, madeAt),
    chatBarText: LINE_RICH_MENU_CHAT_BAR_TEXT,
    areas: lineRichMenuCells(kind).map(({ button, bounds }) => ({ bounds, action: { type: 'uri', label: button.label, uri: liffLink(channel.liffId, button.path) } })),
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Type and size of a PNG (its IHDR) or a JPEG (its first frame header); null when the bytes are neither */
export function richMenuImageInfo(bytes: Uint8Array): { readonly contentType: LineRichMenuImageType; readonly width: number; readonly height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return { contentType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1] ?? 0
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return { contentType: 'image/jpeg', height: view.getUint16(at + 5), width: view.getUint16(at + 7) }
      at += 2 + view.getUint16(at + 2)
    }
  }
  return null
}

export type RichMenuImageProblem = 'FORMAT' | 'SIZE' | 'TOO_LARGE'

/** Why LINE would refuse this picture for a BCS rich menu, or null when it fits (PNG or JPEG, 2500 × 843, ≤ 1 MB) */
export function richMenuImageProblem(bytes: Uint8Array): RichMenuImageProblem | null {
  if (bytes.length > LINE_RICH_MENU_IMAGE_MAX_BYTES) return 'TOO_LARGE'
  const info = richMenuImageInfo(bytes)
  if (!info) return 'FORMAT'
  return info.width === LINE_RICH_MENU_WIDTH_PX && info.height === LINE_RICH_MENU_HEIGHT_PX ? null : 'SIZE'
}
