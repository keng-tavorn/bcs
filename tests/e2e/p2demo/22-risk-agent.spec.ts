import { devices } from '@playwright/test'
import { E2E_BASE_URL } from '../../support/e2e-env'
import { th } from '../demo/support'
import { p1Sheet, signInAs } from '../p1demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, portalSessionOn, s11 } from './support'

// Scene 22 of the day of phase 2 (S11-15 · S11-13 · "Risk Agent ช่วยตอบแบบประเมินและสรุปแฟ้ม" · FR-AI-306 AC1 AC2 AC3 AC4 AC6 ·
// BR-AI-33 BR-AI-34): it plays on from scene 19, on the same open assessment of the row's supplier. First the
// organization's admin has the Risk Agent off (/admin/ai): the job reads nothing and the contact's page (375 px) shows no
// box of the AI — every question is answered by hand as in scenes 16 to 21 (EG-1 · AC6). With the agent on, job
// risk-ai-draft (played by the scene script: the e2e app has no Inngest) asks the model about the questions still
// unanswered; the model's answer is the row's (expectJson.proposals · the seed's documents carry the day they were seeded,
// so no recorded answer could match another day), and everything after it is the app's: the checks (EVIDENCE_MISSING WARN
// of a certificate's option nobody sent), the confidence in bp and its cap, the draft. The contact sees each proposal
// beside its question with "เติมโดย AI โปรดตรวจ" and confirms them one by one (no confirm-all · BR-AI-33), answers the rest
// by hand (expectJson.byHand) and sends. The tier is the engine's, from the answers (AC4: the AI's output has no points
// or tier). Each reviewer's task gets the summary of its own part (job risk-ai-summary · the row's sentences, every value
// a placeholder the code fills in): the reviewer reads it in its own box on the review page (AC3).

interface Facts {
  readonly supplier: { readonly riskStatus: string }
  readonly assessment: { readonly id: string; readonly number: string | null; readonly status: string; readonly pointsTotal: number | null; readonly tier: string | null; readonly reviewRound: number }
  readonly questions: ReadonlyArray<{ readonly code: string; readonly textTh: string; readonly options: ReadonlyArray<{ readonly code: string; readonly labelTh: string; readonly points: number }> }>
  readonly answers: ReadonlyArray<{ readonly question: string; readonly option: string | null; readonly source: string; readonly points: number; readonly fromAi: boolean }>
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly round: number; readonly status: string; readonly holder: string | null }>
}
interface Proposal {
  readonly question: string
  readonly option: string
  readonly confidenceBp: number
  readonly flag?: string
  readonly severity?: string
  readonly capBp?: number
}
interface Drafted {
  readonly result: string
  readonly actions: ReadonlyArray<{ readonly status: string; readonly output: { answers: Array<{ questionCode: string; optionCode: string }> } | null; readonly fieldConfidence: Record<string, number> | null; readonly verification: { checks: Array<{ questionCode: string; code: string; result: string }> } | null }>
}

/**
 * The confidence the app keeps for a proposal: the model answers a whole percent (scripts/s11.ts ai-draft gives it the row's
 * bp rounded so), the app turns it into bp and caps it by its check (BR-AI-16)
 */
const keptBp = (p: Proposal) => Math.min(Math.round(p.confidenceBp / 100) * 100, p.capBp ?? Number.POSITIVE_INFINITY)

const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

test('@p2demo [FR-AI-306/AC1] [FR-AI-306/AC2] [FR-AI-306/AC3] [FR-AI-306/AC4] [FR-AI-306/AC6] scene 22: with the Risk Agent off the questionnaire is answered by hand; on, it proposes answers the contact confirms one by one, and each reviewer reads a summary of their part', async ({ page, context, browser }) => {
  test.setTimeout(300_000)
  const [sheet, p1] = await Promise.all([p2Sheet(), p1Sheet()])
  const scene = p2SceneOf(sheet, 22)
  const proposals = p2Expected<Proposal[]>(scene, 'proposals')
  const byHand = p2Expected<Record<string, string>>(scene, 'byHand')
  const summary = p2Expected<{ purpose: string; sentences: string[] }>(scene, 'summary')
  const supplier = scene.supplier!
  const facts = s11<Facts>('assessment', supplier)
  const a = facts.assessment
  expect(a.status).toBe('DRAFT')
  // what scene 19 left: the certificate's question answered and confirmed; the row answers each other one once (AI or by hand)
  const rowCodes = [...proposals.map((p) => p.question), ...Object.keys(byHand)]
  expect(new Set(rowCodes).size).toBe(rowCodes.length)
  for (const code of rowCodes) expect(facts.answers.find((x) => x.question === code && x.option !== null), `${code} is still open`).toBeUndefined()
  const labelOf = (code: string, option: string) => facts.questions.find((q) => q.code === code)!.options.find((o) => o.code === option)!.labelTh
  const textOf = (code: string) => facts.questions.find((q) => q.code === code)!.textTh

  // ---------- the Risk Agent off: nothing read, no box, the page as without AI ----------
  s11('agent', 'off')
  expect(s11<Drafted>('ai-draft', a.id)).toMatchObject({ result: 'SKIPPED_AI_AGENT_DISABLED', actions: [] })
  await portalSessionOn(context, sheet.orgCode, scene.portalActor!)
  await page.goto(`/portal/${sheet.orgCode}/risk/${a.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(th('portal.risk.assessment.title', { number: a.number! }))
  await expect(page.getByText(th('portal.risk.ai.title'))).toHaveCount(0)
  for (const p of proposals) await expect(page.getByRole('group', { name: textOf(p.question) }).getByLabel(labelOf(p.question, p.option), { exact: true })).not.toBeChecked()

  // ---------- on: the draft job proposes answers; the app checks and caps them ----------
  s11('agent', 'on')
  const drafted = s11<Drafted>('ai-draft', a.id)
  expect(drafted.result).toBe('DRAFTED')
  const draft = drafted.actions.at(-1)!
  expect(draft.status).toBe('DRAFT')
  expect(draft.output!.answers.map((x) => [x.questionCode, x.optionCode]).sort()).toEqual(proposals.map((p) => [p.question, p.option]).sort())
  // AC4: proposals only — no points, no tier in what the AI wrote
  expect(Object.keys(draft.output!)).toEqual(['answers'])
  for (const p of proposals) {
    expect(draft.fieldConfidence?.[`answers.${p.question}`], `${p.question}'s confidence`).toBe(keptBp(p))
    const check = draft.verification?.checks.find((c) => c.questionCode === p.question)
    if (p.flag) expect(check).toMatchObject({ code: p.flag, result: p.severity })
    else expect(check).toBeUndefined()
  }

  // ---------- the contact confirms each proposal, answers the rest by hand and sends ----------
  await page.reload()
  await expect(page.getByText(th('portal.risk.ai.intro'))).toBeVisible()
  for (const p of proposals) {
    const box = page.locator(`#q-${p.question}`).getByRole('group', { name: th('portal.risk.ai.title') })
    await expect(box).toContainText(th('portal.risk.ai.proposed', { option: labelOf(p.question, p.option) }))
    await expect(box).toContainText(th('portal.risk.ai.confidence', { percent: Math.floor(keptBp(p) / 100) }))
    if (p.flag) await expect(box).toContainText(th(`portal.risk.ai.checks.${p.flag}`))
    await box.getByRole('checkbox', { name: th('portal.risk.ai.confirm') }).check()
  }
  for (const [code, option] of Object.entries(byHand)) await page.getByRole('group', { name: textOf(code) }).getByLabel(labelOf(code, option), { exact: true }).check()
  await page.getByRole('button', { name: th('portal.risk.assessment.save') }).click()
  await expect(page.getByText(th('portal.risk.assessment.saved'))).toBeVisible()
  // every proposal taken in and confirmed: nothing of the AI waits (AI_REVIEW_PENDING would hold the send back)
  await expect(page.getByText(th('portal.risk.ai.pending'))).toHaveCount(0)
  await page.getByRole('button', { name: th('portal.risk.assessment.send') }).click()
  await expect(page.getByText(th('portal.risk.assessment.sent'))).toBeVisible()

  // the answers are the contact's (those from the AI marked so); the points and tier are the engine's
  const sent = s11<Facts>('assessment', supplier)
  expect(sent.assessment.status).toBe('IN_REVIEW')
  for (const p of proposals) expect(sent.answers.find((x) => x.question === p.question)).toMatchObject({ option: p.option, fromAi: true })
  for (const [code, option] of Object.entries(byHand)) expect(sent.answers.find((x) => x.question === code)).toMatchObject({ option, fromAi: false })
  expect(sent.assessment.pointsTotal).toBe(sent.answers.reduce((n, x) => n + x.points, 0))
  expect(sent.assessment.tier).not.toBeNull()

  // ---------- each reviewer's part gets its summary; the reviewer reads it in a box of its own ----------
  const tasks = sent.tasks.filter((t) => t.round === sent.assessment.reviewRound && t.status === 'OPEN')
  expect(tasks.length).toBeGreaterThan(0)
  const written = s11<Array<{ taskId: string; holder: string; result: string }>>('ai-summary', a.id)
  expect(written.map((w) => w.result)).toEqual(tasks.map(() => 'WRITTEN'))
  const reviewer = tasks[0]!
  const desk = await browser.newContext({ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: E2E_BASE_URL, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
  const own = await desk.newPage()
  await signInAs(own, p1, reviewer.holder!)
  await own.goto(`/risk/reviews/${reviewer.id}`)
  const box = own.getByRole('region', { name: th('riskReview.detail.ai.title') })
  await expect(box).toBeVisible()
  // the values are the code's (BR-AI-27): the assessment's number and the supplier's code filled into the first sentence
  await expect(box).toContainText(a.number!)
  await expect(box).toContainText(supplier)
  expect(summary.sentences.length).toBeLessThanOrEqual(5)
  await desk.close()
})
