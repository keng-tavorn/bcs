import { devices } from '@playwright/test'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet, portalSessionOn, s7 } from './support'

// Scene 5 of the day of phase 2 (S7-17 · S7-11 · FR-SUP-105 AC2 AC3 · BR-SUP-14): on a phone, the contact of the row's
// supplier (portalActor) opens the PO the history sent it and that still waits for its goods (expectJson.po.fromHistory ·
// ADR-191: on the seed alone, not scene 1 of phase 1), checks its amounts, acknowledges it with the day it delivers
// (expectJson.ack.deliverInDays from today), then moves that day by expectJson.move.byDays with the row's reason. The
// requester and the receivers of the requester's department heard of the acknowledgement in their digest
// (expectJson.toldDigest), and of the new day at once with the buyer who made the PO (expectJson.toldNow · IMMEDIATE);
// the actor (the requester) reads both in the banner of the PO.

const baht = (satang: string) => `${(Number(BigInt(satang) / 100n)).toLocaleString('en-US')}.${(BigInt(satang) % 100n).toString().padStart(2, '0')}`

test('@p2demo [FR-SUP-105/AC2] [FR-SUP-105/AC3] scene 5: the supplier acknowledges a PO on its phone and moves the day; the requester, the receivers and the buyer are told', async ({ browser }) => {
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 5)
  const po = p2Expected<{ fromHistory: string; net: string; vat: string; gross: string }>(scene, 'po')
  const ack = p2Expected<{ deliverInDays: number }>(scene, 'ack')
  const move = p2Expected<{ byDays: number; reason: string }>(scene, 'move')
  const facts = s7<{ id: string; number: string; status: string; netSatang: string; vatSatang: string; grossSatang: string; supplierAckStatus: string; supplier: { code: string } }>('history-po', po.fromHistory)
  expect(facts.supplier.code).toBe(scene.supplier)
  expect(facts.status).toBe('SENT')
  expect(facts.supplierAckStatus).toBe('NOT_ACKNOWLEDGED')
  // the sheet writes baht with two decimals ("12000.00"): satang are its digits
  expect([facts.netSatang, facts.vatSatang, facts.grossSatang]).toEqual([po.net, po.vat, po.gross].map((v) => String(BigInt(v.replace('.', '')))))

  // the supplier's phone
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  await portalSessionOn(phone, sheet.orgCode, scene.portalActor!)
  const page = await phone.newPage()
  await page.goto(`/portal/${sheet.orgCode}/pos`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ใบสั่งซื้อ')
  await page.getByRole('link', { name: facts.number }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(facts.number)
  await expect(page.locator('main')).toContainText(baht(facts.grossSatang))
  await page.getByLabel('วันส่งที่แจ้ง').fill(dayFromToday(ack.deliverInDays))
  await page.getByRole('button', { name: 'รับทราบใบสั่งซื้อนี้' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'รับทราบแล้ว' })).toBeVisible()
  await page.getByLabel('วันส่งที่แจ้ง').fill(dayFromToday(ack.deliverInDays + move.byDays))
  await page.getByLabel('เหตุผลที่เปลี่ยน').fill(move.reason)
  await page.getByRole('button', { name: 'แจ้งวันส่งใหม่' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'แจ้งวันส่งใหม่แล้ว' })).toBeVisible()
  await phone.close()

  // who heard of it (BR-SUP-14)
  const told = s7<{ status: string; told: Array<{ templateKey: string; to: string | null; urgency: string }> }>('told', facts.id)
  expect(told.status).toBe('DELIVERY_UPDATED')
  const to = (template: string) => [...new Set(told.told.filter((n) => n.templateKey === template).map((n) => n.to))].sort()
  expect(to('po.acknowledged')).toEqual(p2Expected<string[]>(scene, 'toldDigest'))
  expect(told.told.filter((n) => n.templateKey === 'po.acknowledged').every((n) => n.urgency === 'DIGEST')).toBe(true)
  expect(to('po.delivery_changed')).toEqual(p2Expected<string[]>(scene, 'toldNow'))
  expect(told.told.filter((n) => n.templateKey === 'po.delivery_changed').every((n) => n.urgency === 'IMMEDIATE')).toBe(true)

  // the requester reads it on the PO
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const own = await desk.newPage()
  await signInAs(own, p1, scene.actor)
  await own.goto(`/procurement/pos/${facts.id}`)
  await expect(own.locator('main')).toContainText(facts.number)
  // the banner of the PO: acknowledged, the day it delivers, and the day it was moved from
  const banner = own.getByRole('status').filter({ hasText: 'ผู้ขายรับทราบเมื่อ' })
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('เลื่อนจาก')
  await desk.close()
})
