import { formatThaiDate } from '../../../src/core/thai/date'
import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { dayFromToday, p2Expected, p2SceneOf, p2Sheet, s11Status } from './support'

// Scene 20 of the day of phase 2 (S11-15 · S11-09 · BR-RSK-13 BR-RSK-14 · GC-RSK-42 GC-RSK-66 GC-RSK-68 · docs/sub-specs/
// S11.md "Demo ของขั้น" 20): the row's supplier has the seed's assessment of the row's tier, completed on a fixed day
// (expectJson.assessment: completedOn, validUntil, remindOn). Job risk-review-daily is played by the scene script on the
// row's days — the e2e app has no Inngest, so the day it gives the job is the clock of Inngest dev — once each, and only
// read when the supplier already shows what that day makes (a seed played after the day). The script refuses a run that
// would touch anything but this supplier, which keeps scenes 21 (G-9, tiers, override RO of scene 17 open until its last
// day) and 22 (SP0141's open assessment) as they expect: on the seed nothing else is due before 2027. On remind.on: a
// RiskReview SCHEDULED due on remind.dueAt, the reminder e-mail to the supplier (remind.email) with the new assessment it
// opened, and the supplier EXPIRING — the actor reads the review on /risk and the state on the supplier's risk file. On
// overdue.on: OVERDUE on the file, and a new PO of the supplier (drafted by the script like its last one) is refused at
// its submit with the row's code and reason at that day's clock (po.submit as the actor). The app's screens run on the
// real clock (src/lib/clock.ts systemClock; nothing reads E2E_TEST_CLOCK), so the PO page shows that refusal only from
// the day after validUntil; before it the page shows the PO passing on the assessment still valid today. That the new
// assessment, once completed, supersedes the old one (expectJson.reassessed) is S11-09's (tests/integration/
// risk-review-daily.test.ts · GC-RSK-66 to 68): the scene does not answer and review it.

const STATUS_TH: Readonly<Record<string, string>> = { EXPIRING: 'ใกล้ครบรอบ', OVERDUE: 'เกินรอบประเมิน' }
const REVIEW_REASON_TH: Readonly<Record<string, string>> = { SCHEDULED: 'ครบรอบ', STATUS_CHANGED: 'สถานะทะเบียนเปลี่ยน', OVERRIDE_EXPIRED: 'การอนุมัติข้ามหมดอายุ' }
const GATE_REASON_TH: Readonly<Record<string, string>> = { VALIDITY_LAPSED: 'แบบประเมินความเสี่ยงของผู้ขายรายนี้เกินรอบแล้ว ต้องประเมินซ้ำ หรือขออนุมัติข้ามตาม DOA' }

interface SupplierFacts {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly riskStatus: string
  readonly assessment: { readonly id: string; readonly tier: string; readonly completedOn: string; readonly validUntil: string; readonly remindOn: string } | null
  readonly reviews: readonly { readonly reason: string; readonly status: string; readonly dueOn: string; readonly sourceAssessmentId: string | null }[]
}
interface DayFacts {
  readonly ran: boolean
  readonly supplier: SupplierFacts
  readonly openAssessment: { readonly number: string | null; readonly status: string } | null
  readonly notices: readonly string[]
}

test('@p2demo [FR-RSK-205/AC1] [FR-RSK-205/AC2] [FR-RSK-203/AC1] scene 20: risk-review-daily reminds at remindOn (review, e-mail, EXPIRING), turns the supplier OVERDUE after validUntil, and a new PO is refused until it is reassessed', async ({ page }) => {
  test.setTimeout(5 * 60_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 20)
  const assessment = p2Expected<{ tier: string; completedOn: string; validUntil: string; remindOn: string }>(scene, 'assessment')
  const remind = p2Expected<{ job: string; on: string; reviewReason: string; dueAt: string; email: string; riskStatus: string }>(scene, 'remind')
  const overdue = p2Expected<{ on: string; riskStatus: string; gate: { error: string; reason: string } }>(scene, 'overdue')
  expect(remind.job).toBe('risk-review-daily')

  // the seed's assessment of the row
  const seeded = s11Status<SupplierFacts>('supplier', scene.supplier!)
  expect(seeded.assessment).toMatchObject(assessment)
  const assessmentId = seeded.assessment!.id

  // remind.on: the reassessment is scheduled, the supplier reminded by e-mail, its state EXPIRING
  const reminded = s11Status<DayFacts>('daily', seeded.code, remind.on)
  const review = reminded.supplier.reviews.filter((r) => r.reason === remind.reviewReason && r.sourceAssessmentId === assessmentId)
  expect(review).toEqual([expect.objectContaining({ status: 'OPEN', dueOn: remind.dueAt })])
  expect(reminded.notices).toContain(remind.email)
  expect(reminded.openAssessment?.status).toBe('DRAFT')
  // played now, the day's state; read from a seed played after validUntil, it has moved on already
  if (reminded.ran) expect(reminded.supplier.riskStatus).toBe(remind.riskStatus)
  else expect([remind.riskStatus, overdue.riskStatus]).toContain(reminded.supplier.riskStatus)

  await signInAs(page, p1, scene.actor)
  await page.goto('/risk?tab=reviews')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ความเสี่ยงคู่ค้า')
  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: `${seeded.code} ${seeded.nameTh} · ${REVIEW_REASON_TH[remind.reviewReason]}`, exact: true }) })
  await expect(row).toContainText(`กำหนด ${formatThaiDate(remind.dueAt)}`)
  await page.goto(`/risk/suppliers/${seeded.id}`)
  await expect(page.getByRole('region', { name: 'สถานะความเสี่ยง' })).toContainText(STATUS_TH[reminded.supplier.riskStatus]!)
  await expect(page.getByRole('region', { name: 'การประเมินซ้ำ' })).toContainText(`${REVIEW_REASON_TH[remind.reviewReason]} · กำหนด ${formatThaiDate(remind.dueAt)} · เปิดอยู่`)

  // overdue.on: OVERDUE
  const lapsed = s11Status<DayFacts>('daily', seeded.code, overdue.on)
  expect(lapsed.supplier.riskStatus).toBe(overdue.riskStatus)
  await page.reload()
  await expect(page.getByRole('region', { name: 'สถานะความเสี่ยง' })).toContainText(STATUS_TH[overdue.riskStatus]!)

  // a new PO of the supplier: refused at its submit on that day until the reassessment is completed
  const po = s11Status<{ id: string; status: string }>('po-like', seeded.code, scene.actor)
  expect(po.status).toBe('DRAFT')
  expect(s11Status<{ ok: boolean; code: string | null; reason: string | null }>('submit', po.id, scene.actor, overdue.on)).toEqual({ ok: false, code: overdue.gate.error, reason: overdue.gate.reason })
  await page.goto(`/procurement/pos/${po.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(seeded.nameTh)
  const band = page.getByRole('status').filter({ hasText: 'ความเสี่ยงคู่ค้า' })
  if (dayFromToday(0) > assessment.validUntil) {
    await expect(band).toContainText(GATE_REASON_TH[overdue.gate.reason]!)
    await expect(page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })).toBeDisabled()
  } else {
    // today the assessment is still valid: the PO passes on it, and nothing on the page holds the submit
    await expect(page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true })).toBeVisible()
    await expect(band).toHaveCount(0)
  }
})
