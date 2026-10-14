import { spawnSync } from 'node:child_process'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, newLineUserId, openAsLineUser, sceneTag } from './liff-support'

// S6-12 in LINE (FR-INT-101 AC1, BR-FORM-07): the request's LIFF page offers "ขอซ้ำ" to its requester, and pressing it
// opens the new draft's LIFF form; at 375 px in the mobile project (playwright.config.ts runs liff-* specs on the phone
// only), photographed and checked at 1440 px too (checkScreen). LIFF_MOCK stands in for the LINE app; the requester is
// a fresh CON member linked to a LINE account of their own (reorder-scene.ts). The web's buttons: reorder.spec.ts.

interface SentRequest {
  readonly requestId: string
  readonly number: string
  readonly title: string
  readonly lines: readonly string[]
}

interface Draft {
  readonly id: string
  readonly title: string
  readonly sourceRequestId: string | null
  readonly lines: ReadonlyArray<{ readonly description: string }>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/reorder-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work spends a link code (a secret of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`reorder scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

test('[FR-INT-101/AC1] the request\'s LIFF page offers ขอซ้ำ to the requester, which opens the new draft\'s LIFF form', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  const tag = sceneTag('liff')
  const lineUserId = newLineUserId()
  const s = scene<SentRequest>('requester', tag, lineUserId)
  await openAsLineUser(context, lineUserId)
  await page.goto(`/liff/requests/${s.requestId}`)
  await expect(page.getByRole('heading', { level: 1, name: s.number })).toBeVisible()
  const section = page.getByRole('region', { name: 'ขอรายการเดิมอีกครั้ง' })
  await expect(section).toBeVisible()
  const reorder = section.getByRole('button', { name: 'ขอซ้ำ', exact: true })
  await expect(reorder).toBeVisible()
  await checkScreen(page, testInfo, 'liff-reorder')

  await reorder.click()
  await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
  const draftId = new URL(page.url()).pathname.split('/')[3]!
  expect(draftId).not.toBe(s.requestId)
  const [draft] = scene<Draft[]>('drafts', tag)
  expect(draft).toMatchObject({ id: draftId, title: s.title, sourceRequestId: s.requestId })
  expect(draft!.lines.map((l) => l.description)).toEqual(s.lines)
})
