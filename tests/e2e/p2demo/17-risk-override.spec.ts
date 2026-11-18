import { devices } from '@playwright/test'
import { E2E_BASE_URL, E2E_PIN } from '../../support/e2e-env'
import { actionsOf, cardTo, liffPathOf, lineUserOf, openLiffAs, th } from '../demo/support'
import { budgetLineOf, day, p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet, s11 } from './support'

// Scene 17 of the day of phase 2 (S11-15 · S11 core "อนุมัติข้ามตาม DOA" · FR-RSK-203 AC1 AC2 AC3 AC5 · BR-RSK-09 BR-RSK-10
// BR-RSK-11 · BR-DOA-28): an urgent IT purchase of the row's supplier (expectJson.po · its title that of the supplier's
// purchase in the history) is asked, approved and drafted as a PO through the app's commands (scripts/s11.ts po). The
// supplier's inherent tier is high, its assessment is still open and the seed's override (expectJson.expiredSeedOverride)
// has expired, so the gate holds the PO (expectJson.gate). On the PO page procurement (the row's actor) follows
// "ขออนุมัติข้าม" and asks for one: the reason, the cap and the last day of expectJson.override. Sent, it goes the DOA's
// way for its document type (rule and approver of the row; the cap is the amount): the approver (others[0]) gets a card
// with no approve in the chat (BR-RSK-11) whose button opens the task in LIFF; there, on a phone, they read the reason,
// the tier and the open assessment and approve with the PIN (the cap reaches the step-up threshold). The same PO then
// goes for approval past the gate by the override (expectJson.passed), the supplier's assessment still open beside it
// (expectJson.parallelAssessment), and a payment run on expectJson.payment.payDate would flag it (S9's flag · AC5).

interface ScenePo {
  readonly requestType: string
  readonly net: string
  readonly vat: string
  readonly gross: string
}
interface Override {
  readonly reason: string
  readonly capGross: string
  readonly expiresOn: string
  readonly expectedNo: string
  readonly amount: { readonly net: string; readonly vat: string }
  readonly documentType: string
  readonly rule: string
  readonly approver: string
  readonly stepUp: boolean
  readonly chatButton: boolean
  readonly status: string
}

const satang = (s: string) => BigInt(s.replace('.', '')).toString()

test('@p2demo [FR-RSK-203/AC1] [FR-RSK-203/AC2] [FR-RSK-203/AC3] [FR-RSK-203/AC5] [FR-RSK-203/AC6] scene 17: a PO to a high-risk supplier whose override expired asks for a new one; the approver of the DOA approves it in LIFF with the PIN and the same PO goes through', async ({ browser }) => {
  test.setTimeout(600_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 17)
  const po = p2Expected<ScenePo>(scene, 'po')
  const gate = p2Expected<{ error: string; reason: string; inherentTier: string; assessment: string }>(scene, 'gate')
  const asked = p2Expected<Override>(scene, 'override')
  const passed = p2Expected<{ event: string; tier: string; source: string }>(scene, 'passed')
  const parallel = p2Expected<{ status: string; riskStatus: string }>(scene, 'parallelAssessment')
  const payment = p2Expected<{ payDate: string; flag: string; overrideExpiresOn: string }>(scene, 'payment')
  const supplier = scene.supplier!
  const approver = scene.others[0]!
  expect(asked.approver).toBe(approver)
  // the supplier's purchase of this kind in the history: its requester, budget key, site and title
  const like = [...p1.history.values()].find((h) => h.supplier === supplier && h.requestType === po.requestType)
  if (!like) throw new Error(`Request_History has no ${po.requestType} of ${supplier}`)

  // the approver's phone is linked before the day (the card goes to a linked member)
  day('prepare', `${approver}:${lineUserOf(approver)}`)

  // ---------- the request, its approval and the PO's draft (the app's commands) ----------
  const made = s11<{ request: { netSatang: string; vatSatang: string; grossSatang: string; status: string }; po: { id: string; status: string; supplier: string; grossSatang: string } }>('po', '17', like.requester, budgetLineOf(p1, like.budgetKey).code, like.site ?? '-', like.ref)
  expect([made.request.netSatang, made.request.vatSatang, made.request.grossSatang, made.request.status]).toEqual([...[po.net, po.vat, po.gross].map(satang), 'APPROVED'])
  expect([made.po.status, made.po.supplier]).toEqual(['DRAFT', supplier])
  const refused = s11<{ ok: boolean; code?: string; details?: { reason?: string; tier?: string } }>('try-submit', made.po.id)
  expect(refused).toMatchObject({ ok: false, code: gate.error, details: { reason: gate.reason, tier: gate.inherentTier } })
  // the seed's override is the one that expired
  const before = s11<{ number: string | null; status: string; supplierRiskStatus: string }>('override', supplier)
  expect([before.number, before.status]).toEqual([p2Expected<string>(scene, 'expiredSeedOverride'), 'EXPIRED'])
  expect(before.supplierRiskStatus).toBe(gate.assessment)

  // ---------- procurement asks for an override from the PO ----------
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const page = await desk.newPage()
  await signInAs(page, p1, scene.actor)
  await page.goto(`/procurement/pos/${made.po.id}`)
  const band = page.getByRole('status').filter({ hasText: th('purchaseOrder.risk.band.title') })
  await expect(band).toContainText(th(`purchaseOrder.risk.band.reason.${gate.reason}`))
  await expect(page.getByRole('button', { name: th('purchaseOrder.actions.submit.button') })).toBeDisabled()
  await band.getByRole('link', { name: th('purchaseOrder.risk.band.requestOverride') }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(th('risk.override.form.title'))
  const form = page.getByRole('form', { name: th('risk.override.form.label') })
  await form.getByLabel(th('risk.override.form.reason')).fill(asked.reason)
  await form.getByLabel(th('risk.override.form.cap')).fill(asked.capGross)
  // BR-RSK-10: the last day is picked on the calendar, within overrideMaxDays of today
  await form.getByRole('button', { name: th('risk.override.form.expiresOn') }).click()
  const calendar = page.getByRole('dialog', { name: th('risk.override.form.expiresOn') })
  // a day's button reads "วัน…ที่ 31 ธันวาคม 2026" (the calendar's Thai labels, the year as the calendar counts it)
  const [y, m, d] = asked.expiresOn.split('-').map(Number) as [number, number, number]
  const month = new Intl.DateTimeFormat('th-TH', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
  const target = calendar.getByRole('button', { name: new RegExp(`ที่ ${d} ${month} ${y}$`) })
  for (let i = 0; i < 4 && !(await target.isVisible()); i++) await calendar.getByRole('button', { name: 'ไปเดือนถัดไป' }).click()
  await target.click()
  await form.getByRole('button', { name: th('risk.override.form.create') }).click()
  await expect(page).toHaveURL(/\/risk\/overrides\/[0-9a-f-]{36}$/)
  await page.getByRole('button', { name: th('risk.override.detail.submit') }).click()
  await expect(page.getByText(th('risk.override.detail.sent'))).toBeVisible()

  // FR-RSK-203 AC2 AC3: the DOA's route of RISK_OVERRIDE, the cap as its amount (no VAT), its rule and approver
  const sent = s11<{ id: string; number: string; status: string; capGrossSatang: string; expiresOn: string; route: { subjectType: string; rule: string; amountSatang: string; stepUpThresholdSatang: string | null }; tasks: Array<{ id: string; status: string; holder: string }> }>('override', supplier)
  expect(sent).toMatchObject({ number: asked.expectedNo, status: 'PENDING_APPROVAL', capGrossSatang: satang(asked.capGross), expiresOn: asked.expiresOn })
  expect(sent.route).toMatchObject({ subjectType: asked.documentType, rule: asked.rule, amountSatang: (BigInt(satang(asked.amount.net)) + BigInt(satang(asked.amount.vat))).toString() })
  expect(sent.route.stepUpThresholdSatang !== null && BigInt(sent.route.amountSatang) >= BigInt(sent.route.stepUpThresholdSatang)).toBe(asked.stepUp)
  const task = sent.tasks.find((t) => t.status === 'OPEN')!
  expect(task.holder).toBe(approver)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(sent.number)

  // ---------- the approver: a card without approve in the chat, LIFF with the PIN ----------
  const delivered = day<Array<{ templateKey: string; outcome: { status: string; channel?: string } }>>('deliver', approver, sent.id)
  expect(delivered.map((n) => ({ templateKey: n.templateKey, status: n.outcome.status, channel: n.outcome.channel }))).toContainEqual({ templateKey: 'task.assigned', status: 'SENT', channel: 'LINE' })
  const card = await cardTo(approver, sent.number)
  const buttons = actionsOf(card)
  // BR-RSK-11 (expectJson.override.chatButton): nothing approves in the chat
  expect(buttons.filter((b) => b.type === 'postback' && /a=approve/.test(b.data ?? ''))).toHaveLength(asked.chatButton ? 1 : 0)
  const open = buttons.find((b) => b.type === 'uri' && (b.uri ?? '').includes(task.id))
  expect(open, 'the card opens the task in LIFF').toBeDefined()
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  await openLiffAs(phone, approver)
  const liff = await phone.newPage()
  await liff.goto(liffPathOf(open!.uri!))
  await expect(liff).toHaveURL(new RegExp(`/liff/tasks/${task.id}`))
  // the approver reads why, how risky, and the assessment still open before deciding
  await expect(liff.getByText(asked.reason)).toBeVisible()
  const confirm = liff.getByRole('region', { name: 'ตัดสินงานนี้' }).getByRole('group', { name: new RegExp(`^อนุมัติ ${sent.number} `) })
  if (!(await confirm.isVisible())) await liff.getByRole('button', { name: 'อนุมัติ', exact: true }).click()
  await confirm.getByLabel('PIN 6 หลัก').fill(E2E_PIN)
  await confirm.getByRole('button', { name: 'ยืนยันอนุมัติ' }).click()
  await expect(liff.getByRole('status').filter({ hasText: 'อนุมัติแล้วโดย' })).toBeVisible({ timeout: 15_000 })
  await phone.close()
  const approved = s11<{ status: string; tasks: Array<{ id: string; status: string; decision: string; channel: string }>; stepUps: Array<{ method: string; used: boolean }> }>('override', supplier)
  expect(approved.status).toBe(asked.status)
  expect(approved.tasks.find((t) => t.id === task.id)).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', channel: 'LIFF' })
  expect(approved.stepUps).toContainEqual({ method: 'PIN', used: true })

  // ---------- the same PO goes for approval past the gate by the override ----------
  await page.goto(`/procurement/pos/${made.po.id}`)
  await expect(page.getByRole('status').filter({ hasText: th('purchaseOrder.risk.band.title') })).toContainText(th('purchaseOrder.risk.band.override', { number: sent.number }))
  await page.getByRole('button', { name: th('purchaseOrder.actions.submit.button') }).click()
  await expect(page.getByText(th('purchaseOrder.actions.submit.done'))).toBeVisible()
  const gated = s11<{ status: string; overrideId: string | null; passed: Array<{ tier?: string; source?: string; overrideId?: string }> }>('po-gate', made.po.id)
  expect(gated.status).toBe('PENDING_APPROVAL')
  expect(gated.passed.at(-1)).toMatchObject({ tier: passed.tier, source: passed.source, overrideId: sent.id })
  await desk.close()
  // the assessment goes on beside it
  const file = s11<{ supplier: { riskStatus: string }; assessment: { status: string } }>('assessment', supplier)
  expect([file.assessment.status, file.supplier.riskStatus]).toEqual([parallel.status, parallel.riskStatus])
  // FR-RSK-203 AC5 (S9): a run paying after the override's last day sees it expired and asks a reason
  expect(payment.overrideExpiresOn).toBe(asked.expiresOn)
  expect(s11<{ overrides: Array<{ expiresOn: string }> }>('pay-flag', supplier, payment.payDate).overrides).toEqual([{ expiresOn: payment.overrideExpiresOn }])
  expect(dayFromToday(0) <= asked.expiresOn).toBe(true)
})
