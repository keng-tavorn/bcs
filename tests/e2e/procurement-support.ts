import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { attachmentOf, type MailpitMessage } from '../support/mailpit'
import { expect } from './fixtures'
import { shot } from './tasks-support'

// Shared steps of the procurement e2e specs (unit e: procurement*.spec.ts, purchase-order*.spec.ts, tasks-po.spec.ts):
// the scene script that builds what a test needs through the services, the groups of the pool, the parts of a PO page,
// and the e-mails Mailpit received for a PO.

export type Made = { id: string; number: string; title: string; lineIds: string[] }
export type MadePo = { poId: string; number: string; request: Made }

/** A tag of this test and project for the scene: never shared by desktop and mobile, nor by two runs */
export const tagOf = (testInfo: TestInfo) => `${testInfo.project.name}-${randomUUID().slice(0, 6)}`

/** Runs tests/e2e/procurement-scene.ts against the e2e database and returns what it made */
export function scene<T>(scenario: string, tag: string): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/procurement-scene.ts ${scenario} ${tag}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`procurement scene ${scenario} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as T
}

export const poolList = (page: Page) => page.getByRole('list', { name: 'บรรทัดคำขอรอจัดซื้อ' })
/** The group of one request in the pool (its own row, not the rows of its lines) */
export const poolGroup = (page: Page, number: string) => poolList(page).getByRole('listitem').filter({ has: page.getByRole('link', { name: new RegExp(`^${number} · `) }) })
/** The page's own heading block (the workspace shell has a header of its own) */
export const header = (page: Page) => page.locator('#content header')
export const actions = (page: Page) => page.getByRole('region', { name: 'สิ่งที่ทำได้ตอนนี้' })
export const poTimeline = (page: Page) => page.getByRole('list', { name: 'ไทม์ไลน์ของใบสั่งซื้อ' })
export const S1 = 'S1 · บริษัท วัสดุก่อสร้างทดสอบ จำกัด'
export const S2 = 'S2 · บริษัท ไอทีทดสอบ จำกัด'

/** Ticks every line of these requests in the pool, chooses the supplier, and waits for the pool to say it was done */
export async function chooseSupplier(page: Page, numbers: readonly string[], supplier: string, count: number) {
  for (const number of numbers) await page.getByRole('checkbox', { name: `เลือกทุกบรรทัดของ ${number}` }).check()
  await expect(page.getByRole('region', { name: 'เลือกผู้ขายให้บรรทัดที่เลือก' }).getByText(`เลือกแล้ว ${count} บรรทัด`)).toBeVisible()
  await page.getByLabel('ผู้ขายสำหรับบรรทัดที่เลือก').selectOption({ label: supplier })
  await page.getByRole('button', { name: 'ใช้ผู้ขายนี้กับบรรทัดที่เลือก' }).click()
  // The notice says it with the button's own words (§9.9 principle 7)
  await expect(page.getByRole('status').filter({ hasText: `ใช้ผู้ขาย ${supplier} กับ ${count} บรรทัดแล้ว` })).toBeVisible()
}

/** The PO number of the page, read from its heading ("ใบสั่งซื้อ PO-2569-00012") */
export async function poNumberOf(page: Page): Promise<string> {
  // The number follows the organization's pattern (FR-ADM-004 lets an admin change it), so any number after the name
  const label = await header(page).getByText(/^ใบสั่งซื้อ PO\S*\d$/).innerText()
  return label.replace('ใบสั่งซื้อ ', '')
}

const MAILPIT = 'http://localhost:8025/api/v1'

/**
 * The e-mails of one PO to one address since `sinceMs`: Mailpit is shared by every e2e run and the dev server, and PO
 * numbers start again in each database, so the subject and the time tell this run's apart.
 */
export async function poMails(to: string, number: string, sinceMs: number): Promise<MailpitMessage[]> {
  const query = encodeURIComponent(`to:"${to}" subject:"${number}"`)
  const found = (await (await fetch(`${MAILPIT}/search?query=${query}&limit=50`)).json()) as { messages: Array<{ ID: string; Created: string }> }
  const recent = found.messages.filter((m) => Date.parse(m.Created) >= sinceMs - 5_000)
  return Promise.all(recent.map(async (m) => (await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as MailpitMessage))
}

/** Waits for the e-mail of a PO and checks it carries the PO as a PDF named after its number */
export async function expectPoMail(to: string, number: string, sinceMs: number, again = false): Promise<MailpitMessage> {
  await expect.poll(async () => (await poMails(to, number, sinceMs)).filter((m) => m.Subject.includes('(ส่งอีกครั้ง)') === again).length, { timeout: 20_000 }).toBe(1)
  const message = (await poMails(to, number, sinceMs)).find((m) => m.Subject.includes('(ส่งอีกครั้ง)') === again)!
  expect(message.Subject).toContain(`ใบสั่งซื้อ ${number}`)
  expect(message.Attachments).toEqual([expect.objectContaining({ FileName: `${number}.pdf`, ContentType: 'application/pdf' })])
  const pdf = await attachmentOf(message, message.Attachments[0]!.PartID)
  expect(new TextDecoder('latin1').decode(pdf.subarray(0, 5))).toBe('%PDF-')
  return message
}

/** The link "เปิด PDF ของ …" downloads the printed PO (FR-PLT-009) */
export async function expectPdfLink(page: Page, link: Locator) {
  const href = await link.getAttribute('href')
  expect(href).toMatch(/^\/procurement\/pos\/[0-9a-f-]{36}\/pdf$/)
  const response = await page.request.get(href!)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/pdf')
  expect(new TextDecoder('latin1').decode((await response.body()).subarray(0, 5))).toBe('%PDF-')
}

/**
 * A screenshot from the top of the page, so bars that stick while scrolling sit where they belong (§9.9 step 4): the
 * whole page — or, for a step in the middle of a scene on a phone (`whole: false`), the screen the member sees, since a
 * phone page several screens tall takes seconds to capture and the whole of that page is captured at its main step
 */
export async function topShot(page: Page, testInfo: TestInfo, name: string, options: { readonly whole?: boolean } = {}) {
  await page.evaluate(() => window.scrollTo(0, 0))
  if (options.whole === false && testInfo.project.name === 'mobile') await page.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  else await shot(page, testInfo, name)
}

/** The parts of a PO page or of its decision page that §9.9 principle 5 asks for */
export const budgetRegion = (page: Page) => page.getByRole('region', { name: 'งบประมาณ' })
export const requestsRegion = (page: Page) => page.getByRole('region', { name: 'คำขอต้นทางและเอกสารแนบ' })

/**
 * "รวมเป็นร่าง PO ตอนนี้": the round asks a second time (a draft cannot be thrown away yet), then runs. `shot` keeps a
 * picture of the panel while it asks (§9.9 step 4)
 */
export async function consolidateNow(page: Page, shot?: { readonly testInfo: TestInfo; readonly name: string }) {
  await page.getByRole('button', { name: 'รวมเป็นร่าง PO ตอนนี้' }).click()
  await expect(page.getByText(/^รวมบรรทัดที่เลือกผู้ขายแล้ว \d+ บรรทัดเป็นร่าง PO ตอนนี้ ร่างที่ได้ยังทิ้งทั้งใบหรือเปลี่ยนผู้ขายไม่ได้/)).toBeVisible()
  if (shot) await page.getByRole('region', { name: 'รวมเป็นร่าง PO', exact: true }).screenshot({ path: shot.testInfo.outputPath(`${shot.name}.png`) })
  await page.getByRole('button', { name: 'ยืนยันรวมเป็นร่าง PO' }).click()
}
