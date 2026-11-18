import { devices, type Browser, type Page } from '@playwright/test'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { actionsOf, answerTo, cardTo, lineUserOf, tapPostback, th } from '../demo/support'
import { budgetLineOf, day, p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, s11, s7 } from './support'

// Scene 16 of the day of phase 2 (S11-15 · S11 core "PO ถูกกันและประเมินจนผ่าน" · FR-RSK-201 FR-RSK-202 FR-RSK-203 ·
// BR-RSK-03 BR-RSK-08 BR-RSK-09): the row's requester asks to hire the row's supplier for the row's service, answering the
// screening questions of the form (expectJson.request.form) with the DPA it then asks for; the DOA's approver of the row's
// rule approves it and procurement drafts the PO — all through the app's own commands in the scene script (scripts/s11.ts
// po · the screens of asking and approving are scenes of phase 1). On the PO page procurement (others[1]) finds the PO
// blocked by the supplier's risk gate (expectJson.gate: the inherent tier, never assessed), the send for approval off,
// and opens the risk assessment from the band. The supplier's contact opens the e-mailed link on a phone (375 px), signs
// in with the code and answers the questions of the set (expectJson.answers → expectJson.points and tier); the
// reviewers of the workflow's RISK_ASSESSMENT rules get one task each at once (expectJson.reviewers). The PRIVACY
// reviewer returns it on the web, seeing only the general and privacy parts, with words the supplier may read
// (expectJson.returned); the contact changes the answer, attaches the policy as evidence and sends again (same tier).
// Each reviewer then passes from the card in their LINE chat (BR-RSK-08: "ผ่าน" in the chat, no PIN); the assessment
// completes with the tier the engine gave and its review dates (expectJson.completed), and the same PO goes for approval
// past the gate by the assessment (expectJson.passed). The assessment's number is read from the screen. AI plays no part
// here (no draft job is played): every answer is the contact's own (EG-1).

interface SceneRequest {
  readonly requestType: string
  readonly title: string
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly rule: string
  readonly approver: string
}
interface Facts {
  readonly supplier: { readonly riskTier: string | null; readonly riskStatus: string; readonly riskValidUntil: string | null; readonly current: boolean }
  readonly assessment: {
    readonly id: string
    readonly number: string | null
    readonly status: string
    readonly triggerPoId: string | null
    readonly openedBy: string | null
    readonly categoryCodes: string[]
    readonly payeeType: string
    readonly workScopes: string[]
    readonly inherentTier: string
    readonly pointsTotal: number | null
    readonly tier: string | null
    readonly reviewRound: number
    readonly completedOn: string | null
    readonly validUntil: string | null
    readonly remindOn: string | null
  }
  readonly questions: ReadonlyArray<{ readonly code: string; readonly domain: string; readonly textTh: string; readonly options: ReadonlyArray<{ readonly code: string; readonly labelTh: string }> }>
  readonly answers: ReadonlyArray<{ readonly question: string; readonly option: string | null; readonly source: string; readonly files: string[] }>
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly round: number; readonly rules: string[]; readonly domains: string[]; readonly status: string; readonly holder: string | null }>
  readonly notices: ReadonlyArray<{ readonly templateKey: string }>
  readonly links: ReadonlyArray<{ readonly purpose: string; readonly days: number }>
}

const baht = (s: string) => BigInt(s.replace('.', '')).toString()
const todayInBangkok = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
/** A calendar day moved by months (the day clamped to the month's last) or days, as YYYY-MM-DD */
function shift(dayOf: string, by: { months?: number; days?: number }): string {
  const [y, m, d] = dayOf.split('-').map(Number) as [number, number, number]
  const month = new Date(Date.UTC(y, m - 1 + (by.months ?? 0), 1))
  const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate()
  const at = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(d, last)) + (by.days ?? 0) * 86_400_000)
  return at.toISOString().slice(0, 10)
}
const PDF = Buffer.from('%PDF-1.7\n% the PDPA policy of the supplier of scene 16 (synthetic)\n%%EOF\n')

async function phoneOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  return context.newPage()
}
async function deskOf(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  return context.newPage()
}

test('@p2demo [FR-RSK-201/AC1] [FR-RSK-201/AC4] [FR-RSK-201/AC5] [FR-RSK-202/AC1] [FR-RSK-202/AC3] [FR-RSK-202/AC4] [FR-RSK-203/AC1] [FR-RSK-203/AC6] scene 16: a PO to a high-risk supplier never assessed is held at the gate; the supplier answers on a phone, the reviewers return it once and pass it from their LINE cards, and the same PO goes through', async ({ browser }, testInfo) => {
  test.setTimeout(900_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 16)
  const request = p2Expected<SceneRequest>(scene, 'request')
  const gate = p2Expected<{ error: string; reason: string; inherentTier: string }>(scene, 'gate')
  const opened = p2Expected<{ openedBy: string; categoryCodes: string[]; payeeType: string; workScopes: string[]; questions: string[]; linkPurpose: string; linkDays: number; email: string }>(scene, 'assessment')
  const answers = p2Expected<Record<string, string>>(scene, 'answers')
  const reviewers = p2Expected<Record<string, string>>(scene, 'reviewers')
  const returned = p2Expected<{ by: string; domains: string[]; reason: string; share: boolean; answers: Record<string, string>; points: number; tier: string }>(scene, 'returned')
  const completed = p2Expected<{ status: string; validMonths: number; remindDaysBefore: number; riskTier: string; riskStatus: string }>(scene, 'completed')
  const passed = p2Expected<{ event: string; tier: string; source: string }>(scene, 'passed')
  const procurement = scene.others[1]!
  expect(procurement).toBe(opened.openedBy)
  const supplier = scene.supplier!
  // the requester's budget and site for this kind of request: the line of their history's budget key this fiscal year
  const like = [...p1.history.values()].find((h) => h.requester === scene.actor && h.requestType === request.requestType)
  if (!like) throw new Error(`Request_History has no ${request.requestType} of ${scene.actor}`)
  const assessmentOf = () => s11<Facts>('assessment', supplier)

  // the reviewers' phones are linked before the day: the card of a review task goes to a linked member (BR-NOTI-12)
  const inChat = [...new Set(Object.values(reviewers))]
  day('prepare', ...inChat.map((code) => `${code}:${lineUserOf(code)}`))

  // ---------- the request, its approval and the PO's draft (the app's commands) ----------
  const made = s11<{ request: { number: string; netSatang: string; vatSatang: string; grossSatang: string; rule: string; approver: string | null; status: string }; po: { id: string; status: string; supplier: string; grossSatang: string } }>(
    'po',
    '16',
    scene.actor,
    budgetLineOf(p1, like.budgetKey).code,
    like.site ?? '-',
  )
  expect([made.request.netSatang, made.request.vatSatang, made.request.grossSatang]).toEqual([request.net, request.vat, request.gross].map(baht))
  expect([made.request.rule, made.request.approver, made.request.status]).toEqual([request.rule, request.approver, 'APPROVED'])
  expect([made.po.status, made.po.supplier, made.po.grossSatang]).toEqual(['DRAFT', supplier, baht(request.gross)])
  // FR-RSK-203 AC1: po.submit refuses it (a refused command writes nothing)
  const refused = s11<{ ok: boolean; code?: string; details?: { reason?: string; tier?: string } }>('try-submit', made.po.id)
  expect(refused).toMatchObject({ ok: false, code: gate.error, details: { reason: gate.reason, tier: gate.inherentTier } })

  // ---------- procurement: the PO held at the gate, the assessment opened from it ----------
  const desk = await deskOf(browser)
  await signInAs(desk, p1, procurement)
  await desk.goto(`/procurement/pos/${made.po.id}`)
  const band = desk.getByRole('status').filter({ hasText: th('purchaseOrder.risk.band.title') })
  await expect(band).toContainText(th('purchaseOrder.risk.band.blocked', { tier: th(`purchaseOrder.risk.tier.${gate.inherentTier}`) }))
  await expect(band).toContainText(th(`purchaseOrder.risk.band.reason.${gate.reason}`))
  await expect(desk.getByRole('button', { name: th('purchaseOrder.actions.submit.button') })).toBeDisabled()
  await band.getByRole('button', { name: th('purchaseOrder.risk.band.open') }).click()
  await expect(desk).toHaveURL(/\/risk\/assessments\/[0-9a-f-]{36}$/)
  const first = assessmentOf()
  const a = first.assessment
  expect(a).toMatchObject({ status: 'DRAFT', triggerPoId: made.po.id, openedBy: opened.openedBy, categoryCodes: opened.categoryCodes, payeeType: opened.payeeType, workScopes: opened.workScopes, inherentTier: gate.inherentTier })
  expect(a.number).toMatch(/^RSA-\d{4}-\d{5}$/)
  // numbersFromScreen: the number is the one the page shows
  await expect(desk.getByRole('heading', { level: 1 })).toContainText(a.number!)
  expect(first.notices.map((n) => n.templateKey)).toContain(opened.email)
  expect(first.links).toContainEqual({ purpose: opened.linkPurpose, days: opened.linkDays })

  // ---------- the supplier's phone: the link of the e-mail, the code, the questions ----------
  const link = s11<{ templateKey: string; contactId: string; url: string }>('invite-link', a.id)
  expect(link.templateKey).toBe(opened.email)
  const phone = await phoneOf(browser)
  await phone.goto(link.url.replace(/^https?:\/\/[^/]+/, E2E_BASE_URL))
  await phone.getByRole('button', { name: 'ส่งรหัสยืนยันให้ฉัน' }).click()
  await phone.getByLabel('รหัสยืนยัน 6 หลัก').fill(s7<{ code: string }>('code', link.contactId).code)
  await phone.getByRole('button', { name: 'เข้าระบบ' }).click()
  // a contact who has not read this version of the privacy notice reads it first, then lands on the questionnaire
  const notice = phone.getByRole('heading', { level: 1, name: 'ประกาศความเป็นส่วนตัว' })
  const form = phone.getByRole('heading', { level: 1, name: th('portal.risk.assessment.title', { number: a.number! }) })
  await expect(notice.or(form)).toBeVisible()
  if (await notice.isVisible()) {
    await phone.getByRole('button', { name: 'รับทราบ' }).click()
    if (!/\/risk\//.test(phone.url())) await phone.goto(`/portal/${sheet.orgCode}/risk/${a.id}`)
  }
  await expect(form).toBeVisible()
  // FR-RSK-201 AC1: the set chosen by the screening answers (expectJson.assessment.questions), none answered yet
  await expect(phone.getByText(th('portal.risk.assessment.progress', { answered: 0, total: opened.questions.length }))).toBeVisible()
  expect(Object.keys(answers).sort()).toEqual([...opened.questions].sort())
  const choose = async (code: string, option: string) => {
    const q = first.questions.find((x) => x.code === code)
    const label = q?.options.find((o) => o.code === option)?.labelTh
    if (!q || !label) throw new Error(`the questionnaire has no option ${option} of ${code}`)
    await phone.getByRole('group', { name: q.textTh }).getByLabel(label, { exact: true }).check()
  }
  for (const [code, option] of Object.entries(answers)) await choose(code, option)
  await phone.getByRole('button', { name: th('portal.risk.assessment.save') }).click()
  await expect(phone.getByText(th('portal.risk.assessment.saved'))).toBeVisible()
  await expect(phone.getByText(th('portal.risk.assessment.progress', { answered: opened.questions.length, total: opened.questions.length }))).toBeVisible()
  await phone.getByRole('button', { name: th('portal.risk.assessment.send') }).click()
  await expect(phone.getByText(th('portal.risk.assessment.sent'))).toBeVisible()

  // FR-RSK-201 AC4: the points and the tier from the rules; FR-RSK-202 AC1 AC3: one task per reviewer, all at once
  const sent = assessmentOf()
  expect(sent.assessment).toMatchObject({ status: 'IN_REVIEW', pointsTotal: p2Expected<number>(scene, 'points'), tier: p2Expected<string>(scene, 'tier') })
  const roundOf = (f: Facts, round: number) => f.tasks.filter((t) => t.round === round)
  const round1 = roundOf(sent, sent.assessment.reviewRound)
  expect(round1.map((t) => ({ holder: t.holder, status: t.status })).sort((x, y) => x.holder!.localeCompare(y.holder!))).toEqual(
    Object.entries(reviewers)
      .map(([, holder]) => ({ holder, status: 'OPEN' }))
      .sort((x, y) => x.holder.localeCompare(y.holder)),
  )
  for (const [rule, holder] of Object.entries(reviewers)) expect(round1.find((t) => t.holder === holder)?.rules).toContain(rule)

  // ---------- the privacy reviewer returns it on the web, seeing only the general and privacy parts ----------
  const legal = round1.find((t) => t.holder === returned.by)!
  expect([...legal.domains].sort()).toEqual([...returned.domains].filter((d) => d !== 'GENERAL').sort())
  const reviewer = await deskOf(browser)
  await signInAs(reviewer, p1, returned.by)
  await reviewer.goto(`/risk/reviews/${legal.id}`)
  await expect(reviewer.getByRole('heading', { level: 1 })).toContainText(a.number!)
  // FR-RSK-202 AC4: each part of the set shows only to its own reviewer (GENERAL to all)
  for (const q of first.questions.filter((x) => opened.questions.includes(x.code))) {
    // the page lists each as "<code> · <question> ตอบ: …"
    await expect(reviewer.getByRole('listitem').filter({ hasText: `${q.code} · ${q.textTh}` })).toHaveCount(returned.domains.includes(q.domain) ? 1 : 0)
  }
  await reviewer.getByRole('button', { name: th('riskReview.decide.return'), exact: true }).click()
  const dialog = reviewer.getByRole('alertdialog')
  await dialog.getByLabel(th('riskReview.decide.reason')).fill(returned.reason)
  if (returned.share) await dialog.getByRole('checkbox', { name: th('riskReview.decide.share') }).check()
  await dialog.getByRole('button', { name: th('riskReview.decide.return'), exact: true }).click()
  await expect(reviewer.getByText(th('riskReview.decide.returned'))).toBeVisible()
  await reviewer.context().close()
  const back = assessmentOf()
  expect(back.assessment.status).toBe('RETURNED')
  expect(roundOf(back, sent.assessment.reviewRound).map((t) => [t.holder, t.status]).sort()).toEqual(round1.map((t) => [t.holder, t.holder === returned.by ? 'RETURNED' : 'CANCELLED']).sort())
  // BR-RSK-08: the words reach the supplier only because the reviewer allowed it, with a new link
  const again = s11<{ templateKey: string; url: string | null; reason: string | null }>('invite-link', a.id)
  expect(again).toMatchObject({ templateKey: 'supplier.risk_returned', reason: returned.share ? returned.reason : null })

  // ---------- the contact changes the answer, attaches the policy and sends again ----------
  await phone.goto(`/portal/${sheet.orgCode}/risk/${a.id}`)
  await expect(phone.getByText(returned.reason)).toBeVisible()
  for (const [code, option] of Object.entries(returned.answers)) await choose(code, option)
  await phone.getByRole('button', { name: th('portal.risk.assessment.save') }).click()
  await expect(phone.getByText(th('portal.risk.assessment.saved'))).toBeVisible()
  const attach = async (code: string) => {
    const part = phone.locator(`#q-${code}`)
    await part.getByLabel(th('portal.risk.evidence.file')).setInputFiles({ name: `pdpa-policy-${supplier}.pdf`, mimeType: 'application/pdf', buffer: PDF })
    await part.getByRole('button', { name: th('portal.risk.evidence.upload') }).click()
  }
  for (const code of Object.keys(returned.answers)) {
    await attach(code)
    // BR-RSK-18: a contact who has not read the notice that names the AI's processor reads it before the first file
    const outdated = phone.getByText(th('portal.risk.errors.PRIVACY_NOTICE_OUTDATED'))
    await expect(outdated.or(phone.getByText(th('portal.risk.evidence.uploaded')))).toBeVisible()
    if (await outdated.isVisible()) {
      await phone.getByRole('link', { name: th('portal.risk.privacyLink') }).click()
      await expect(phone.getByRole('heading', { level: 1, name: 'ประกาศความเป็นส่วนตัว' })).toBeVisible()
      await phone.getByRole('button', { name: 'รับทราบ' }).click()
      await phone.goto(`/portal/${sheet.orgCode}/risk/${a.id}`)
      await attach(code)
    }
    await expect(phone.getByText(th('portal.risk.evidence.uploaded'))).toBeVisible()
  }
  // the central scan (job file-scan: the e2e app has no Inngest) clears the file for the reviewers
  expect(s11<{ scanned: number }>('scan-evidence', a.id).scanned).toBe(Object.keys(returned.answers).length)
  await phone.getByRole('button', { name: th('portal.risk.assessment.send') }).click()
  await expect(phone.getByText(th('portal.risk.assessment.sent'))).toBeVisible()
  await phone.context().close()
  const resent = assessmentOf()
  expect(resent.assessment).toMatchObject({ status: 'IN_REVIEW', pointsTotal: returned.points, tier: returned.tier })
  for (const code of Object.keys(returned.answers)) expect(resent.answers.find((x) => x.question === code)).toMatchObject({ option: returned.answers[code], files: ['CLEAN'] })
  const round2 = roundOf(resent, resent.assessment.reviewRound)
  expect(resent.assessment.reviewRound).toBeGreaterThan(sent.assessment.reviewRound)
  expect(round2.map((t) => t.holder).sort()).toEqual(Object.values(reviewers).sort())

  // ---------- each reviewer passes from the card in the LINE chat ----------
  for (const task of round2) {
    const holder = task.holder!
    const delivered = day<Array<{ templateKey: string; outcome: { status: string; channel?: string } }>>('deliver', holder, a.id)
    expect(delivered.map((n) => ({ templateKey: n.templateKey, status: n.outcome.status, channel: n.outcome.channel }))).toContainEqual({ templateKey: 'risk.review_assigned', status: 'SENT', channel: 'LINE' })
    const card = await cardTo(holder, a.number!)
    const pass = actionsOf(card).filter((x) => x.type === 'postback' && /(^|&)a=risk_pass(&|$)/.test(x.data ?? ''))
    expect(pass, `${holder}'s card carries one "ผ่าน" in the chat`).toHaveLength(1)
    expect(pass[0]!.data).toBe(`v=1&a=risk_pass&t=${task.id}`)
    const tap = tapPostback(testInfo, holder, pass[0]!.data!)
    expect(tap.status, tap.printed).toBe(200)
    await answerTo(tap)
  }

  // ---------- the assessment completes with the engine's tier; the same PO passes the gate ----------
  const done = assessmentOf()
  const today = todayInBangkok()
  const validUntil = shift(today, { months: completed.validMonths })
  expect(done.assessment).toMatchObject({ status: completed.status, tier: returned.tier, completedOn: today, validUntil, remindOn: shift(validUntil, { days: -completed.remindDaysBefore }) })
  expect(done.tasks.filter((t) => t.round === resent.assessment.reviewRound).every((t) => t.status === 'PASSED')).toBe(true)
  expect(done.supplier).toMatchObject({ riskTier: completed.riskTier, riskStatus: completed.riskStatus, riskValidUntil: validUntil, current: true })

  await desk.goto(`/procurement/pos/${made.po.id}`)
  await expect(desk.getByRole('status').filter({ hasText: th('purchaseOrder.risk.band.title') })).toHaveCount(0)
  await desk.getByRole('button', { name: th('purchaseOrder.actions.submit.button') }).click()
  await expect(desk.getByText(th('purchaseOrder.actions.submit.done'))).toBeVisible()
  const gated = s11<{ status: string; passed: Array<{ tier?: string; source?: string; assessmentId?: string }> }>('po-gate', made.po.id)
  expect(gated.status).toBe('PENDING_APPROVAL')
  expect(gated.passed.at(-1)).toMatchObject({ tier: passed.tier, source: passed.source, assessmentId: a.id })
  await desk.context().close()
})
