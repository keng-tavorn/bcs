// pnpm line:richmenu — the two rich menus of §9.5 for an organization's LINE account (D-02, S5-04, FR-LINE-004):
//   pnpm line:richmenu                 makes both menus at LINE from assets/line, sets UNLINKED as the account's default,
//                                      moves every linked member to the new LINKED menu, stores both ids on the
//                                      organization's LINE channel and takes down the menus made before
//   pnpm line:richmenu --org <code>    the same for the organization with this code (needed when several have LINE)
//   pnpm line:richmenu --images        draws assets/line/richmenu-unlinked.png and richmenu-linked.png again
// The menus are made through the organization's own channel (its sealed access token, src/server/services/line-channel)
// by command organization.store_line_rich_menus, as the organization's first active ORG_ADMIN on channel SYSTEM, like
// the seed does (event organization.settings_updated, section lineRichMenu). It runs on this machine only
// (APP_ENV=local), against the fake LINE server (pnpm line:fake, LINE_API_BASE_URL): anywhere else the event would show
// a run of BCS's as that customer admin's own act, so on staging and production the admin presses the button on
// /admin/line, which runs the same command as themself. Prints what was done — never the access token.
// The pictures are drawn reproducibly: the labels of §9.5 in Sarabun (assets/fonts/sarabun) and Lucide icons
// (lucide-react, read from node_modules), laid out by react-pdf on a 2500 × 843 pt page with the areas of
// src/server/line/link-rich-menus.ts, then rasterized at 72 dpi by poppler in the pdf-raster image of docker-compose
// (the same pixels on every machine; tests/integration/line-richmenu-images.test.ts draws them again and compares).
// Sarabun, the PDF typeface, because it is the Thai font kept in the repo: §9.9 sets IBM Plex Sans Thai for the web and
// LIFF, which the web loads from Google Fonts at build time; drawing these in it needs its OFL files under assets/fonts
// first (an exception recorded for the ADR of S5-04).
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Circle, Document, Font, Page, Path, Rect, renderToBuffer, Svg, Text, View, type DocumentProps } from '@react-pdf/renderer'
import { createElement as h, type ReactElement } from 'react'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { LINE_RICH_MENU_HEIGHT_PX, LINE_RICH_MENU_WIDTH_PX } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { LINE_RICH_MENU_IMAGE_FILES, LINE_RICH_MENU_KINDS, lineRichMenuCells, richMenuImageProblem, type LineRichMenuButton, type LineRichMenuKind } from '@/server/line/link-rich-menus'
import { readLineRichMenuImages, replaceLineRichMenus, type LineRichMenuImages, type LineRichMenusReplaced } from '@/server/services/line-link'

// ---------- the pictures ----------

/** §9.9 tokens: white ground, ink text, thin rules, the primary colour for the one main action and the icons */
const COLORS = { ground: '#FFFFFF', ink: '#1C2B33', rule: '#DDE3E7', primary: '#0B6E5F', onPrimary: '#FFFFFF' } as const
const RULE_WIDTH = 6
const FONT_FAMILY = 'Sarabun'
/** Lucide icon of each button (lucide-react, ISC licence; the outlines are read from the installed package) */
const ICONS: Readonly<Record<LineRichMenuButton['key'], string>> = {
  link: 'link',
  help: 'circle-question-mark',
  request: 'shopping-cart',
  tasks: 'clipboard-check',
  track: 'package-search',
}
/** Icon and label sizes (points = pixels at 72 dpi): one column of two for UNLINKED, a 2 × 2 grid for LINKED */
const SIZES: Readonly<Record<LineRichMenuKind, { readonly icon: number; readonly font: number; readonly gap: number; readonly direction: 'column' | 'row' }>> = {
  UNLINKED: { icon: 230, font: 128, gap: 40, direction: 'column' },
  LINKED: { icon: 170, font: 112, gap: 52, direction: 'row' },
}
const DPI = '72'
const RASTER_IMAGE = 'bcs-pdf-raster:bookworm'

const IconNode = z.array(z.tuple([z.enum(['path', 'circle', 'rect']), z.record(z.string(), z.string())]))
type IconNode = z.infer<typeof IconNode>

async function lucideIcon(name: string): Promise<IconNode> {
  const file = path.join(process.cwd(), 'node_modules', 'lucide-react', 'dist', 'esm', 'icons', `${name}.mjs`)
  const loaded = (await import(pathToFileURL(file).href)) as { __iconData?: { node?: unknown } }
  return IconNode.parse(loaded.__iconData?.node)
}

function icon(node: IconNode, size: number, color: string): ReactElement {
  const stroke = { stroke: color, strokeWidth: 2, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  const num = (attrs: Record<string, string>, key: string) => (attrs[key] === undefined ? undefined : Number(attrs[key]))
  return h(
    Svg,
    { width: size, height: size, viewBox: '0 0 24 24' },
    ...node.map(([tag, attrs], i) => {
      if (tag === 'path') return h(Path, { key: i, d: attrs.d ?? '', ...stroke })
      if (tag === 'circle') return h(Circle, { key: i, cx: num(attrs, 'cx'), cy: num(attrs, 'cy'), r: num(attrs, 'r') ?? 0, ...stroke })
      return h(Rect, { key: i, x: num(attrs, 'x'), y: num(attrs, 'y'), width: num(attrs, 'width') ?? 0, height: num(attrs, 'height') ?? 0, rx: num(attrs, 'rx'), ry: num(attrs, 'ry'), ...stroke })
    }),
  )
}

async function menuDocument(kind: LineRichMenuKind): Promise<ReactElement<DocumentProps>> {
  const size = SIZES[kind]
  const cells = lineRichMenuCells(kind)
  const icons = await Promise.all(cells.map(({ button }) => lucideIcon(ICONS[button.key])))
  const rules: ReactElement[] = [h(View, { key: 'top', style: { position: 'absolute', left: 0, top: 0, width: LINE_RICH_MENU_WIDTH_PX, height: RULE_WIDTH, backgroundColor: COLORS.rule } })]
  for (const { bounds } of cells) {
    if (bounds.x > 0) rules.push(h(View, { key: `v${bounds.x}.${bounds.y}`, style: { position: 'absolute', left: bounds.x - RULE_WIDTH / 2, top: bounds.y, width: RULE_WIDTH, height: bounds.height, backgroundColor: COLORS.rule } }))
    if (bounds.y > 0) rules.push(h(View, { key: `h${bounds.x}.${bounds.y}`, style: { position: 'absolute', left: bounds.x, top: bounds.y - RULE_WIDTH / 2, width: bounds.width, height: RULE_WIDTH, backgroundColor: COLORS.rule } }))
  }
  return h(
    Document,
    { title: `BCS rich menu ${kind}`, author: 'BCS', creator: 'pnpm line:richmenu', producer: 'pnpm line:richmenu' },
    h(
      Page,
      { size: [LINE_RICH_MENU_WIDTH_PX, LINE_RICH_MENU_HEIGHT_PX], style: { backgroundColor: COLORS.ground, fontFamily: FONT_FAMILY } },
      ...cells.map(({ button, bounds }, i) =>
        h(
          View,
          {
            key: button.key,
            style: {
              position: 'absolute',
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: bounds.height,
              backgroundColor: button.primary ? COLORS.primary : COLORS.ground,
              flexDirection: size.direction,
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          icon(icons[i]!, size.icon, button.primary ? COLORS.onPrimary : COLORS.primary),
          h(View, { style: size.direction === 'column' ? { height: size.gap } : { width: size.gap } }),
          h(Text, { style: { fontSize: size.font, fontWeight: 700, lineHeight: 1.3, color: button.primary ? COLORS.onPrimary : COLORS.ink } }, button.label),
        ),
      ),
      ...rules,
    ),
  )
}

let fontRegistered = false
function registerFont(): void {
  if (fontRegistered) return
  Font.register({ family: FONT_FAMILY, fonts: [{ src: path.join(process.cwd(), 'assets', 'fonts', 'sarabun', 'Sarabun-Bold.ttf'), fontWeight: 700 }] })
  // A label never breaks: one word each, laid out on one line
  Font.registerHyphenationCallback((word) => [word])
  fontRegistered = true
}

function ensureRasterImage(): void {
  if (spawnSync('docker', ['image', 'inspect', RASTER_IMAGE], { encoding: 'utf8' }).status === 0) return
  const built = spawnSync('docker', ['compose', '--profile', 'tools', 'build', 'pdf-raster'], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error(`could not build ${RASTER_IMAGE} (is Docker Desktop running?):\n${built.stderr}`)
}

/** The picture of one menu as PNG bytes, drawn the same way on every machine */
export async function drawLineRichMenuImage(kind: LineRichMenuKind): Promise<Buffer> {
  registerFont()
  const pdf = await renderToBuffer(await menuDocument(kind))
  ensureRasterImage()
  const r = spawnSync('docker', ['run', '--rm', '-i', RASTER_IMAGE, 'pdftoppm', '-r', DPI, '-png', '-singlefile', '-'], { input: pdf, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr.toString()}`)
  const problem = richMenuImageProblem(r.stdout)
  if (problem) throw new Error(`the ${kind} picture is not a rich menu image LINE takes (${problem})`)
  return r.stdout
}

/** Draws both pictures into `dir` (assets/line by default) */
export async function writeLineRichMenuImages(dir: string = path.join(process.cwd(), 'assets', 'line')): Promise<Record<LineRichMenuKind, { readonly file: string; readonly bytes: number }>> {
  await mkdir(dir, { recursive: true })
  const written = {} as Record<LineRichMenuKind, { file: string; bytes: number }>
  for (const kind of LINE_RICH_MENU_KINDS) {
    const png = await drawLineRichMenuImage(kind)
    const file = path.join(dir, LINE_RICH_MENU_IMAGE_FILES[kind])
    await writeFile(file, png)
    written[kind] = { file, bytes: png.length }
  }
  return written
}

// ---------- the menus at LINE ----------

export type LineRichMenuRun =
  | { readonly ok: true; readonly organizationCode: string; readonly report: LineRichMenusReplaced }
  | { readonly ok: false; readonly problem: string }

/** The organization the menus are for: --org, or the only one with a LINE channel */
async function organizationOf(code: string | null): Promise<{ id: string; code: string } | string> {
  const withLine = await prisma.organization.findMany({
    where: { lineChannelConfig: { isNot: null }, ...(code === null ? {} : { code }) },
    select: { id: true, code: true },
    orderBy: { code: 'asc' },
  })
  if (withLine.length === 0) {
    return code === null
      ? 'ยังไม่มีองค์กรที่บันทึกค่า LINE channel — ใส่ LINE_* ใน .env แล้วรัน pnpm db:seed หรือบันทึกที่หน้าตั้งค่า LINE'
      : `องค์กร ${code} ยังไม่มีค่า LINE channel (หรือไม่มีองค์กรรหัสนี้)`
  }
  if (withLine.length > 1) return `มี LINE channel หลายองค์กร (${withLine.map((o) => o.code).join(', ')}) — ระบุ --org`
  return withLine[0]!
}

/**
 * Makes and stores both menus for the organization, as its first active ORG_ADMIN (what `pnpm line:richmenu` runs).
 * APP_ENV=local only: refused before anything is read or made anywhere else.
 */
export async function runLineRichMenu(options: { readonly org: string | null; readonly appEnv?: string; readonly images?: LineRichMenuImages; readonly now?: Date }): Promise<LineRichMenuRun> {
  const appEnv = options.appEnv ?? getEnv().APP_ENV
  if (appEnv !== 'local') {
    return {
      ok: false,
      problem: `ใช้ได้เฉพาะบนเครื่อง (APP_ENV=local · ตอนนี้ ${appEnv}) — บน staging และ production ให้ผู้ดูแลองค์กรกดปุ่ม "สร้าง rich menu" ในหน้าตั้งค่า LINE (/admin/line) ซึ่งบันทึกเป็นการกระทำของผู้ดูแลคนนั้นเอง`,
    }
  }
  const organization = await organizationOf(options.org)
  if (typeof organization === 'string') return { ok: false, problem: organization }
  const admin = await prisma.roleAssignment.findFirst({
    where: { organizationId: organization.id, role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } },
    orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
    select: { memberId: true },
  })
  if (!admin) return { ok: false, problem: `องค์กร ${organization.code} ไม่มีผู้ดูแลองค์กร (ORG_ADMIN) ที่ใช้งานอยู่` }
  const ctx = makeCtx({ organizationId: organization.id, actor: { type: 'USER', memberId: admin.memberId }, channel: 'SYSTEM', now: options.now ?? systemClock.now() })
  const images = options.images ?? (await readLineRichMenuImages())
  // The event goes out with the outbox-sweeper: a script has no Inngest to tell right now
  const result = await replaceLineRichMenus(ctx, images, { idempotencyKey: randomUUID(), sender: null })
  if (!result.ok) {
    const { code, details } = result.error
    const what = [details?.field, details?.reason, details?.operation, details?.status].filter((v) => v !== undefined && v !== null).join(' · ')
    return { ok: false, problem: `${code}${what ? ` (${what})` : ''}` }
  }
  return { ok: true, organizationCode: organization.code, report: result.data }
}

/** Thai lines for the console (ids of rich menus are not secret) */
export function describeLineRichMenuRun(run: Extract<LineRichMenuRun, { ok: true }>): string[] {
  const r = run.report
  return [
    `line:richmenu เสร็จ: องค์กร ${run.organizationCode} · ${r.replaced ? 'แทนที่ชุดเดิมแล้ว' : 'สร้างครั้งแรก'}`,
    `  UNLINKED ${r.unlinkedId} · ${r.defaultSet ? 'ตั้งเป็นเมนูเริ่มต้นแล้ว' : 'ยังตั้งเป็นเมนูเริ่มต้นไม่ได้ — รันอีกครั้ง'}`,
    `  LINKED   ${r.linkedId} · ผูกให้ผู้ที่ผูกบัญชีแล้ว ${r.relinked} คน${r.relinkRefused ? ` · LINE ไม่รับ ${r.relinkRefused} คน (เช่นบล็อก OA อยู่ จะได้เมนูนี้เองเมื่อเพิ่มเพื่อนอีกครั้ง)` : ''}${r.relinkFailed ? ` · ไม่สำเร็จชั่วคราว ${r.relinkFailed} คน — รันอีกครั้ง (เก็บชุดเดิมไว้ให้ก่อน)` : ''}`,
    `  ลบชุดเดิม ${r.removed} ชุด${r.removeFailed ? ` · ลบไม่ได้ ${r.removeFailed} ชุด` : ''}`,
  ]
}

function stop(message: string): never {
  console.error(`line:richmenu หยุด: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === '--images') {
    if (args.length > 1) stop('--images ใช้เดี่ยว ๆ')
    const written = await writeLineRichMenuImages()
    for (const kind of LINE_RICH_MENU_KINDS) console.log(`line:richmenu วาดภาพ ${kind} แล้ว: ${path.relative(process.cwd(), written[kind].file)} (${written[kind].bytes} ไบต์)`)
    return
  }
  let org: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--org' && args[i + 1] && !args[i + 1]!.startsWith('--')) org = args[++i]!
    else stop(`ไม่รู้จักตัวเลือก ${args[i]} — ใช้ได้: --org <รหัสองค์กร> หรือ --images`)
  }
  const run = await runLineRichMenu({ org })
  if (!run.ok) stop(run.problem)
  for (const line of describeLineRichMenuRun(run)) console.log(line)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main()
    .catch((error: unknown) => stop(error instanceof Error ? error.message : String(error)))
    .finally(() => prisma.$disconnect())
}
