import { E2E_BASE_URL } from '../../support/e2e-env'
import { actionsOf, answerTo, baht, cardRow, cardTo, cardWord, confirmationWord, literally, lineUserOf, tapPostback, th, typed, wordsOf } from '../demo/support'
import { expect, test } from '../fixtures'
import { approverByRule, budgetLineOf, columnOf, countedOf, day, expectedOf, p1Sheet, ruleOf, satangOf, sceneOf, script, signInAs, userOf } from './support'

// Scene 1 of the day of phase 1 (P1-08 · S6 · sheet Demo_Script_P1 row of scene 1): the row's requester asks on the web
// for the contract work of the row — its type's own questions (expectJson.form), the catalogue item of the row on the
// row's budget key of this fiscal year and site, the row's supplier with its one quotation and the reason it is the
// only one (ATT-QUOTES above 100,000.00 with VAT) — and sends it. Before sending, the route names the DOA's approver of
// the row's rule and no reviewer (the reviewers are no DOA step). Sent, the request waits for the parallel reviewers of
// the workflow in effect — the row's expectedReviewers, every one at once (FR-WF-101 AC1) — and the DOA step behind
// them. Each reviewer decides as expectJson.reviewDecisions says, in that order: one passes in the LINE chat from the
// card's button (AC5), one asks the requester first — who is told, answers, and the task is the same reviewer's again
// (FR-INT-009 AC3) — and passes, one passes on the web (AC5). A reviewer never rejects and needs no PIN whatever the
// amount (review.decide · BR-WF-09). The DOA step gets no task while any reviewer has still to pass (AC2); once all have
// passed, the request waits for the row's approver at the DOA step (expectJson.afterReviews) — whose notice the scene
// leaves undelivered: scene 2 plays it on the approver's phone in BCS Go.

/** The facts of tests/e2e/p1demo/scripts/review.ts */
interface ReviewFacts {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly form: Readonly<Record<string, unknown>>
  readonly suggestedSupplier: string | null
  readonly lines: ReadonlyArray<{ readonly lineNo: number; readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string; readonly item: string | null }>
  readonly quotations: ReadonlyArray<{ readonly supplierName: string; readonly supplier: string | null; readonly amount: string; readonly includesVat: boolean; readonly chosen: boolean; readonly file: boolean }>
  readonly route: { readonly ruleCode: string; readonly amount: string | null; readonly doa: { readonly code: string; readonly versionNo: number; readonly stepUpThreshold: string | null } } | null
  readonly steps: ReadonlyArray<{
    readonly stepNo: number
    readonly kind: 'APPROVAL' | 'REVIEW'
    readonly status: string
    readonly slaBusinessMinutes: number
    readonly quorums: readonly unknown[]
    readonly tasks: ReadonlyArray<{ readonly id: string; readonly assignee: string; readonly status: string; readonly decision: string | null; readonly channel: string | null; readonly rules: readonly string[]; readonly decidedOn: string | null }>
    readonly events: ReadonlyArray<{ readonly type: string; readonly outcome: unknown }>
  }>
  readonly flags: ReadonlyArray<{ readonly kind: string; readonly matched: readonly string[] }>
  readonly questions: ReadonlyArray<{ readonly by: string | null; readonly question: string; readonly answer: string | null; readonly answeredBy: string | null }>
  readonly events: ReadonlyArray<{ readonly type: string; readonly channel: string }>
  readonly notices: ReadonlyArray<{ readonly templateKey: string; readonly status: string; readonly recipient: string | null; readonly taskId: unknown }>
  readonly priceRef: ReadonlyArray<{ readonly lineNo: number; readonly count: number; readonly median: string | null; readonly status: string }>
}

interface ReviewDecision {
  readonly member: string
  readonly rule: string
  readonly channel: 'LINE_CHAT' | 'WEB'
  readonly decision: 'PASS' | 'ASK_INFO_THEN_PASS'
  readonly questionTh?: string
  readonly answerTh?: string
}

interface Quote {
  readonly supplier: string
  readonly amount: string
  readonly includesVat: boolean
  readonly chosen: boolean
}

const PDF = Buffer.from('%PDF-1.7\n' + 'x'.repeat(200) + '\n%%EOF\n', 'latin1')

test('@p1demo [FR-WF-101/AC1] [FR-WF-101/AC2] [FR-WF-101/AC5] [FR-INT-009/AC3] scene 1: a contract work over the reviewers\' threshold waits for three reviewers at once; one passes from the LINE card, one asks the requester first, one passes on the web, then it waits for the DOA approver', async ({
  page,
  browser,
  clientIp,
}, testInfo) => {
  test.setTimeout(10 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 1)
  expect([scene.area, scene.channel, scene.expectedOutcome]).toEqual(['PARALLEL_REVIEW', 'WEB', 'ROUTED'])
  const requester = userOf(sheet, scene.actor)
  const approver = userOf(sheet, scene.expectedApprover)
  const [net, vat, gross, unitPrice] = [columnOf(scene, 'net'), columnOf(scene, 'vat'), columnOf(scene, 'gross'), columnOf(scene, 'unitPrice')]
  const counted = countedOf(sheet, scene)
  const rule = ruleOf(sheet, scene.expectedRule)
  // The row's premise by the sheets: the amount the DOA counts falls in the row's rule, whose holder is the row's approver
  expect(rule.gt === null || counted > rule.gt, `${baht(counted)} is above the band of ${rule.ruleCode}'s lower bound`).toBe(true)
  expect(rule.lte === null || counted <= rule.lte, `${baht(counted)} is within ${rule.ruleCode}'s band`).toBe(true)
  expect(approverByRule(sheet, rule.ruleCode, columnOf(scene, 'chargedDept')).code).toBe(approver.code)
  const decisions = expectedOf<ReviewDecision[]>(scene, 'reviewDecisions')
  expect(
    decisions.map((d) => ({ rule: d.rule, member: d.member })).sort((a, b) => a.rule.localeCompare(b.rule)),
    'expectJson.reviewDecisions decides for each reviewer of expectedReviewers once',
  ).toEqual([...scene.expectedReviewers].sort((a, b) => a.rule.localeCompare(b.rule)))
  const after = expectedOf<{ stepNo: number; rule: string; approver: string; stepUp: boolean; taskOpen: boolean }>(scene, 'afterReviews')
  expect([after.rule, after.approver]).toEqual([scene.expectedRule, scene.expectedApprover])
  expect(after.stepUp, 'expectJson.afterReviews.stepUp: the approver decides with a step-up exactly when the amount reaches stepUpThreshold').toBe(counted >= sheet.doa.stepUpThreshold)
  const reviewers = scene.expectedReviewers.map((r) => ({ ...r, user: userOf(sheet, r.member) }))
  const item = sheet.items.get(columnOf(scene, 'itemCode'))
  if (!item) throw new Error(`sheet Items has no ${scene.itemCode}`)
  const line = budgetLineOf(sheet, scene.budgetKey)
  const site = columnOf(scene, 'site')
  const supplier = columnOf(scene, 'supplier')
  const supplierName = sheet.suppliers.get(supplier)?.nameTh
  if (!supplierName) throw new Error(`sheet Suppliers has no ${supplier}`)

  // Before the request goes (runbook: the phones are linked before the day): the reviewer who passes in the LINE chat is
  // linked to their LINE account, so the review task gives them the card's in-chat button (BR-TOK-01)
  const inChat = decisions.filter((d) => d.channel === 'LINE_CHAT').map((d) => d.member)
  if (inChat.length) day('prepare', ...inChat.map((code) => `${code}:${lineUserOf(code)}`))

  // ---------- the requester asks for the contract work on the web ----------
  await signInAs(page, sheet, requester.code)
  await page.goto(`/requests/new/${columnOf(scene, 'requestType')}`)
  const heading = (step: 'details' | 'items' | 'supplier' | 'documents' | 'review') =>
    page.getByRole('heading', { level: 2, name: new RegExp(`: ${literally(th(`requestForm.wizard.${step}`))}$`) })
  const next = (step: 'items' | 'supplier' | 'documents' | 'review') => page.getByRole('button', { name: `${th('requestForm.wizard.next')}: ${th(`requestForm.wizard.${step}`)}`, exact: true }).click()
  await expect(heading('details')).toBeVisible()
  await page.getByLabel(th('requestForm.details.title')).fill(expectedOf<string>(scene, 'requestTitleTh'))
  // The type's own questions (prisma/seed/forms.yaml), each by its field id
  for (const [field, answer] of Object.entries(expectedOf<Record<string, string>>(scene, 'form'))) await page.locator(`#field-${field}`).fill(answer)
  const siteSelect = page.getByLabel(th('requestForm.site.label'))
  await siteSelect.selectOption({ label: th('requestForm.site.option', { code: site, name: sheet.sites.get(site) ?? '' }) })

  await next('items')
  await expect(heading('items')).toBeVisible()
  const budgetSelect = page.getByLabel(th('requestForm.budget.line'))
  const lineOption = budgetSelect.locator('option', { hasText: new RegExp(`^${literally(line.code)} · `) })
  await expect(lineOption, `the requester may use ${line.code} (budget key ${scene.budgetKey} of this fiscal year)`).toHaveCount(1)
  await budgetSelect.selectOption((await lineOption.getAttribute('value'))!)
  // The line of the row is picked from the catalogue, so the price reference finds the item's history (BR-DUP-01 key)
  expect(expectedOf<boolean>(scene, 'lineFromCatalog'), 'scene 1 picks its line from the catalogue').toBe(true)
  const first = page.getByRole('group', { name: th('requestForm.lines.line', { n: 1 }), exact: true })
  await first.getByRole('button', { name: th('requestForm.catalog.pickLabel', { n: 1 }) }).click()
  const picker = page.getByRole('dialog', { name: th('requestForm.catalog.dialogTitle', { n: 1 }) })
  await picker.getByLabel(th('requestForm.catalog.search'), { exact: true }).fill(columnOf(scene, 'itemCode'))
  await picker.getByRole('button', { name: th('requestForm.catalog.searchSubmit'), exact: true }).click()
  await picker.getByRole('button', { name: th('requestForm.catalog.chooseLabel', { name: item.nameTh, code: columnOf(scene, 'itemCode') }) }).click()
  await expect(picker).toBeHidden()
  await expect(first.getByLabel(th('requestForm.lines.description'))).toHaveValue(item.nameTh)
  await expect(first.getByLabel(new RegExp(`^${th('requestForm.lines.uom')}`))).toHaveValue(item.unit)
  await first.getByLabel(new RegExp(`^${th('requestForm.lines.quantity')}`)).fill(columnOf(scene, 'qty'))
  await first.getByLabel(new RegExp(`^${literally(th('requestForm.lines.unitPriceNet'))}`)).fill(typed(unitPrice))
  // The row's three amounts: before VAT, the VAT and with VAT
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()

  await next('supplier')
  await expect(heading('supplier')).toBeVisible()
  await page.getByLabel(th('requestForm.supplier.label')).selectOption({ label: th('requestForm.supplier.option', { code: supplier, name: supplierName }) })
  const quotes = expectedOf<Quote[]>(scene, 'quotes')
  for (const [i, quote] of quotes.entries()) {
    const n = i + 1
    await page.getByRole('button', { name: th('requestForm.quotations.add') }).click()
    const group = page.getByRole('group', { name: th('requestForm.quotations.item', { n }) })
    await group.getByLabel(th('requestForm.quotations.supplier')).fill(sheet.suppliers.get(quote.supplier)?.nameTh ?? quote.supplier)
    await group.getByLabel(th('requestForm.quotations.amount')).fill(typed(satangOf(quote.amount)!))
    if (quote.includesVat) await group.getByLabel(th('requestForm.quotations.includesVat')).check()
    await group.locator('input[type="file"]').setInputFiles({ name: `quotation-${n}.pdf`, mimeType: 'application/pdf', buffer: PDF })
    await expect(group.getByText(th('requestForm.quotations.file', { name: `quotation-${n}.pdf` }))).toBeVisible()
    if (quote.chosen) await group.getByLabel(th('requestForm.quotations.choose', { n })).check()
  }

  await next('documents')
  await expect(heading('documents')).toBeVisible()
  // ATT-QUOTES above 100,000.00 with VAT: three quotations, or one with the reason it is the only one
  await page.locator('#field-singleSourceJustification').fill(expectedOf<string>(scene, 'singleSourceReasonTh'))

  await next('review')
  await expect(heading('review')).toBeVisible()
  for (const amount of [net, vat, gross]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  // The route before sending: the DOA's approver under the row's rule, and — expectJson.preSendRoute — no reviewer
  const preSend = expectedOf<{ rule: string; approver: string; showsReviewers: boolean }>(scene, 'preSendRoute')
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route).toContainText(th('timeline.doaRef', { code: sheet.doa.code, version: sheet.doa.version, rule: preSend.rule }))
  await expect(route.getByText(userOf(sheet, preSend.approver).nameTh, { exact: true })).toBeVisible()
  for (const r of reviewers) {
    if (preSend.showsReviewers) await expect(route).toContainText(r.user.nameTh)
    else await expect(route).not.toContainText(r.user.nameTh)
  }
  await expect(page.getByText(th('requestForm.review.ready'))).toBeVisible()
  await page.getByRole('button', { name: th('requestForm.submit.send'), exact: true }).click()
  const sent = page.getByRole('status').filter({ hasText: th('requestForm.sent.send') })
  await expect(sent).toContainText(/PR-\d{4}-\d{5}/)
  // It waits for the reviewers first, every one at once
  for (const r of reviewers) await expect(sent).toContainText(r.user.nameTh)
  const number = (/PR-\d{4}-\d{5}/.exec((await sent.textContent()) ?? '') ?? [''])[0]

  // ---------- as sent: the reviewers' step, then the DOA's ----------
  const request = day<{ id: string; number: string; status: string; gross: string; requestType: string; budgetLine: string; site: string } | null>('latest', requester.code, net.toString())
  if (!request) throw new Error(`${requester.code} sent no request of ${baht(net)} before VAT`)
  expect({ number: request.number, status: request.status, gross: request.gross, requestType: request.requestType, budgetLine: request.budgetLine, site: request.site }).toEqual({
    number,
    status: 'PENDING_APPROVAL',
    gross: gross.toString(),
    requestType: scene.requestType,
    budgetLine: line.code,
    site,
  })
  const facts = (): ReviewFacts => script<ReviewFacts>('scripts/review.ts', 'facts', request.id)
  const sentFacts = facts()
  expect(sentFacts.route).toMatchObject({ ruleCode: scene.expectedRule, amount: counted.toString(), doa: { code: sheet.doa.code, versionNo: sheet.doa.version } })
  expect(sentFacts.form, 'the answers of the type\'s questions and the single-source reason').toMatchObject({ ...expectedOf<Record<string, string>>(scene, 'form'), singleSourceJustification: expectedOf<string>(scene, 'singleSourceReasonTh') })
  expect(sentFacts.suggestedSupplier).toBe(supplier)
  expect(sentFacts.lines).toEqual([{ lineNo: 1, description: item.nameTh, quantity: columnOf(scene, 'qty'), uom: item.unit, unitPrice: unitPrice.toString(), item: scene.itemCode }])
  expect(sentFacts.quotations.map(({ supplierName, amount, includesVat, chosen, file }) => ({ supplierName, amount, includesVat, chosen, file }))).toEqual(
    quotes.map((q) => ({ supplierName: sheet.suppliers.get(q.supplier)?.nameTh ?? q.supplier, amount: satangOf(q.amount)!.toString(), includesVat: q.includesVat, chosen: q.chosen, file: true })),
  )
  // BR-DUP-05: not a duplicate of the requester's earlier road work (expectJson.notDuplicateOf), no flag at all
  expect(sentFacts.flags.map((f) => f.kind)).toEqual(expectedOf<string[]>(scene, 'flags'))
  const earlier = day<{ number: string } | null>('history', expectedOf<string>(scene, 'notDuplicateOf'))
  if (!earlier) throw new Error(`the seed made no request for Request_History ${expectedOf<string>(scene, 'notDuplicateOf')}`)
  expect(sentFacts.flags.flatMap((f) => f.matched)).not.toContain(earlier.number)
  // BR-PRC-01: the price reference of the item (expectJson.priceRef)
  const priceRef = expectedOf<{ item: string; count: number; median: string; status: string }>(scene, 'priceRef')
  expect(priceRef.item).toBe(scene.itemCode)
  expect(sentFacts.priceRef).toEqual([expect.objectContaining({ lineNo: 1, count: priceRef.count, median: satangOf(priceRef.median)!.toString(), status: priceRef.status })])
  // FR-WF-101 AC1: step 1 is the reviewers', one task each, all open at once, each for the rule the row names; the DOA's
  // step waits behind it
  const [review, doa] = [sentFacts.steps[0], sentFacts.steps[1]]
  expect(sentFacts.steps).toHaveLength(after.stepNo)
  expect(review).toMatchObject({ stepNo: 1, kind: 'REVIEW', status: 'ACTIVE', slaBusinessMinutes: expectedOf<number>(scene, 'reviewSlaHours') * 60 })
  expect(new Set(review!.quorums)).toEqual(new Set([expectedOf<string>(scene, 'reviewMode')]))
  expect(review!.tasks.map((t) => ({ member: t.assignee, rules: t.rules, status: t.status })).sort((a, b) => a.member.localeCompare(b.member))).toEqual(
    reviewers.map((r) => ({ member: r.member, rules: [r.rule], status: 'OPEN' })).sort((a, b) => a.member.localeCompare(b.member)),
  )
  expect(doa).toMatchObject({ stepNo: after.stepNo, kind: 'APPROVAL', status: 'WAITING', tasks: [] })
  const taskOf = (member: string) => review!.tasks.find((t) => t.assignee === member)!

  // The requester's page: the reviewers' step as one group, none passed yet, each stamp with its rule
  await page.goto(`/requests/${request.id}`)
  const steps = page.getByRole('list', { name: th('document.steps.list') })
  const stampOf = (name: string) => steps.getByRole('listitem').filter({ hasText: name }).last()
  await expect(steps).toContainText(th('document.steps.reviewTitle', { no: 1 }))
  await expect(steps).toContainText(th('requestView.route.reviewProgress', { done: 0, total: reviewers.length }))
  for (const r of reviewers) {
    await expect(stampOf(r.user.nameTh)).toContainText(th('requestView.route.slotRules', { rules: r.rule }))
    await expect(stampOf(r.user.nameTh)).toContainText(th('requestView.route.slotState.OPEN'))
  }

  // ---------- the reviewers decide, in the row's order ----------
  const contexts = []
  try {
    for (const [i, d] of decisions.entries()) {
      const task = taskOf(d.member)
      if (d.channel === 'LINE_CHAT') {
        // The notification job sends the review card to their LINE (played here: e2e has no Inngest)
        const delivered = day<Array<{ templateKey: string; outcome: { status: string; channel?: string } }>>('deliver', d.member, request.id)
        expect(delivered.map((n) => ({ templateKey: n.templateKey, status: n.outcome.status, channel: n.outcome.channel }))).toContainEqual({ templateKey: 'task.review_assigned', status: 'SENT', channel: 'LINE' })
        const card = await cardTo(d.member, number)
        const words = wordsOf(card)
        expect(words).toContain(cardWord('reviewHeader'))
        expect(words).toContain(cardRow('number', number))
        expect(words).toContain(cardRow('reviewRules', d.rule))
        // AC5: the reviewer passes with the card's postback "ผ่าน"; BR-WF-09: whatever the amount, no PIN line
        expect(words).not.toContain(cardWord('pinNeeded'))
        const pass = actionsOf(card).filter((a) => a.label === cardWord('pass'))
        expect(pass).toHaveLength(1)
        expect(pass[0]).toMatchObject({ type: 'postback', displayText: `${cardWord('pass')} ${number}` })
        expect(pass[0]!.data).toMatch(/^v=1&a=approve&k=[0-9a-f-]{36}$/)
        const tap = tapPostback(testInfo, d.member, pass[0]!.data!)
        expect(tap.status, tap.printed).toBe(200)
        const answer = await answerTo(tap)
        expect(String(answer.messages[0]?.altText ?? ''), 'the answer in the chat says it passed').toMatch(new RegExp(`^${literally(confirmationWord('reviewHeader'))}`))
      } else {
        const context = await browser.newContext({ ...testInfo.project.use, baseURL: E2E_BASE_URL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } })
        contexts.push(context)
        const desk = await context.newPage()
        await signInAs(desk, sheet, d.member)
        await desk.goto('/tasks')
        await expect(desk.getByRole('listitem').filter({ hasText: number }).first()).toContainText(th('tasks.item.review'))
        await desk.goto(`/tasks/${task.id}`)
        // review.decide · BR-WF-09: a reviewer passes, returns or asks — never rejects, and needs no PIN
        await expect(desk.getByText(th('tasks.decide.rejectOption'), { exact: true })).toHaveCount(0)
        await expect(desk.getByText(th('tasks.decide.pin'))).toHaveCount(0)
        if (d.decision === 'ASK_INFO_THEN_PASS') {
          const question = d.questionTh!
          await desk.getByLabel(th('tasks.decide.question')).fill(question)
          await desk.getByRole('button', { name: th('tasks.decide.askSubmit') }).click()
          await expect(desk.getByRole('status').filter({ hasText: th('tasks.decide.asked') })).toBeVisible()
          await expect(desk.getByText(th('tasks.state.question', { question }))).toBeVisible()
          // FR-INT-009 AC3: the requester sees the question on the request and answers it; the task is the reviewer's again
          await page.reload()
          await expect(page.getByRole('heading', { level: 3, name: th('requestView.actions.answerTitle') })).toBeVisible()
          await expect(page.getByText(question).first()).toBeVisible()
          await page.getByLabel(th('requestView.actions.answerLabel')).fill(d.answerTh!)
          await page.getByRole('button', { name: th('requestView.actions.answerSubmit') }).click()
          await expect(page.getByRole('status').filter({ hasText: th('requestView.actions.answered') })).toBeVisible()
          await desk.reload()
        }
        await desk.getByRole('button', { name: th('tasks.decide.review.approve'), exact: true }).first().click()
        await desk.getByRole('button', { name: th('tasks.decide.review.confirm') }).click()
        await expect(desk.getByRole('status').filter({ hasText: new RegExp(`^${literally(th('tasks.decide.review.approved'))}$`) })).toBeVisible()
      }
      const now = facts()
      expect(now.steps[0]!.tasks.find((t) => t.id === task.id), `${d.member} passed ${d.rule} on ${d.channel}`).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', channel: d.channel, decidedOn: d.channel })
      if (i < decisions.length - 1) {
        // AC2: while a reviewer has still to pass, the reviewers' step stays open and the DOA's step has no task
        expect(now.steps[0], `after ${d.member}'s pass`).toMatchObject({ kind: 'REVIEW', status: 'ACTIVE' })
        expect(now.steps.find((s) => s.stepNo === after.stepNo), `after ${d.member}'s pass`).toMatchObject({ kind: 'APPROVAL', status: 'WAITING', tasks: [] })
      }
    }
  } finally {
    for (const context of contexts) await context.close()
  }

  // ---------- every reviewer passed: the request waits for the DOA's approver ----------
  const done = facts()
  expect(done.status).toBe('PENDING_APPROVAL')
  expect(done.steps[0]).toMatchObject({ kind: 'REVIEW', status: 'DONE', events: [{ type: 'approval_step.completed', outcome: 'APPROVED' }] })
  const ask = decisions.find((d) => d.decision === 'ASK_INFO_THEN_PASS')
  if (ask) {
    expect(done.questions).toEqual([{ taskId: taskOf(ask.member).id, by: ask.member, question: ask.questionTh, answer: ask.answerTh, answeredBy: requester.code }])
    expect(done.events.map((e) => e.type)).toEqual(expect.arrayContaining(['request.info_requested', 'request.info_provided']))
    // FR-INT-009 AC3: the requester was told of the question, and the answer went back to the reviewer who asked
    const about = (templateKey: string) => done.notices.filter((n) => n.templateKey === templateKey).map(({ recipient, taskId }) => ({ recipient, taskId }))
    expect(about('request.info_requested'), 'the requester is told of the question').toEqual([{ recipient: requester.code, taskId: taskOf(ask.member).id }])
    expect(about('request.info_provided'), 'the reviewer who asked is told of the answer').toEqual([{ recipient: ask.member, taskId: taskOf(ask.member).id }])
  }
  const waiting = done.steps.find((s) => s.stepNo === after.stepNo)!
  expect(waiting).toMatchObject({ kind: 'APPROVAL', status: 'ACTIVE' })
  expect(waiting.tasks.map((t) => ({ assignee: t.assignee, status: t.status }))).toEqual([{ assignee: after.approver, status: after.taskOpen ? 'OPEN' : expect.anything() }])
  expect(done.route?.ruleCode).toBe(after.rule)
  expect(BigInt(done.route?.amount ?? '0') >= BigInt(done.route?.doa.stepUpThreshold ?? '0'), 'the approver decides with a step-up (afterReviews.stepUp)').toBe(after.stepUp)
  // Scene 2 plays the approver's notice on their phone: it is still waiting
  expect(done.notices.filter((n) => n.recipient === after.approver && n.taskId === waiting.tasks[0]!.id)).toEqual([expect.objectContaining({ templateKey: 'task.assigned', status: 'PENDING' })])

  await page.goto(`/requests/${request.id}`)
  await expect(steps).toContainText(th('requestView.route.reviewProgress', { done: reviewers.length, total: reviewers.length }))
  for (const r of reviewers) await expect(stampOf(r.user.nameTh)).toContainText(th('requestView.route.slotState.PASS'))
  await expect(steps).toContainText(approver.nameTh)
})
