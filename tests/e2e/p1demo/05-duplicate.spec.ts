import { type Page } from '@playwright/test'
import { anotherDesk, baht, cardRow, cardTo, cardWord, lineUserOf, literally, phoneOf, th, typed, wordsOf } from '../demo/support'
import { expect, test } from '../fixtures'
import { budgetLineOf, columnOf, countedOf, day, expectedOf, historyOf, p1Sheet, ruleOf, sceneOf, script, signInAs, userOf, type P1Scene, type P1Sheet } from './support'

// Scene 5 of the day of phase 1 (sheet Demo_Script_P1 · S6 · FR-INT-103 · FR-INT-101): the site engineer asks for the
// row's tie wire from the catalogue on the web — sent with no warning, since the pair of the same wire in the history
// is older than the duplicate window — then presses "ขอซ้ำ" on it and sends the copy. The second send is refused with
// an inline panel that links the first request; with the reason box empty nothing goes, with the reason it goes, and the
// approver of the row's DOA rule sees the duplicate badge with the requester's reason on the task, on the web, and on
// their phone (linked to LINE after both sends): the badge in a few words on the task's LINE card and with the reason
// on the LIFF task page. Neither request is decided here: both stay waiting at that approver for the rest of the day,
// beside the history's open tasks, so a later scene at the same approver (scene 15) finds its own task by its own
// request. Who acts, the item, quantity, price, line, site, supplier, title, reason and what follows come from the row
// and the sheets it names.

interface TaskFacts {
  readonly id: string
  readonly status: string
  readonly assignee: string
}

interface RequestFacts {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly title: string
  readonly requester: string
  readonly requestType: string
  readonly chargedDept: string
  readonly budgetLine: string | null
  readonly site: string | null
  readonly net: string
  readonly vat: string
  readonly gross: string
  readonly route: { readonly ruleCode: string; readonly amount: string | null; readonly doa: { readonly code: string; readonly versionNo: number } } | null
  readonly tasks: readonly TaskFacts[]
  readonly events: ReadonlyArray<{ readonly type: string; readonly channel: string }>
}

interface FlagFacts {
  readonly id: string
  readonly number: string
  readonly source: string | null
  readonly drafted: { readonly source: unknown; readonly channel: string; readonly by: string | null } | null
  readonly budgetLine: string | null
  readonly site: string | null
  readonly supplier: string | null
  readonly lines: ReadonlyArray<{ readonly item: string | null; readonly description: string; readonly quantity: string; readonly uom: string; readonly unitPrice: string; readonly net: string }>
  readonly flags: ReadonlyArray<{ readonly kind: string; readonly routeNo: number; readonly matched: readonly string[]; readonly acknowledgedReason: string | null; readonly acknowledgedBy: string | null }>
  readonly flaggedEvents: ReadonlyArray<{ readonly kind: unknown; readonly matched: readonly string[] }>
}

const S6 = 'scripts/s6-admin.ts'
const flagsOf = (number: string) => script<FlagFacts>(S6, 'flags', number)
const UUID = '[0-9a-f-]{36}'

/** The latest request the member sent of the row's amount before VAT: the one the form just sent */
function latestSent(scene: P1Scene, notBefore: readonly string[]): RequestFacts {
  const found = day<RequestFacts | null>('latest', scene.actor, columnOf(scene, 'net').toString())
  if (!found || notBefore.includes(found.number)) throw new Error(`${scene.actor} has no new request of ${baht(columnOf(scene, 'net'))} baht before VAT`)
  return found
}

/** "ถัดไป" in the form's bar, step after step, until its last step offers the send */
async function toReview(page: Page) {
  const send = page.getByRole('button', { name: th('requestForm.submit.send'), exact: true })
  for (let i = 0; i < 6 && !(await send.isVisible()); i++) await page.getByRole('button', { name: new RegExp(`^${th('requestForm.wizard.next')}: `) }).click()
  await expect(page.getByRole('heading', { level: 2, name: new RegExp(`${th('requestForm.wizard.review')}$`) })).toBeVisible()
  return send
}

/** The route the form shows before sending: the row's approver under the row's rule of the DOA in effect */
async function expectRouteBeforeSend(page: Page, sheet: P1Sheet, scene: P1Scene) {
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route.getByText(userOf(sheet, scene.expectedApprover).nameTh, { exact: true })).toBeVisible()
  await expect(route).toContainText(th('timeline.doaRef', { code: sheet.doa.code, version: sheet.doa.version, rule: columnOf(scene, 'expectedRule') }))
}

test('@p1demo [FR-INT-103/AC2] [FR-INT-101/AC1] scene 5: the engineer sends the catalogue tie wire, presses ขอซ้ำ and sends the copy; it waits for a reason, then goes, and the approver sees the duplicate badge on the task with the reason and on the LINE card', async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 5)
  expect(scene.channel).toBe('WEB')
  expect(scene.expectedOutcome).toBe('ROUTED')
  const title = expectedOf<string>(scene, 'requestTitleTh')
  expect(expectedOf<number>(scene, 'sendTimes')).toBe(2)
  const secondHow = expectedOf<string>(scene, 'secondHow')
  expect(expectedOf<boolean>(scene, 'lineFromCatalog')).toBe(true)
  const firstFlags = expectedOf<string[]>(scene, 'firstFlags')
  const flag = expectedOf<string>(scene, 'flag')
  const refusalReason = expectedOf<string>(scene, 'refusalReason')
  const reason = expectedOf<string>(scene, 'reasonTh')
  const windowDays = expectedOf<number>(scene, 'windowDays')
  const pairOutside = expectedOf<string[]>(scene, 'historyPairOutsideWindow')
  const noSplitWith = expectedOf<string[]>(scene, 'noSplitWith')
  const approverSees = expectedOf<{ badgeTh: string; reasonPrefixTh: string }>(scene, 'approverSees')

  // The premises of the scene, by the sheets: the duplicate window of sheet Settings, the history's pair of the same
  // wire by the same engineer older than it, the request of the same item inside it in the top band of the DOA (no
  // split can lift it), and the row's amounts in the band of its rule
  expect(Number(sheet.settings.get('duplicateCheck.windowDays'))).toBe(windowDays)
  for (const ref of pairOutside) {
    const h = historyOf(sheet, ref)
    expect(h).toMatchObject({ requester: scene.actor, itemCode: scene.itemCode, qty: scene.qty })
    expect(h.daysAgo, `${ref} is older than the duplicate window`).toBeGreaterThan(windowDays)
    expect(h.title).not.toBe(title)
  }
  for (const ref of noSplitWith) {
    const h = historyOf(sheet, ref)
    expect(h.itemCode).toBe(scene.itemCode)
    expect(h.daysAgo).toBeLessThanOrEqual(windowDays)
    expect(ruleOf(sheet, h.expectedRule).lte, `${ref} is in the top band of the DOA`).toBeNull()
  }
  const counted = countedOf(sheet, scene)
  const band = ruleOf(sheet, scene.expectedRule)
  if (band.gt !== null) expect(counted).toBeGreaterThan(band.gt)
  if (band.lte !== null) expect(counted).toBeLessThanOrEqual(band.lte)
  expect(columnOf(scene, 'unitPrice') * BigInt(columnOf(scene, 'qty'))).toBe(columnOf(scene, 'net'))
  const item = sheet.items.get(columnOf(scene, 'itemCode'))!
  const line = budgetLineOf(sheet, scene.budgetKey)
  const site = { code: columnOf(scene, 'site'), nameTh: sheet.sites.get(columnOf(scene, 'site'))! }
  const supplier = { code: columnOf(scene, 'supplier'), nameTh: sheet.suppliers.get(columnOf(scene, 'supplier'))!.nameTh }
  const approver = userOf(sheet, scene.expectedApprover)

  // The engineer's first request: from the catalogue, on the row's line, site and supplier
  await signInAs(page, sheet, scene.actor)
  await page.goto(`/requests/new/${columnOf(scene, 'requestType')}`)
  await page.getByLabel(th('requestForm.details.title')).fill(title)
  await page.getByLabel(th('requestForm.site.label')).selectOption({ label: th('requestForm.site.option', { code: site.code, name: site.nameTh }) })
  await page.getByRole('button', { name: `${th('requestForm.wizard.next')}: ${th('requestForm.wizard.items')}`, exact: true }).click()
  await page.getByLabel(th('requestForm.budget.line')).selectOption({ label: th('requestForm.budget.option', { code: line.code, name: line.nameTh }) })
  const first = page.getByRole('group', { name: th('requestForm.lines.line', { n: 1 }), exact: true })
  await first.getByRole('button', { name: th('requestForm.catalog.pickLabel', { n: 1 }), exact: true }).click()
  const picker = page.getByRole('dialog', { name: th('requestForm.catalog.dialogTitle', { n: 1 }) })
  await picker.getByLabel(th('requestForm.catalog.search'), { exact: true }).fill(columnOf(scene, 'itemCode'))
  await picker.getByRole('button', { name: th('requestForm.catalog.searchSubmit'), exact: true }).click()
  await picker.getByRole('button', { name: th('requestForm.catalog.chooseLabel', { name: item.nameTh, code: columnOf(scene, 'itemCode') }), exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(first.getByLabel(th('requestForm.lines.description'))).toHaveValue(item.nameTh)
  await expect(first.getByLabel(new RegExp(`^${th('requestForm.lines.uom')}`))).toHaveValue(item.unit)
  await expect(first).toContainText(th('requestForm.catalog.fromCatalog', { code: columnOf(scene, 'itemCode'), name: item.nameTh }))
  await first.getByLabel(new RegExp(`^${th('requestForm.lines.quantity')}`)).fill(columnOf(scene, 'qty'))
  // The row's price is before VAT, as the form takes it by default (its label then says so)
  await first.getByLabel(new RegExp(`^${literally(th('requestForm.lines.unitPriceNet'))}`)).fill(typed(columnOf(scene, 'unitPrice')))
  await expect(first).toContainText(th('requestForm.lines.amount', { amount: baht(columnOf(scene, 'net')) }))
  for (const amount of [columnOf(scene, 'net'), columnOf(scene, 'vat'), columnOf(scene, 'gross')]) await expect(page.getByText(th('requestForm.totals.baht', { amount: baht(amount) })).first()).toBeVisible()
  await page.getByRole('button', { name: `${th('requestForm.wizard.next')}: ${th('requestForm.wizard.supplier')}`, exact: true }).click()
  await page.getByLabel(th('requestForm.supplier.label')).selectOption({ label: th('requestForm.supplier.option', { code: supplier.code, name: supplier.nameTh }) })
  const send = await toReview(page)
  await expectRouteBeforeSend(page, sheet, scene)
  await send.click()
  // No warning: the history's pair is outside the window, so it goes at once to the row's approver
  await expect(page.getByRole('status').filter({ hasText: th('requestForm.sent.sendWaiting', { names: approver.nameTh }) })).toBeVisible()
  await expect(page.getByRole('heading', { name: th('requestForm.duplicate.title') })).toHaveCount(0)
  const one = latestSent(scene, [])
  await expect(page.getByRole('status').filter({ hasText: th('requestForm.sent.send') })).toContainText(one.number)
  expect(one).toMatchObject({
    status: 'PENDING_APPROVAL',
    title,
    requester: scene.actor,
    requestType: scene.requestType,
    chargedDept: scene.chargedDept,
    budgetLine: line.code,
    site: site.code,
    net: columnOf(scene, 'net').toString(),
    vat: columnOf(scene, 'vat').toString(),
    gross: columnOf(scene, 'gross').toString(),
    route: { ruleCode: scene.expectedRule, amount: counted.toString(), doa: { code: sheet.doa.code, versionNo: sheet.doa.version } },
  })
  expect(one.tasks.filter((t) => t.status === 'OPEN').map((t) => t.assignee)).toEqual([scene.expectedApprover])
  const oneFlags = flagsOf(one.number)
  expect(oneFlags.flags.map((f) => f.kind)).toEqual(firstFlags)
  // Typed in by hand on the web: request.drafted says MANUAL (not ขอซ้ำ, a renewal or the chat)
  expect(oneFlags.drafted).toEqual({ source: 'MANUAL', channel: scene.channel, by: scene.actor })
  expect(oneFlags.lines).toEqual([{ item: scene.itemCode, description: item.nameTh, quantity: expect.stringMatching(new RegExp(`^${scene.qty}(\\.0+)?$`)), uom: item.unit, unitPrice: columnOf(scene, 'unitPrice').toString(), net: columnOf(scene, 'net').toString() }])
  expect(oneFlags.supplier).toBe(supplier.code)

  // ขอซ้ำ on its page (FR-INT-101 AC1): a new draft with the same title and lines
  await page.goto(`/requests/${one.id}`)
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await page.getByRole('button', { name: th('requestView.actions.reorder'), exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/requests/${UUID}/edit$`))
  const draftId = new URL(page.url()).pathname.split('/')[2]!
  expect(draftId).not.toBe(one.id)
  await expect(page.getByLabel(th('requestForm.details.title'))).toHaveValue(title)
  // BR-FORM-07 copies no budget line: the form fills it as on every new request (BR-FORM-02), with the line of the
  // engineer's latest sent request of the type — the first one, on the row's line
  await page.getByRole('button', { name: `${th('requestForm.wizard.next')}: ${th('requestForm.wizard.items')}`, exact: true }).click()
  await expect(page.getByLabel(th('requestForm.budget.line')).locator('option:checked')).toHaveText(th('requestForm.budget.option', { code: line.code, name: line.nameTh }))
  const copied = page.getByRole('group', { name: th('requestForm.lines.line', { n: 1 }), exact: true })
  await expect(copied.getByLabel(th('requestForm.lines.description'))).toHaveValue(item.nameTh)
  await expect(copied).toContainText(th('requestForm.lines.amount', { amount: baht(columnOf(scene, 'net')) }))
  const again = await toReview(page)
  // The send is the form's server action that names the request's version and whether it is sent again: the server's
  // answer to it is read as it came, for the reason it refused with
  const sendAnswer = page.waitForResponse((r) => {
    const request = r.request()
    return request.method() === 'POST' && request.headers()['next-action'] !== undefined && (request.postData() ?? '').includes('"resubmit"')
  })
  await again.click()
  expect(await (await sendAnswer).text(), `the server refused the copy with ${refusalReason}`).toContain(`"reason":"${refusalReason}"`)

  // FR-INT-103 AC2: an inline panel, not a pop-up, linking the first request, with an empty reason box
  const panel = page.getByRole('status').filter({ has: page.getByRole('heading', { name: th('requestForm.duplicate.title') }) })
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const matched = panel.getByRole('list', { name: th('requestForm.duplicate.matched') }).getByRole('link')
  await expect(matched).toHaveCount(1)
  await expect(matched).toHaveText(one.number)
  await expect(matched).toHaveAttribute('href', `/requests/${one.id}`)
  const box = panel.getByLabel(new RegExp(`^${th('requestForm.duplicate.reasonLabel')}`))
  await expect(box).toHaveValue('')
  // With the box empty nothing goes: the box says why and takes the focus
  await again.click()
  await expect(panel.getByText(th('requestForm.duplicate.reasonMissing'))).toBeVisible()
  await expect(box).toBeFocused()
  await expect(box).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('status').filter({ hasText: th('requestForm.sent.send') })).toHaveCount(0)
  // With the reason it goes to the same approver
  await box.fill(reason)
  await again.click()
  await expect(page.getByRole('status').filter({ hasText: th('requestForm.sent.sendWaiting', { names: approver.nameTh }) })).toBeVisible()
  const two = latestSent(scene, [one.number])
  expect(two.id).toBe(draftId)
  expect(two).toMatchObject({ status: 'PENDING_APPROVAL', title, budgetLine: line.code, site: site.code, net: one.net, gross: one.gross, route: { ruleCode: scene.expectedRule, amount: counted.toString() } })
  const waiting = two.tasks.filter((t) => t.status === 'OPEN')
  expect(waiting.map((t) => t.assignee)).toEqual([scene.expectedApprover])
  expect(two.events.map((e) => e.type)).toContain('request.flagged')
  // BR-DUP-05: the flag with the first request and the reason; no split on either request
  const twoFlags = flagsOf(two.number)
  expect(twoFlags.source).toBe(one.number)
  // FR-INT-101 AC1: the draft ขอซ้ำ made says so in its request.drafted
  expect(twoFlags.drafted).toEqual({ source: secondHow, channel: scene.channel, by: scene.actor })
  expect(twoFlags.lines).toEqual(oneFlags.lines)
  expect(twoFlags.supplier).toBe(supplier.code)
  expect(twoFlags.flags).toEqual([{ kind: flag, routeNo: 1, matched: [one.number], acknowledgedReason: reason, acknowledgedBy: scene.actor }])
  expect(twoFlags.flaggedEvents).toEqual([{ kind: flag, matched: [one.number] }])
  expect(flagsOf(one.number).flags.filter((f) => f.kind === 'SPLIT')).toEqual([])

  // The approver on a computer of their own: the task of the copy shows the badge, the reason and the first request
  const desk = await anotherDesk(browser)
  try {
    const vp = await desk.newPage()
    await signInAs(vp, sheet, approver.code)
    await vp.goto(`/tasks/${waiting[0]!.id}`)
    await expect(vp.getByRole('heading', { level: 1, name: title })).toBeVisible()
    const section = vp.getByRole('region', { name: th('requestFlags.title'), exact: true })
    await expect(section.locator('[data-slot="badge"][data-tone="warn"]')).toContainText(approverSees.badgeTh)
    await expect(section).toContainText(`${approverSees.reasonPrefixTh}${reason}`)
    await expect(section.getByRole('link', { name: one.number, exact: true })).toHaveAttribute('href', `/requests/${one.id}`)
  } finally {
    await desk.close()
  }

  // And on the approver's phone, in LINE. The phone is linked now, after both sends, as on the day (a member linked
  // already is left alone); the notification job then sends the copy's task to their LINE (played here: e2e has no
  // Inngest). BR-DUP-05: its card carries the badge in a few words — not what it buys (BR-NOTI-01)
  day('prepare', `${approver.code}:${lineUserOf(approver.code)}`)
  const delivered = day<Array<{ templateKey: string; outcome: { status: string; channel?: string } }>>('deliver', approver.code, two.id)
  expect(delivered.map((n) => ({ templateKey: n.templateKey, status: n.outcome.status, channel: n.outcome.channel }))).toContainEqual({ templateKey: 'task.assigned', status: 'SENT', channel: 'LINE' })
  const card = wordsOf(await cardTo(approver.code, two.number))
  expect(card).toContain(cardRow('number', two.number))
  expect(card.split('\n'), 'the badge is a line of its own on the card').toContain(approverSees.badgeTh)
  expect(cardWord('flagDuplicate')).toBe(approverSees.badgeTh)
  expect(card).not.toContain(item.nameTh)
  // The same badge and reason on the LIFF task page, the first request opening its LIFF page (ADR-052)
  const phone = await phoneOf(browser, approver.code)
  try {
    const liff = await phone.newPage()
    await liff.goto(`/liff/tasks/${waiting[0]!.id}`)
    await expect(liff.getByRole('heading', { level: 1, name: title })).toBeVisible()
    const section = liff.getByRole('region', { name: th('requestFlags.title'), exact: true })
    await expect(section.locator('[data-slot="badge"][data-tone="warn"]')).toContainText(approverSees.badgeTh)
    await expect(section).toContainText(`${approverSees.reasonPrefixTh}${reason}`)
    await expect(section.getByRole('link', { name: one.number, exact: true })).toHaveAttribute('href', `/liff/requests/${one.id}`)
  } finally {
    await phone.close()
  }
})
