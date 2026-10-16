import { spawnSync } from 'node:child_process'
import { type Page } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { checkScreen, newLineUserId, openAsLineUser, sceneTag } from './liff-support'

// S6-13 in LINE (FR-INT-103 AC2 · BR-DUP-05): the draft's LIFF form /liff/requests/[id]/edit refuses to send a request
// like one the requester sent yesterday until they give the reason — an inline panel on step 3 (never a pop-up) with
// the request sent yesterday as a link to its LIFF page and the reason box; with the box empty nothing is sent, with a
// reason it goes. At 375 px in the mobile project (playwright.config.ts runs liff-* specs on the phone only), checked at
// 1440 px too (checkScreen). LIFF_MOCK stands in for the LINE app; the requester is a fresh CON member linked to a LINE
// account of their own (duplicates-scene.ts). The web form and the approver's pages: duplicates.spec.ts.

interface Requester {
  readonly sent: { readonly id: string; readonly number: string; readonly title: string }
  readonly draft: { readonly id: string; readonly title: string }
}

interface SentTask {
  readonly requestId: string
  readonly flags: ReadonlyArray<{ readonly kind: string; readonly acknowledgedReason: string | null }>
}

function scene<T>(...args: string[]): T {
  const r = spawnSync(`pnpm exec tsx tests/e2e/duplicates-scene.ts ${args.join(' ')}`, { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv() } })
  // Its work spends a link code (a secret of this test database): on failure only what went wrong is shown
  if (r.status !== 0) throw new Error(`duplicates scene ${args[0]} failed:\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const nextStep = (page: Page, name: string) => page.getByRole('button', { name: `ไปขั้นถัดไป: ${name}` }).click()

test('[FR-INT-103/AC2] the LIFF form asks for the reason before it sends a request like one sent yesterday', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000)
  const tag = sceneTag('liffdup')
  const lineUserId = newLineUserId()
  const s = scene<Requester>('requester', tag, lineUserId)
  try {
    await openAsLineUser(context, lineUserId)
    await page.goto(`/liff/requests/${s.draft.id}/edit`)
    await nextStep(page, 'รายการที่ขอ')
    await nextStep(page, 'ตรวจและส่ง')
    const send = page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })
    await send.click()

    const panel = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'คำขอนี้คล้ายคำขอที่คุณส่งไปแล้ว' }) })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(panel.getByRole('list', { name: 'คำขอที่คล้ายกัน' }).getByRole('link', { name: s.sent.number, exact: true })).toHaveAttribute('href', `/liff/requests/${s.sent.id}`)
    const reason = panel.getByLabel(/^เหตุผลที่ขออีกครั้ง/)
    await panel.scrollIntoViewIfNeeded()
    await checkScreen(page, testInfo, 'liff-duplicate-panel')

    // With the box empty nothing is sent: the box says why and takes the focus
    await send.click()
    await expect(panel.getByText('ใส่เหตุผลที่ขออีกครั้งก่อนส่ง')).toBeVisible()
    await expect(reason).toBeFocused()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })).toHaveCount(0)

    const why = `ของรอบก่อนใช้หมดแล้ว ${tag}`
    await reason.fill(why)
    await send.click()
    await expect(page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' }).first()).toBeVisible()
    const t = scene<SentTask>('task', tag)
    expect(t.requestId).toBe(s.draft.id)
    expect(t.flags).toContainEqual({ kind: 'DUPLICATE', acknowledgedReason: why })
  } finally {
    scene('cleanup', tag)
  }
})
