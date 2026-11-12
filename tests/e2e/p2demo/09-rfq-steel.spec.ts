import type { Page } from '@playwright/test'
import { E2E_PIN } from '../../support/e2e-env'
import { lineUserOf, phoneOf } from '../demo/support'
import { deskAs } from '../p1demo/money-steps'
import { day, p1Sheet, userOf } from '../p1demo/support'
import { expect, test } from '../fixtures'
import {
  applicationOf,
  bahtText,
  bidOnPhone,
  expectG8,
  p2Expected,
  p2SceneOf,
  p2Sheet,
  portalPhone,
  portalRfxWords,
  rfxRowsOf,
  s10,
  type AwardFacts,
  type G8Figures,
  type RfxFacts,
} from './support'

// Scene 9 of the day of phase 2 (S10-18 · core · docs/sub-specs/S10.md "Demo ของขั้น" 1), with scene 12 in its middle
// and the G-8 report before it. The seed opened the RFQ of the row's rfx (RFx_Scenarios: the two DB12 lines of the
// pool, three steel suppliers invited, evaluators proc_mat2 and proc_officer) on its day and left it OPEN. In order:
//   - scene 15 before scene 9: /reports/sourcing shows the two awards of the seed (expectJson.afterSeed of scene 15)
//   - the suppliers' contacts bid on their phones (RFx_Bids: SP0024 with VAT), each in its own language; procurement
//     sees who bid and no price while the envelope is sealed (BR-RFX-06)
//   - scene 12, while the RFQ is still open (the files run in their names' order, and this RFQ closes below): procurement
//     invites the application of Supplier_Applications that waits (SUBMITTED); its contact reads the RFx, asks a
//     question, and cannot bid until the application is approved (SUPPLIER_NOT_APPROVED · ADR-203)
//   - the close as job rfx-close runs it at closesAt (the e2e app has no Inngest: the clock of the day moved to the
//     close); a bid a second later is refused (RFX_CLOSED); the comparison is before VAT for every bid (BR-RFX-08)
//   - the two evaluators score delivery and quality on their own pages (RFx_Scores); the totals are revealed
//   - procurement awards both lines to the first, which is the lowest (no reason), and sends it; rule RA-01 gives it to
//     dm_proc, who approves on LIFF with the PIN; two POs are drafted by site, SP0023 becomes the preferred supplier of
//     STEEL, the winner and the two others are e-mailed
//   - procurement sends the first PO; PO-01 gives it to coo, who approves it on the web with the PIN
// Numbers (RFX, AWD, PO) are read from the screens and the database, never typed here.

test.describe.configure({ mode: 'serial' })

const RFX_ROWS = rfxRowsOf('RFX-STEEL-DB12')
let rfx: RfxFacts
let rfxNumber = ''

async function desk(browser: Parameters<typeof deskAs>[0], code: string): Promise<Page> {
  return deskAs(browser, await p1Sheet(), code)
}

test('@p2demo [FR-SRC-204/AC8] scene 15 before scene 9: the G-8 report counts the two awards of the seed', async ({ browser }) => {
  const sheet = await p2Sheet()
  const g8 = p2SceneOf(sheet, 15)
  const page = await desk(browser, g8.actor)
  await expectG8(page, p2Expected<G8Figures>(g8, 'afterSeed'))
  await page.context().close()
})

test('@p2demo [FR-SRC-202/AC2] [FR-SRC-202/AC4] scene 9: three suppliers bid on their phones, one with VAT, and procurement sees no price while it is sealed', async ({ browser }) => {
  test.setTimeout(300_000)
  const [sheet, rows] = await Promise.all([p2Sheet(), RFX_ROWS])
  const scene = p2SceneOf(sheet, 9)
  rfx = s10<RfxFacts>('rfx', p2Expected<string>(scene, 'rfx'))
  expect(rfx.status).toBe('OPEN')
  const bidders = [...new Set(rows.bids.map((b) => b.supplier))]
  expect(rfx.invites.map((i) => i.supplierCode).sort()).toEqual([...bidders].sort())
  expect(rfx.invites.length).toBeGreaterThanOrEqual(p2Expected<number>(scene, 'minInvites'))

  // procurement opens the RFQ: its number on the screen, the minimum of invites the estimate asks
  const page = await desk(browser, scene.actor)
  await page.goto(`/sourcing/${rfx.id}`)
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toContainText(/RFX-\d{4}-\d{5}/)
  rfxNumber = (await heading.textContent())!.match(/RFX-\d{4}-\d{5}/)![0]
  expect(rfxNumber).toBe(rfx.number)
  await expect(page.locator('main')).toContainText('จำนวนผู้ขายขั้นต่ำ')

  // each supplier's primary contact bids on a phone, in the contact's language
  for (const code of bidders) {
    const invite = rfx.invites.find((i) => i.supplierCode === code)!
    const contact = invite.contacts.find((c) => c.isPrimary) ?? invite.contacts[0]!
    if (code === scene.supplier) expect(contact.email).toBe(scene.portalActor)
    const lines = rows.bids.filter((b) => b.supplier === code).sort((a, b) => a.lineNo - b.lineNo)
    const phone = await portalPhone(browser, sheet.orgCode, contact.email, contact.locale)
    const portal = await phone.newPage()
    await portal.goto(`/portal/${sheet.orgCode}/rfx/${rfx.id}`)
    await expect(portal.getByRole('heading', { level: 1 })).toBeVisible()
    await bidOnPhone(portal, portalRfxWords(contact.locale), { prices: lines.map((l) => l.unitPrice), includesVat: lines[0]!.includesVat, deliveryDays: lines[0]!.deliveryDays })
    await phone.close()
    const bid = s10<{ status: string; net: string }>('bid', rfx.id, (await supplierIdOf(code))!)
    expect(bid.status).toBe('SUBMITTED')
    expect(bid.net).toBe(p2Expected<Record<string, string>>(scene, 'compareNet')[code])
  }

  // sealed (OQ-201): procurement sees how many bid and who, no price
  await page.goto(`/sourcing/${rfx.id}?tab=bids`)
  await expect(page.getByText(`ยื่นแล้ว ${bidders.length} ราย`).first()).toBeVisible()
  for (const net of Object.values(p2Expected<Record<string, string>>(scene, 'compareNet'))) await expect(page.getByText(bahtText(net))).toHaveCount(0)
  await page.context().close()
})

test('@p2demo [FR-SRC-202/AC3] scene 12: an application that waits is invited while the RFQ is open; its contact asks but cannot bid until it is approved', async ({ browser }) => {
  test.setTimeout(180_000)
  const sheet = await p2Sheet()
  const scene = p2SceneOf(sheet, 12)
  expect(p2Expected<string>(scene, 'rfx')).toBe(p2Expected<string>(p2SceneOf(sheet, 9), 'rfx'))
  expect(p2Expected<string>(scene, 'inviteWhile')).toBe('OPEN')
  const application = applicationOf(sheet, p2Expected<string>(scene, 'application'))
  expect(application.status).toBe('SUBMITTED')
  expect(application.contactEmail).toBe(scene.portalActor)
  const app = s10<{ id: string; status: string; nameTh: string }>('application', application.contactEmail)
  expect(app.status).toBe('SUBMITTED')

  // procurement invites the application from the step "ผู้ขาย" of the open RFQ (BR-RFX-03)
  const page = await desk(browser, scene.actor)
  await page.goto(`/sourcing/${rfx.id}/edit`)
  await page.getByLabel('หรือเชิญจากใบสมัครผู้ขายใหม่').selectOption(app.id)
  await page.getByRole('button', { name: 'เชิญใบสมัครนี้' }).click()
  await expect(page.getByRole('status').filter({ hasText: /^เชิญ .+ แล้ว$/ })).toBeVisible()
  await page.context().close()
  const invites = s10<{ invites: Array<{ supplier: string | null; applicationId: string | null; status: string }>; invitedTo: Array<string | null> }>('invites', rfx.id)
  expect(invites.invites).toContainEqual({ supplier: null, applicationId: app.id, status: 'INVITED' })
  expect(invites.invitedTo).toContain(application.contactEmail)

  // the contact reads the RFx and asks; a bid waits for the application's approval (OQ-202)
  const phone = await portalPhone(browser, sheet.orgCode, application.contactEmail, 'th')
  const portal = await phone.newPage()
  const w = portalRfxWords('th')
  await portal.goto(`/portal/${sheet.orgCode}/rfx/${rfx.id}`)
  await expect(portal.getByRole('heading', { level: 1 })).toBeVisible()
  await portal.getByLabel(w.questions.question, { exact: true }).fill('ส่งเหล็กเป็นมัดละ 1 ตันได้ไหม')
  await portal.getByRole('button', { name: w.questions.send, exact: true }).click()
  await expect(portal.getByRole('status').filter({ hasText: w.notices.asked })).toBeVisible()
  // the page says why there is no bid yet, and offers none; a bid sent anyway is refused by the server
  await expect(portal.getByRole('status').filter({ hasText: w.detail.applicationWaits })).toBeVisible()
  await expect(portal.getByRole('link', { name: w.detail.bid, exact: true })).toHaveCount(0)
  expect(s10<{ code: string | null }>('app-bid', rfx.id, application.contactEmail).code).toBe(p2Expected<string>(scene, 'bidError'))
  await phone.close()
})

test('@p2demo [FR-SRC-202/AC3] [FR-SRC-202/AC5] [FR-SRC-203/AC2] [FR-SRC-203/AC3] [FR-SRC-204/AC2] [FR-SRC-204/AC4] [FR-SRC-204/AC6] scene 9: closed, compared before VAT, scored, awarded, approved on LIFF, and the first PO approved by coo', async ({ browser }) => {
  test.setTimeout(420_000)
  const [sheet, p1, rows] = await Promise.all([p2Sheet(), p1Sheet(), RFX_ROWS])
  const scene = p2SceneOf(sheet, 9)
  const compareNet = p2Expected<Record<string, string>>(scene, 'compareNet')
  const nameOf = new Map(rfx.invites.filter((i) => i.supplierCode).map((i) => [i.supplierCode!, i.supplierName!]))

  // the close at closesAt, as its job; a bid a second later is refused (GC-SRC-20)
  expect(s10<{ closed: boolean; status: string }>('close', rfx.id)).toMatchObject({ closed: true, status: 'CLOSED' })
  const lateSupplier = [...nameOf.keys()].find((c) => c !== scene.supplier)!
  expect(s10<{ code: string | null }>('late-bid', rfx.id, lateSupplier).code).toBe('RFX_CLOSED')

  // the comparison: every bid before VAT, SP0024's VAT taken out of its total (BR-RFX-08)
  let page = await desk(browser, scene.actor)
  await page.goto(`/sourcing/${rfx.id}?tab=bids`)
  for (const net of Object.values(compareNet)) await expect(page.getByText(bahtText(net)).first()).toBeVisible()
  await page.context().close()

  // the evaluators score delivery and quality on their own pages (BR-RFX-09 · independent until both have sent)
  const rated = (await RFX_ROWS).criteria.filter((c) => c.code !== 'PRICE')
  for (const evaluator of [...new Set(rows.scores.map((s) => s.evaluator))]) {
    page = await desk(browser, evaluator)
    await page.goto(`/sourcing/${rfx.id}/score`)
    for (const s of rows.scores.filter((x) => x.evaluator === evaluator)) {
      const criterion = rated.find((c) => c.code === s.criterion)!
      await page.getByLabel(`คะแนน ${criterion.nameTh} ของ ${nameOf.get(s.supplier)}`).fill(String(s.score))
    }
    await page.getByRole('button', { name: 'ส่งคะแนน' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งคะแนน' }).click()
    await expect(page.getByText('ส่งคะแนนแล้ว').first()).toBeVisible()
    await page.context().close()
  }

  // revealed: the totals and the ranking (GC-SRC-08)
  page = await desk(browser, scene.actor)
  await page.goto(`/sourcing/${rfx.id}?tab=scores`)
  for (const total of Object.values(p2Expected<Record<string, string>>(scene, 'totals'))) await expect(page.getByText(total).first()).toBeVisible()

  // the award: both lines to the first, the lowest (no reason), sent for approval
  const winner = p2Expected<string[]>(scene, 'ranking')[0]!
  expect(winner).toBe(scene.supplier)
  const winnerName = nameOf.get(winner)!
  await page.goto(`/sourcing/${rfx.id}/award`)
  for (const [i, net] of p2Expected<string[]>(scene, 'poNets').entries()) {
    await page.getByLabel(new RegExp(`^รายการ ${i + 1} `)).selectOption({ label: `${winnerName} · ${bahtText(net)} บาท (ต่ำสุด)` })
  }
  await page.getByRole('button', { name: 'บันทึกผล' }).click()
  await expect(page.getByText('บันทึกผลแล้ว')).toBeVisible()
  await expect(page.getByText(bahtText(p2Expected<string>(scene, 'awardGross'))).first()).toBeVisible()
  await page.getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'ส่งขออนุมัติ' }).click()
  await expect(page.getByText('ส่งขออนุมัติแล้ว')).toBeVisible()
  await page.context().close()
  const sent = s10<AwardFacts>('award', rfx.id)
  expect(sent).toMatchObject({ status: 'PENDING_APPROVAL', net: p2Expected<string>(scene, 'awardNet'), vat: p2Expected<string>(scene, 'awardVat'), gross: p2Expected<string>(scene, 'awardGross'), reasonCodes: [] })
  expect(sent.route).toMatchObject({ rule: p2Expected<string>(scene, 'rule'), approvers: [p2Expected<string>(scene, 'approver')] })
  expect(sent.number).toMatch(/^AWD-\d{4}-\d{5}$/)

  // the approver on LIFF with the PIN (322,016.50 with VAT is above the step-up threshold)
  const approver = userOf(p1, p2Expected<string>(scene, 'approver'))
  day('prepare', `${approver.code}:${lineUserOf(approver.code)}`)
  const phone = await phoneOf(browser, approver.code)
  try {
    const liff = await phone.newPage()
    await liff.goto(`/liff/tasks/${sent.route!.openTaskId}`)
    await expect(liff.getByText(sent.number!).first()).toBeVisible()
    await expect(liff.getByText(bahtText(sent.gross)).first()).toBeVisible()
    const bar = liff.getByRole('region', { name: 'ตัดสินงานนี้' })
    await bar.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
    await bar.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
    await bar.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
    await expect(liff.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย' })).toBeVisible({ timeout: 15_000 })
  } finally {
    await phone.close()
  }

  // what the approval made (BR-RFX-13 · ADR-206): two draft POs by site, the preferred supplier, the e-mails
  const approved = s10<AwardFacts>('award', rfx.id)
  expect(approved.status).toBe('APPROVED')
  expect(approved.pos.map((p) => p.net)).toEqual(p2Expected<string[]>(scene, 'poNets'))
  expect(approved.pos.every((p) => p.status === 'DRAFT')).toBe(true)
  expect(approved.pos).toHaveLength(p2Expected<number>(scene, 'poCount'))
  expect(approved.preferred).toEqual([expect.objectContaining({ category: 'STEEL', supplier: winner })])
  const losers = [...nameOf.keys()].filter((c) => c !== winner).sort()
  expect(approved.notices).toEqual([{ template: 'rfx.awarded', supplier: winner }, ...losers.map((supplier) => ({ template: 'rfx.not_awarded', supplier }))])

  // procurement sends the first PO; its rule gives it to coo, who approves it on the web with the PIN
  const first = approved.pos[0]!
  page = await desk(browser, scene.actor)
  await page.goto(`/procurement/pos/${first.id}`)
  await expect(page.locator('main')).toContainText(bahtText(first.net))
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  await expect(page.getByText('ส่งขออนุมัติแล้ว').first()).toBeVisible()
  const po = s10<{ number: string | null; status: string; route: { rule: string; approvers: string[]; openTaskId: string | null } | null }>('po', first.id)
  expect(po.route).toMatchObject({ rule: p2Expected<string>(scene, 'poRule'), approvers: [p2Expected<string>(scene, 'poApprover')] })
  await page.reload()
  await expect(page.locator('main')).toContainText(po.number!)
  await page.context().close()

  page = await desk(browser, p2Expected<string>(scene, 'poApprover'))
  await page.goto(`/tasks/${po.route!.openTaskId}`)
  await expect(page.locator('main')).toContainText(po.number!)
  await page.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  const confirm = page.getByRole('group', { name: new RegExp(`^อนุมัติ ${po.number!}`) })
  await confirm.getByLabel('PIN 6 หลัก', { exact: true }).fill(E2E_PIN)
  await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'อนุมัติแล้ว' }).first()).toBeVisible()
  await page.context().close()
  expect(s10<{ status: string }>('po', first.id).status).toBe('APPROVED')
})

/** The supplier's id of a code, from the RFx's invites (scripts/s10.ts bid takes the id) */
async function supplierIdOf(code: string): Promise<string | null> {
  return s10<{ id: string | null }>('supplier', code).id
}
