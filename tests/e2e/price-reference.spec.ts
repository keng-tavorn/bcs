import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { anotherPhone, checkScreen, newLineUserId, openAsLineUser } from './liff-support'
import { expectNoBlockingAxe, expectNoSideways, shot, signIn } from './tasks-support'

// S6-11 on screen (FR-DOA-101 AC1 AC2 · BR-PRC-02 BR-PRC-03 BR-PRC-07): three POs of one item were approved at 2,400.00,
// 2,380.00 and 2,450.00, then a request for the same item at 2,700.00 waits for its approver (price-reference-scene.ts,
// in the demo organization, fresh for each Playwright project). The approver's decision page shows the price reference
// panel — the lower median 2,400.00, the range, the latest price, +12.50% and the HIGH badge in words — as a table on a
// wide screen and as stacked lines at 375 px; the LIFF task page shows the same numbers in its compact list; the
// requester, who may not read the prices of other POs (OQ-116), sees no panel on their own request. Screenshots at 375 px
// (mobile) and 1440 px (desktop) go to the test output (§9.9 step 4); each screen is checked with axe (step 5).

interface Reference {
  readonly id: string
  readonly number: string
  readonly title: string
  readonly item: string
  readonly taskId: string
  readonly approver: string
  readonly approverTotp: boolean
}

// Three POs and a request through the services, two sign-ins and a LINE link: more than Playwright's default 30 seconds
test.describe.configure({ timeout: 240_000 })

function run<T>(script: string, ...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/${script} ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  if (r.status !== 0) throw new Error(`${script} ${args[0]} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const scene = (testInfo: TestInfo) => run<Reference>('price-reference-scene.ts', 'reference', `${testInfo.project.name}-${randomBytes(3).toString('hex')}`)
const panel = (page: Page) => page.getByRole('region', { name: 'ราคาอ้างอิง', exact: true })

/** The figures of the drill's line, wherever the line is drawn (a table row, or a stacked list item) */
async function expectDrillFigures(line: Locator) {
  for (const figure of ['2,700.00', '2,400.00', '2,380.00', '2,450.00', '+12.50%', 'สูงกว่าค่ากลาง', 'จาก 3 ราคาใน PO ที่อนุมัติแล้ว']) await expect(line, figure).toContainText(figure)
  // The badge is a word with its icon, never colour alone (NFR-A11Y-03)
  await expect(line.locator('[data-slot="badge"][data-tone="warn"]')).toContainText('สูงกว่าค่ากลาง')
}

test('[FR-DOA-101/AC1] [FR-DOA-101/AC2] the approver sees the price reference on the decision page and the same numbers on the LIFF task page; the requester sees no panel on their request', async ({ page, browser }, testInfo) => {
  const s = scene(testInfo)
  await signIn(page, s.approver, s.approverTotp)
  await page.goto(`/tasks/${s.taskId}`)
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible()
  const section = panel(page)
  await expect(section).toBeVisible()
  await expect(section).toContainText('365 วัน')
  await expect(section).toContainText('10.00%')
  if (testInfo.project.name === 'desktop') {
    // A wide column: one row per line, the figures in their columns
    const table = section.getByRole('table', { name: 'ราคาอ้างอิงของแต่ละรายการ' })
    await expect(table).toBeVisible()
    await expect(table.getByRole('columnheader', { name: 'ค่ากลาง', exact: true })).toBeVisible()
    const row = table.getByRole('row').filter({ hasText: s.item })
    await expectDrillFigures(row)
    await expect(row).toContainText('2,380.00 – 2,450.00')
    await expect(section.getByRole('list', { name: 'ราคาอ้างอิงของแต่ละรายการ' })).toBeHidden()
  } else {
    // A phone: the lines stack, label and figure on one row, nothing scrolls sideways
    const list = section.getByRole('list', { name: 'ราคาอ้างอิงของแต่ละรายการ' })
    await expect(list).toBeVisible()
    const item = list.getByRole('listitem').filter({ hasText: s.item })
    await expectDrillFigures(item)
    // Label and figure on one row: the median beside its word
    await expect(item.locator('dl > div').filter({ has: page.getByRole('term').filter({ hasText: /^ค่ากลาง$/ }) })).toContainText('2,400.00')
    await expect(section.getByRole('table')).toBeHidden()
  }
  await section.scrollIntoViewIfNeeded()
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'price-reference-task')

  // In LINE, on the approver's phone: the same numbers in the LIFF list, no shadcn/ui table (ADR-052)
  const lineUserId = newLineUserId()
  run('liff-gr-scene.ts', 'link', s.approver, lineUserId)
  const phone = await anotherPhone(browser)
  try {
    await openAsLineUser(phone, lineUserId)
    const liff = await phone.newPage()
    await liff.goto(`/liff/tasks/${s.taskId}`)
    await expect(liff.getByRole('heading', { level: 1, name: s.title })).toBeVisible()
    const liffSection = panel(liff)
    await expect(liffSection).toBeVisible()
    await expectDrillFigures(liffSection.getByRole('list', { name: 'ราคาอ้างอิงของแต่ละรายการ' }).getByRole('listitem').filter({ hasText: s.item }))
    await expect(liffSection.locator('[data-slot^="table"]')).toHaveCount(0)
    await liffSection.scrollIntoViewIfNeeded()
    await checkScreen(liff, testInfo, 'price-reference-liff')
  } finally {
    await phone.close()
    run('liff-gr-scene.ts', 'unlink', s.approver)
  }

  // The requester reads their own request, but not the prices of the organization's POs (BR-PRC-07 · OQ-116)
  await page.context().clearCookies()
  await signIn(page, 'req_con', false)
  await page.goto(`/requests/${s.id}`)
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible()
  await expect(panel(page)).toHaveCount(0)
  await expect(page.getByText('ค่ากลาง')).toHaveCount(0)
})
