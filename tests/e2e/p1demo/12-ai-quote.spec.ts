import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { baht, literally, th } from '../demo/support'
import { addDays, confirmAiValues, docSampleFile, intakeFieldLabel, moneyValue, recordedAnswerOf, s13, seedFormOf } from './ai-steps'
import { approverByRule, budgetLineOf, columnOf, countedOf, day, expectedOf, p1Sheet, satangOf, sceneOf, signInAs, todayInBangkok, userOf } from './support'

// Scene 12 of phase 1 (sheet Demo_Script_P1, area AI_QUOTE · S13 · FR-AI-302 FR-AI-303 · BR-AI-02 BR-AI-16): the row's
// foreman opens the form of the row's startType, writes a few words in step 0 "ให้ AI ช่วยกรอก (ไม่บังคับ)" and attaches
// the quotation of sheet DocSamples (a PDF: the web uploads it as it is). The Intake Agent reads it in the background
// (the e2e app has no Inngest: ./scripts/s13.ts plays the job with the row's own reading — no recorded answer can match
// a web step 0, whose text lists the organization's types and sites) and says a type fits better: "เปลี่ยนประเภท" is a
// plain link to that type's form, which drops what was filled, so step 0 runs again there (expectJson.intakeRuns). Every
// value it filled carries "เติมโดย AI โปรดตรวจ"; the quantity, the price and the supplier of the register are confirmed one
// by one, the rest together. The foreman answers what the AI never fills (the form's own fields, the budget line, prices
// with VAT, the day the service ends, the screening questions), adds the quotation's file and has the Document Agent read
// it (the recorded LIVE answer of that file, AI_MODE=fixture), confirms the supplier and the amount one by one, gives the
// reason for a single supplier and sends: the request routes by the row's DOA rule to its approver, the confirmed
// quotation is kept with the supplier of the register and the file read, and both AI actions end ACCEPTED on it.

interface IntakePlayed {
  readonly pending: number
  readonly drafted: number
  readonly failed: readonly (string | null)[]
  readonly asked: number | null
}
interface ReadPlayed {
  readonly drafted: number
  readonly failed: readonly (string | null)[]
}
interface SentRequest {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly title: string
  readonly requestType: string
  readonly priceIncludesVat: boolean
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly formData: Readonly<Record<string, unknown>>
  readonly budgetLine: string | null
  readonly site: string | null
  readonly suggestedSupplier: string | null
  readonly lines: ReadonlyArray<{ readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string; readonly serviceEndDate: string | null }>
  readonly quotations: ReadonlyArray<{
    readonly supplier: string | null
    readonly supplierName: string
    readonly amount: string
    readonly includesVat: boolean
    readonly net: string
    readonly selected: boolean
    readonly file: { readonly fileName: string; readonly mimeType: string; readonly sha256: string | null } | null
  }>
  readonly route: { readonly ruleCode: string; readonly amountBasis: string; readonly amount: string | null } | null
  readonly tasks: ReadonlyArray<{ readonly id: string; readonly stepNo: number; readonly status: string; readonly assignee: string | null }>
  readonly flags: readonly string[]
  readonly actions: ReadonlyArray<{ readonly purpose: string; readonly status: string }>
  readonly events: readonly string[]
}
interface AiLine {
  readonly description: string
  readonly qty: string
  readonly unit: string
  readonly unitPrice: string
}
interface Quotation {
  readonly docNo: string
  readonly supplierName: string
  readonly amount: string
  readonly net: string
  readonly includesVat: boolean
  readonly mustConfirm: readonly ('supplierName' | 'supplierId' | 'amount' | 'includesVat')[]
}

const nextStep = (page: Page, step: 'items' | 'supplier' | 'questions' | 'documents' | 'review') =>
  page.getByRole('button', { name: `${th('requestForm.wizard.next')}: ${th(`requestForm.wizard.${step}`)}`, exact: true }).click()
/** The draft's line in the form's header once a save went through ("บันทึกร่างแล้ว 14:05 น.") */
const savedLine = (page: Page) => page.getByRole('status').filter({ hasText: new RegExp(`^${literally(th('requestForm.save.saved', { time: '' }).trim())}`) })

test('@p1demo [FR-AI-302/AC1] [FR-AI-302/AC2] [FR-AI-303/AC1] [FR-AI-303/AC3] scene 12: the foreman attaches the backhoe quotation in step 0; the AI suggests the service type, fills the form and reads the quotation, each value confirmed before the request goes to the approver of the DOA', async ({
  page,
}) => {
  // Two background readings and a step-by-step form of six steps, each played and waited on for real
  test.setTimeout(8 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 12)
  const actor = userOf(sheet, scene.actor)
  const startType = expectedOf<string>(scene, 'startType')
  const aiType = expectedOf<string>(scene, 'aiType')
  const finalType = expectedOf<string>(scene, 'finalType')
  expect(finalType, 'the type the request is sent with is the row requestType').toBe(columnOf(scene, 'requestType'))
  expect(aiType, 'the AI suggests another type than the form first opened (FR-AI-302 AC2)').not.toBe(startType)
  const intakeText = expectedOf<string>(scene, 'intakeText')
  const aiLines = expectedOf<AiLine[]>(scene, 'aiLines')
  const quotation = expectedOf<Quotation>(scene, 'quotation')
  const answers = expectedOf<Record<string, string>>(scene, 'form')
  const line = budgetLineOf(sheet, columnOf(scene, 'budgetKey'))
  const approver = userOf(sheet, scene.expectedApprover)
  expect(approverByRule(sheet, columnOf(scene, 'expectedRule'), columnOf(scene, 'chargedDept')).code, `rule ${scene.expectedRule} names ${approver.code}`).toBe(approver.code)
  const supplier = sheet.suppliers.get(columnOf(scene, 'supplier'))!
  expect(supplier.nameTh, 'the quotation is the supplier of the row').toBe(quotation.supplierName)
  // The quotation's amounts are the row's: with VAT as the request counts it, before VAT as it is compared
  expect([satangOf(quotation.amount), satangOf(quotation.net)]).toEqual([columnOf(scene, quotation.includesVat ? 'gross' : 'net'), columnOf(scene, 'net')])

  // The quotation of sheet DocSamples: its file as the evaluation set made it, with its recorded LIVE reading
  const sample = sheet.docSamples.get(columnOf(scene, 'docSample'))!
  expect(sample, `DocSamples ${scene.docSample}`).toMatchObject({ docType: 'QUOTATION', supplierCode: scene.supplier, docNo: quotation.docNo, net: scene.net, vat: scene.vat, gross: scene.gross })
  const upload = docSampleFile(columnOf(scene, 'docSample'), expectedOf<string>(scene, 'uploadName'))
  expect(recordedAnswerOf(upload.purpose, upload.sha256), `the recorded ${upload.purpose} answer of ${scene.docSample}`).not.toBeNull()
  const file = { name: upload.name, mimeType: upload.mimeType, buffer: upload.buffer }

  const budgetBasis = sheet.settings.get('budgetBasis') === 'GROSS' ? 'gross' : 'net'
  const before = BigInt(day<{ available: string }>('budget', line.code).available)
  const startedAt = Date.now()
  await signInAs(page, sheet, actor.code)

  /** Step 0 of the form open now: the row's words and the quotation, read in the background by the played job */
  async function stepZero() {
    const step0 = page.getByRole('region', { name: th('aiAssist.intake.title') })
    await step0.getByLabel(th('aiAssist.intake.textLabel')).fill(intakeText)
    await step0.locator('input[type="file"]').setInputFiles(file)
    await expect(step0.getByText(th('aiAssist.intake.fileAttached', { name: file.name }), { exact: true })).toBeVisible()
    await step0.getByRole('button', { name: th('aiAssist.intake.start'), exact: true }).click()
    await expect(step0.getByRole('status').filter({ hasText: th('aiAssist.reading') })).toBeVisible()
    const played = s13<IntakePlayed>('intake', String(scene.scene), String(startedAt))
    expect(played, 'the Intake Agent read what the foreman gave it').toMatchObject({ pending: 1, drafted: 1, failed: [] })
    await expect(step0.getByRole('status').filter({ hasText: th('aiAssist.reading') })).toHaveCount(0, { timeout: 30_000 })
    return { step0, played }
  }
  const suggestion = th('aiAssist.intake.suggestType', { name: sheet.requestTypes.get(aiType)! })

  // 1. The form the foreman opened first: the AI says which type fits better and leaves the choice to them (AC2)
  await page.goto(`/requests/new/${startType}`)
  const first = await stepZero()
  await expect(first.step0.getByRole('status').filter({ hasText: suggestion })).toBeVisible()
  // What it filled is saved with that draft before the page is left (no question on leaving)
  await expect(savedLine(page)).toBeVisible({ timeout: 30_000 })
  await first.step0.getByRole('link', { name: th('aiAssist.intake.changeType'), exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/new/${aiType}$`))

  // 2. The suggested type's form: step 0 again with the same words and file; the type now fits, nothing is suggested
  const again = await stepZero()
  expect(again.played.asked, 'step 0 ran once in each form').toBe(expectedOf<number>(scene, 'intakeRuns'))
  await expect(again.step0.getByRole('status').filter({ hasText: th('aiAssist.intake.suggestType', { name: '' }).trim() })).toHaveCount(0)
  const intakeBox = again.step0.getByRole('region', { name: th('aiAssist.intake.boxTitle') })
  await expect(page.getByRole('textbox', { name: new RegExp(`^${literally(th('requestForm.details.title'))}`) })).toHaveValue(expectedOf<string>(scene, 'aiTitle'))
  await expect(intakeBox).toContainText(sheet.sites.get(expectedOf<string>(scene, 'aiSite'))!)
  await expect(intakeBox).toContainText(sheet.suppliers.get(expectedOf<string>(scene, 'aiSupplier'))!.nameTh)
  for (const l of aiLines) {
    await expect(intakeBox).toContainText(l.description)
    await expect(intakeBox).toContainText(baht(satangOf(l.unitPrice)!))
  }
  // The quantity, the price and the supplier of the register one by one; the title, the site and the words together
  await confirmAiValues(intakeBox, expectedOf<string[]>(scene, 'intakeMustConfirm').map(intakeFieldLabel))

  // 3. Details the AI never fills: the form's own fields (the screening questions come later)
  const form = seedFormOf(finalType)
  const screening = Object.entries(answers).filter(([id]) => form.fields.get(id)?.type === 'select')
  for (const [id, value] of Object.entries(answers)) {
    const field = form.fields.get(id)
    expect(field, `the form of ${finalType} has a field ${id}`).toBeDefined()
    if (field!.type !== 'select') await page.getByLabel(new RegExp(`^${literally(field!.label.th)}`)).fill(value)
  }

  // 4. Items: the budget line of the row in this fiscal year, prices with VAT as on the quotation, the day the service ends
  await nextStep(page, 'items')
  const budget = page.getByLabel(th('requestForm.budget.line'))
  const option = await budget.locator('option').filter({ hasText: th('requestForm.budget.option', { code: line.code, name: line.nameTh }) }).first().getAttribute('value')
  expect(option, `the foreman may use ${line.code}`).toBeTruthy()
  await budget.selectOption(option!)
  if (expectedOf<boolean>(scene, 'priceIncludesVat')) await page.getByLabel(th('requestForm.lines.pricesIncludeVat')).check()
  const serviceEnd = addDays(todayInBangkok(), expectedOf<number>(scene, 'serviceEndInDays'))
  for (const [i, l] of aiLines.entries()) {
    const group = page.getByRole('group', { name: th('requestForm.lines.line', { n: i + 1 }) })
    await expect(group.getByLabel(th('requestForm.lines.description'))).toHaveValue(l.description)
    await expect(group.getByLabel(th('requestForm.lines.serviceEndDate'))).toBeVisible()
    await group.getByLabel(th('requestForm.lines.serviceEndDate')).fill(serviceEnd)
  }

  // 5. The quotation: its file read by the Document Agent, the supplier and the amount confirmed one by one (FR-AI-303)
  await nextStep(page, 'supplier')
  await page.getByRole('button', { name: th('requestForm.quotations.add'), exact: true }).click()
  const quote = page.getByRole('group', { name: th('requestForm.quotations.item', { n: 1 }) })
  await quote.locator('input[type="file"]').setInputFiles(file)
  await expect(quote.getByText(th('requestForm.quotations.file', { name: file.name }))).toBeVisible()
  await expect(savedLine(page)).toBeVisible({ timeout: 30_000 })
  await quote.getByRole('button', { name: th('aiAssist.readQuotation', { n: 1 }), exact: true }).click()
  await expect(quote.getByRole('status').filter({ hasText: th('aiAssist.reading') })).toBeVisible()
  const read = s13<ReadPlayed>('read', String(scene.scene))
  expect(read, 'the Document Agent read the quotation from its recorded answer').toMatchObject({ drafted: 1, failed: [] })
  const quoteBox = quote.getByRole('region', { name: th('aiAssist.quotationTitle', { n: 1 }) })
  await expect(quoteBox).toBeVisible({ timeout: 30_000 })
  await expect(quote.getByLabel(th('requestForm.quotations.amount'))).toHaveValue(moneyValue(satangOf(quotation.amount)!))
  await expect(quote.getByLabel(th('requestForm.quotations.supplier'))).toHaveValue(quotation.supplierName)
  if (quotation.includesVat) await expect(quote.getByLabel(th('requestForm.quotations.includesVat'))).toBeChecked()
  await expect(quote).toContainText(th('requestForm.quotations.net', { amount: baht(satangOf(quotation.net)!) }))
  await expect(quoteBox).toContainText(quotation.docNo)
  await confirmAiValues(quoteBox, quotation.mustConfirm.map((f) => th(`aiAssist.fields.${f}`)))
  await quote.getByLabel(th('requestForm.quotations.choose', { n: 1 })).check()

  // 6. The screening questions, as the row answers them
  await nextStep(page, 'questions')
  for (const [id, value] of screening) {
    const field = form.fields.get(id)!
    await page.getByRole('group', { name: new RegExp(literally(field.label.th)) }).getByLabel(field.optionLabels![value]!.th, { exact: true }).check()
  }

  // 7. Documents: one quotation above the amount that asks for three, so the reason for a single supplier; a rule whose
  // answer the row does not give stays out (the DPA of a supplier that processes no personal data)
  await nextStep(page, 'documents')
  const reasonField = [...form.fields.values()].find((f) => form.rules.some((r) => JSON.stringify(r.require ?? null).includes(`"field":"${f.id}"`)))
  const quotesRule = form.rules.find((r) => reasonField && JSON.stringify(r.require ?? null).includes(`"field":"${reasonField.id}"`))
  expect(quotesRule, `a rule of ${finalType} asks for quotations or a reason`).toBeDefined()
  const quotesItem = page.locator(`[data-rule="${quotesRule!.id}"]`)
  await expect(quotesItem).toContainText(th('requestForm.documents.notMet'))
  await page.getByLabel(new RegExp(`^${literally(reasonField!.label.th)}`)).fill(expectedOf<string>(scene, 'singleSupplierReasonTh'))
  await expect(quotesItem).toContainText(th('requestForm.documents.met'))
  for (const rule of form.rules) {
    const field = rule.when?.field
    if (rule.when?.op === 'eq' && field && answers[field] !== undefined && answers[field] !== rule.when.value) await expect(page.locator(`[data-rule="${rule.id}"]`)).toHaveCount(0)
  }

  // 8. Check and send: the request goes to the approver the DOA names
  await nextStep(page, 'review')
  await expect(page.getByText(baht(columnOf(scene, 'gross'))).filter({ visible: true }).first()).toBeVisible()
  await page.getByRole('button', { name: th('requestForm.submit.send'), exact: true }).click()
  const sent = page.getByRole('status').filter({ hasText: th('requestForm.sent.send') })
  await expect(sent).toContainText(th('requestForm.sent.sendWaiting', { names: approver.nameTh }), { timeout: 30_000 })
  const number = new RegExp(`${literally(th('requestForm.sent.number', { number: '' }).trim())} (\\S+)`).exec((await sent.textContent()) ?? '')?.[1]
  expect(number, 'the confirmation gives the request number').toBeTruthy()

  // What the database keeps
  const request = s13<SentRequest | null>('request', String(scene.scene))
  expect(request, `the request ${finalType} "${String(scene.expect.aiTitle)}" of ${actor.code}`).not.toBeNull()
  expect(request!).toMatchObject({
    number,
    status: 'PENDING_APPROVAL',
    requestType: finalType,
    title: expectedOf<string>(scene, 'aiTitle'),
    priceIncludesVat: expectedOf<boolean>(scene, 'priceIncludesVat'),
    net: String(scene.net),
    vat: String(scene.vat),
    gross: String(scene.gross),
    budgetLine: line.code,
    site: scene.site,
    suggestedSupplier: scene.supplier,
    route: { ruleCode: scene.expectedRule, amountBasis: sheet.doa.amountBasis, amount: String(countedOf(sheet, scene)) },
    flags: expectedOf<string[]>(scene, 'flags'),
  })
  expect(request!.formData).toMatchObject({ ...answers, [reasonField!.id]: expectedOf<string>(scene, 'singleSupplierReasonTh') })
  expect(request!.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), uom: l.uom, unitPrice: l.unitPrice, serviceEndDate: l.serviceEndDate }))).toEqual(
    aiLines.map((l) => ({ description: l.description, quantity: Number(l.qty), uom: l.unit, unitPrice: String(satangOf(l.unitPrice)), serviceEndDate: serviceEnd })),
  )
  // The approval step of the row's approver and no reviewer (no parallel review in the row)
  expect(request!.tasks.filter((t) => t.status === 'OPEN').map((t) => t.assignee)).toEqual([approver.code])
  expect(scene.expectedReviewers).toEqual([])
  // FR-AI-303 AC3: the confirmed quotation with the supplier of the register and the file the AI read
  expect(request!.quotations).toEqual([
    {
      supplier: scene.supplier,
      supplierName: quotation.supplierName,
      amount: String(satangOf(quotation.amount)),
      includesVat: quotation.includesVat,
      net: String(satangOf(quotation.net)),
      selected: true,
      file: { fileName: file.name, mimeType: file.mimeType, sha256: request!.quotations[0]?.file?.sha256 === null ? null : upload.sha256 },
    },
  ])
  // Both AI actions end ACCEPTED on this request: every value confirmed and none changed (BR-AI-02)
  for (const [purpose, status] of Object.entries(expectedOf<Record<string, string>>(scene, 'agentActions'))) {
    expect(request!.actions.filter((a) => a.purpose === purpose).map((a) => a.status), `${purpose} on ${number}`).toEqual([status])
  }
  expect(request!.events).toContain('request.submitted')
  // The reservation on the row's budget line
  const after = BigInt(day<{ available: string }>('budget', line.code).available)
  expect(before - after, `${line.code} holds the request's amount ${budgetBasis === 'net' ? 'before VAT' : 'with VAT'}`).toBe(columnOf(scene, budgetBasis))
})
