import { spawnSync } from 'node:child_process'
import { type Page, type TestInfo } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { sceneTag } from './liff-support'
import { expectNoBlockingAxe, expectNoSideways, shot } from './tasks-support'

// S6-12 on screen (FR-INT-101 AC1 AC2, BR-FORM-07, BR-FORM-08): the requester presses "ขอซ้ำ" on their sent request and
// lands on the new draft's edit page with its lines; on an ordered request with a service line, "สร้างคำขอต่ออายุ" on
// that line lands on a draft of that line (the LIFF page's "ขอซ้ำ": liff-reorder.spec.ts, on the phone). Every test has
// a requester of its own (reorder-scene.ts: a fresh CON member), so the drafts made here never change another spec's
// counts. Screenshots at 1440 px (desktop) and 375 px (mobile) go to the test output (§9.9 step 4); every state is
// checked with axe (step 5).

interface SentRequest {
  readonly member: { readonly id: string; readonly employeeCode: string; readonly email: string }
  readonly requestId: string
  readonly number: string
  readonly title: string
  readonly lines: readonly string[]
}

interface ServiceRequest {
  readonly requestId: string
  readonly number: string
  readonly title: string
  readonly lineId: string
  readonly description: string
  readonly ends: string
}

interface Draft {
  readonly id: string
  readonly title: string
  readonly sourceRequestId: string | null
  readonly renewalOfRequestLineId: string | null
  readonly lines: ReadonlyArray<{ readonly description: string; readonly quantity: string; readonly serviceEndDate: string | null }>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/reorder-scene.ts ${args.map((a) => `"${a}"`).join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work may spend a link code (a secret of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`reorder scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

async function check(page: Page, testInfo: TestInfo, name: string) {
  await expectNoSideways(page)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, `${name}-${testInfo.project.name === 'mobile' ? '375' : '1440'}`)
}

/** Signs the scene's member in on the web with the seeded password (a plain requester: no TOTP) */
async function signInAs(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('อีเมลบริษัท').fill(email)
  await page.getByLabel('รหัสผ่าน').fill(process.env.SEED_DEV_PASSWORD!)
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('สวัสดี')
}

const UUID = '[0-9a-f-]{36}'

test('[FR-INT-101/AC1] the requester presses ขอซ้ำ on a sent request and lands on the new draft with its lines', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const tag = sceneTag('web')
  const s = scene<SentRequest>('requester', tag)
  await signInAs(page, s.member.email)
  await page.goto(`/requests/${s.requestId}`)
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible()
  const reorder = page.getByRole('button', { name: 'ขอซ้ำ', exact: true })
  await expect(reorder).toBeVisible()
  await check(page, testInfo, 'reorder-request')

  await reorder.click()
  await expect(page).toHaveURL(new RegExp(`/requests/${UUID}/edit$`))
  const draftId = new URL(page.url()).pathname.split('/')[2]!
  expect(draftId).not.toBe(s.requestId)
  // The form opens on the new draft: its title is the request's, and its lines are the request's lines
  await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(s.title)
  const [draft] = scene<Draft[]>('drafts', tag)
  expect(draft).toMatchObject({ id: draftId, title: s.title, sourceRequestId: s.requestId, renewalOfRequestLineId: null })
  expect(draft!.lines.map((l) => l.description)).toEqual(s.lines)
  await check(page, testInfo, 'reorder-draft')
})

test('[FR-INT-101/AC2] a service line of an ordered request shows สร้างคำขอต่ออายุ, which lands on a draft of that line', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const tag = sceneTag('renew')
  const s = scene<SentRequest>('requester', tag)
  const service = scene<ServiceRequest>('service', tag)
  await signInAs(page, s.member.email)

  // A request that is not ordered has no renewal (the cancelled one), only ขอซ้ำ
  await page.goto(`/requests/${s.requestId}`)
  await expect(page.getByRole('button', { name: 'ขอซ้ำ', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ต่ออายุบริการ' })).toHaveCount(0)

  await page.goto(`/requests/${service.requestId}`)
  await expect(page.getByRole('heading', { level: 1, name: service.title })).toBeVisible()
  const renewal = page.getByRole('region', { name: 'ต่ออายุบริการ' })
  await expect(renewal).toBeVisible()
  const row = renewal.getByRole('list', { name: 'บรรทัดบริการที่ต่ออายุได้' }).getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(service.description)
  await expect(row).toContainText('สิ้นสุดบริการ')
  const renew = row.getByRole('button', { name: `สร้างคำขอต่ออายุ ${service.description}` })
  await expect(renew).toBeVisible()
  await check(page, testInfo, 'renew-request')

  await renew.click()
  await expect(page).toHaveURL(new RegExp(`/requests/${UUID}/edit$`))
  const draftId = new URL(page.url()).pathname.split('/')[2]!
  await expect(page.getByLabel('ชื่อคำขอ')).toHaveValue(service.title)
  const [draft] = scene<Draft[]>('drafts', tag)
  // The draft holds that one line, without its old end date: the requester gives the new one
  expect(draft).toMatchObject({ id: draftId, sourceRequestId: service.requestId, renewalOfRequestLineId: service.lineId })
  expect(draft!.lines).toEqual([expect.objectContaining({ description: service.description, serviceEndDate: null })])
  await check(page, testInfo, 'renew-draft')
})
