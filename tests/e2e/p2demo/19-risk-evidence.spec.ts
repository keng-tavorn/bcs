import { devices } from '@playwright/test'
import { th } from '../demo/support'
import { expect, test } from '../fixtures'
import { p2Expected, p2SceneOf, p2Sheet, portalSessionOn, s11 } from './support'

// Scene 19 of the day of phase 2 (S11-15 · "ตอบด้วยหลักฐานและกฎผู้ขายระดับสูง" · FR-RSK-201 AC2 AC3 · BR-RSK-05 BR-RSK-06): the
// row's supplier has an assessment open since the seed (expectJson.assessment: its work scopes and inherent tier), and a
// certificate of S7 VERIFIED for one of its questions (expectJson.evidence: type, scope, last day). Its contact opens it on
// a phone (375 px · a session of the portal the scene script opens: the portal's sign-in is scene 1's): the question the
// certificate answers shows its answer from the certificate, which cannot be changed, and a question of the same type
// whose scope the certificate does not cover (expectJson.notFilled) is not filled. The supplier's tier being high, sending
// is refused until the contact confirms that answer themself (expectJson.submit: the question is among those missing,
// although answered); once confirmed and saved it is no longer missing. The assessment is not sent here: scene 22 answers
// the rest (with the Risk Agent) and sends it. A certificate that expires before sending empties the answer again
// (expectJson.expiredEvidenceClears): golden GC-RSK-16 holds that rule (tests/golden/risk-tier.test.ts), not this scene.

interface Facts {
  readonly assessment: { readonly id: string; readonly number: string | null; readonly status: string; readonly workScopes: string[]; readonly inherentTier: string }
  readonly questions: ReadonlyArray<{ readonly code: string; readonly textTh: string }>
  readonly answers: ReadonlyArray<{ readonly question: string; readonly option: string | null; readonly source: string; readonly evidenceDocument: { readonly docType: string; readonly scope: string | null; readonly expiresOn: string | null } | null }>
}

// the phone at 375 px without Pixel 7's defaultBrowserType, a worker option that would give this file a worker of its own
// (the scenes run in the files' order on one worker)
const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

test('@p2demo [FR-RSK-201/AC2] [FR-RSK-201/AC3] scene 19: a certificate answers its question and nothing it does not cover; a high-risk supplier confirms that answer itself before sending', async ({ page, context }) => {
  const sheet = await p2Sheet()
  const scene = p2SceneOf(sheet, 19)
  const opened = p2Expected<{ status: string; workScopes: string[]; inherentTier: string }>(scene, 'assessment')
  const evidence = p2Expected<{ question: string; docType: string; scope: string; expiresOn: string; option: string; locked: boolean }>(scene, 'evidence')
  const notFilled = p2Expected<Array<{ question: string }>>(scene, 'notFilled')
  const submit = p2Expected<{ error: string; missingIncludes: string[] }>(scene, 'submit')
  const confirm = p2Expected<string>(scene, 'confirmAnswer')
  const facts = s11<Facts>('assessment', scene.supplier!)
  const a = facts.assessment
  expect(a).toMatchObject(opened)
  // BR-RSK-05: the certificate's answer, with the document in scope and in date; nothing for a scope it does not cover
  expect(facts.answers.find((x) => x.question === evidence.question)).toMatchObject({ option: evidence.option, source: 'EVIDENCE', evidenceDocument: { docType: evidence.docType, scope: evidence.scope, expiresOn: evidence.expiresOn } })
  for (const nf of notFilled) expect(facts.answers.find((x) => x.question === nf.question)).toBeUndefined()
  const textOf = (code: string) => facts.questions.find((q) => q.code === code)!.textTh

  await portalSessionOn(context, sheet.orgCode, scene.portalActor!)
  await page.goto(`/portal/${sheet.orgCode}/risk/${a.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(th('portal.risk.assessment.title', { number: a.number! }))
  const part = page.locator(`#q-${evidence.question}`)
  await expect(part.getByText(th('portal.risk.assessment.fromEvidence'))).toBeVisible()
  // locked: the certificate's option is chosen and the person cannot choose another (BR-RSK-06 · EVIDENCE_LOCKED)
  const radios = part.getByRole('radio')
  for (const radio of await radios.all()) await expect(radio).toBeDisabled()
  for (const nf of notFilled) await expect(page.locator(`#q-${nf.question}`).getByText(th('portal.risk.assessment.fromEvidence'))).toHaveCount(0)

  // BR-RSK-06 (high): the send is refused while the certificate's answer waits for the contact's own confirmation
  await page.getByRole('button', { name: th('portal.risk.assessment.send') }).click()
  await expect(page.getByText(th(`portal.risk.errors.${submit.error}`))).toBeVisible()
  for (const code of submit.missingIncludes) await expect(page.locator(`#q-${code}`).getByText(th('portal.risk.assessment.missingMark'))).toBeVisible()
  await expect(page.getByText(th('portal.risk.assessment.missingTitle'))).toBeVisible()
  await expect(page.getByText(textOf(confirm)).first()).toBeVisible()

  // the contact confirms it: the answer stays the certificate's, now the contact's own, and is no longer missing
  await page.locator(`#q-${confirm}`).getByRole('checkbox', { name: th('portal.risk.assessment.confirmEvidence') }).check()
  await page.getByRole('button', { name: th('portal.risk.assessment.save') }).click()
  await expect(page.getByText(th('portal.risk.assessment.saved'))).toBeVisible()
  const after = s11<Facts>('assessment', scene.supplier!)
  expect(after.assessment.status).toBe(opened.status)
  expect(after.answers.find((x) => x.question === confirm)).toMatchObject({ option: evidence.option, source: 'EXPLICIT', evidenceDocument: { docType: evidence.docType } })
  await page.getByRole('button', { name: th('portal.risk.assessment.send') }).click()
  await expect(page.getByText(th(`portal.risk.errors.${submit.error}`))).toBeVisible()
  await expect(page.locator(`#q-${confirm}`).getByText(th('portal.risk.assessment.missingMark'))).toHaveCount(0)
})
