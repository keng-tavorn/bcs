import { spawnSync } from 'node:child_process'
import type { Locator } from '@playwright/test'
import { e2eEnv } from '../support/e2e-env'
import { expect, test } from './fixtures'
import { castOf, expectNoBlockingAxe, expectNoSideways, fixture, shot, signIn } from './tasks-support'

// NEW-122 (ADR-079 · FR-INT-012 AC7 AC8): the panel "จากผู้ช่วย" of a document page in the browser, at 1440 px and on the
// phone. With the AI module off (the demo organization's default) the panel keeps what the rules found — here the step
// of a request long past its due time (tests/e2e/tasks-fixtures.ts overdue) — with one way to the route, no Sparkles and
// nothing of the AI. With it on (tests/e2e/ai-document-scene.ts, which plays the Brief's job) the one who decides reads
// the Approval Brief apart, says it helped (read back after a reload from their own Event), and "ถามเรื่องนี้" opens
// "ถาม BCS AI" with the request's number waiting in its field. On a computer the panel stands in the right column under
// the decision bar; on a phone under the header, before the tabs. The answers and the rights are
// tests/integration/document-assistant.test.ts.

type Made = { requestId: string; number: string; taskId: string }

function aiScene<T>(mode: 'on' | 'off' | 'brief'): T {
  const r = spawnSync('pnpm exec tsx tests/e2e/ai-document-scene.ts', { shell: true, encoding: 'utf8', env: { ...process.env, ...e2eEnv(), SCENE_MODE: mode } })
  if (r.status !== 0) throw new Error(`ai-document-scene ${mode} failed:\n${r.stdout}\n${r.stderr}`)
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as T
}

const top = async (l: Locator) => (await l.boundingBox())!.y
const left = async (l: Locator) => (await l.boundingBox())!.x

test.afterEach(() => {
  aiScene('off')
})

test('[FR-INT-012/AC7] the requester reads what the rules found on their request; with the AI off nothing of the AI is there', async ({ page }, testInfo) => {
  const cast = castOf(testInfo)
  const made = fixture<Made>('overdue', cast.requester, `เครื่องพิมพ์ (แผงผู้ช่วย ${testInfo.project.name})`)
  await signIn(page, cast.requester, false)
  await page.goto(`/requests/${made.requestId}`)

  const panel = page.getByRole('region', { name: 'จากผู้ช่วย' })
  const found = panel.getByRole('list', { name: 'เรื่องที่ผู้ช่วยเจอในเอกสารนี้' })
  const note = found.locator('[data-assistant-note="STEP_OVERDUE"]')
  await expect(note.getByText(/^ขั้นที่รออยู่เกินกำหนดแล้ว \(ครบเมื่อ .+\)$/)).toBeVisible()
  await expect(note.getByText(/^ยังรอ .+ ตัดสิน · ระบบเตือนผู้อนุมัติตามเวลาแล้ว$/)).toBeVisible()
  await expect(note.getByRole('link', { name: 'ดูเส้นทางอนุมัติ' })).toHaveAttribute('href', `/requests/${made.requestId}?tab=overview#route`)
  // The AI module is off: no Brief, no shortcuts, no Sparkles (the rules' words carry the icon of the work)
  await expect(panel.getByRole('region', { name: 'สรุปจาก AI' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'ถามเรื่องนี้' })).toHaveCount(0)
  await expect(panel.locator('svg.lucide-sparkles')).toHaveCount(0)

  // Where it stands: under the header and before the tabs on a phone, the right column on a computer
  const tabs = page.getByRole('tablist', { name: 'ส่วนของเอกสาร' })
  if (testInfo.project.name === 'mobile') expect(await top(panel)).toBeLessThan(await top(tabs))
  else expect(await left(panel)).toBeGreaterThan(await left(tabs))
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'assistant-panel-rules')

  // Its one link leads to the route of the overview
  await note.getByRole('link', { name: 'ดูเส้นทางอนุมัติ' }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/${made.requestId}\\?tab=overview#route$`))
  await expect(page.getByRole('heading', { name: 'เส้นทางอนุมัติ' })).toBeVisible()
})

test('[FR-INT-012/AC7] [FR-INT-012/AC8] the one who decides reads the Brief in the panel, says it helped, and asks about the request', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  aiScene('on')
  const brief = aiScene<{ taskId: string; requestId: string; assignee: string; result: string }>('brief')
  expect(brief.result).toBe('DRAFT')
  await signIn(page, brief.assignee, true)
  await page.goto(`/requests/${brief.requestId}`)

  const panel = page.getByRole('region', { name: 'จากผู้ช่วย' })
  const box = panel.getByRole('region', { name: 'สรุปจาก AI' })
  await expect(box.getByText('AI อาจผิดพลาด ตรวจกับเอกสาร')).toBeVisible()
  await expect(box.getByText(/คำขอนี้ยอด [\d,]+\.\d{2} บาท ตามข้อ /)).toBeVisible()
  // No decision in the panel: the decision bar keeps it (BR-AI-01)
  await expect(panel.getByRole('button', { name: /อนุมัติ|ตีกลับ/ })).toHaveCount(0)
  const bar = page.getByRole('region', { name: 'ตัดสินงานนี้' })
  if (testInfo.project.name === 'desktop') {
    expect(await top(panel)).toBeGreaterThan(await top(bar))
    expect(await left(panel)).toBeGreaterThan(await left(page.getByRole('tablist', { name: 'ส่วนของเอกสาร' })))
  } else {
    expect(await top(panel)).toBeLessThan(await top(page.getByRole('tablist', { name: 'ส่วนของเอกสาร' })))
  }

  const feedback = box.getByRole('group', { name: 'ความเห็นต่อผลของ AI' })
  const helpful = feedback.getByRole('button', { name: 'ช่วยได้' })
  await expect(helpful).toHaveAttribute('aria-pressed', 'false')
  await helpful.click()
  await expect(feedback.getByRole('status')).toHaveText('บันทึกแล้วว่าช่วยได้ ขอบคุณ')
  await expect(helpful).toHaveAttribute('aria-pressed', 'true')
  await expectNoBlockingAxe(page)
  await expectNoSideways(page)
  await shot(page, testInfo, 'assistant-panel-brief')
  // Read back from the reader's own Event
  await page.reload()
  await expect(page.getByRole('region', { name: 'จากผู้ช่วย' }).getByRole('button', { name: 'ช่วยได้' })).toHaveAttribute('aria-pressed', 'true')

  // "ถามเรื่องนี้": the sheet opens with the number waiting in its field, nothing sent before the member finishes
  await expect(panel.getByRole('button', { name: 'สรุปให้' })).toBeVisible()
  await panel.getByRole('button', { name: 'ถามเรื่องนี้' }).click()
  const sheet = page.getByRole('dialog', { name: 'ถาม BCS AI' })
  const field = sheet.getByRole('textbox', { name: 'ถามต่อ' })
  await expect(field).toHaveValue(/^คำขอ [A-Z]{2,4}-\d{4}-\d{5} $/)
  await expect(field).toBeFocused()
  await expect(sheet.getByRole('status')).toHaveCount(0)
  await expectNoBlockingAxe(page)
  await shot(page, testInfo, 'assistant-ask-draft')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})
