import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'
import { baht, cardRow, cardTo, cardWord, deliverPending, expectCardButtons, liffPathOf, lineUserOf, literally, pushesTo, th, typed, wordsOf, type CardAction, type LineMessage, type RequestFacts } from '../demo/support'
import { openAsLineUser } from '../liff-support'
import { budgetLineOf, columnOf, countedOf, day, expectedOf, p1Sheet, ruleOf, sceneOf, script, userOf } from './support'

// Scene 15 of phase 1 (sheet Demo_Script_P1, area CHAT_REQUEST · S17 · FR-LINE-301 · BR-LINE-13 · BR-AI-16): the row's
// requester writes the row's words in the 1:1 chat of the organization's LINE account and sends the photo of the row's
// quotation (DocSamples); the account answers with the button "ตรวจและส่งคำขอ" only (none of what was typed: BR-LINE-06).
// The button opens the chat draft in LIFF, which says the AI is reading; the jobs the e2e app has no Inngest for are
// played by the scene script (./scripts/chat.ts): the photo is fetched from LINE and kept, and the Intake Agent reads the
// words and the photo once — a retry of the job reads nothing again, and nothing is said in the chat (AI_MODE=fixture:
// the recorded answer tests/fixtures/ai/INTAKE/<key>.json, named by the words, the photo and the organization's types
// and sites — so the row's chatText must stay as recorded). LIFF then shows the reading with the badge "เติมโดย AI
// โปรดตรวจ" and the type it suggests picked; the draft takes the AI's values, the photo as an OTHER attachment, and the
// values BR-AI-16 names wait to be confirmed one by one: request.submit refuses (AI_REVIEW_PENDING) until they are. The
// requester picks the row's budget line of this fiscal year, checks the amounts of the row and the route the DOA gives
// (the row's rule and approver), and sends it in LIFF: the approver's task notice goes out as the approval card in LINE
// (played job notification-deliver). Without AI the same works on (EG-1): proven by @s17 scene 6 [FR-LINE-301/AC6] on the
// twin, kept out of this run because switching SIMEC's AI module off would touch the AI scenes around it.
// Before the day the requester's and the approver's phones are linked (day prepare): the card carries the in-chat button
// only for an approver linked when the task is given (BR-TOK-01).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

interface Chat {
  readonly intakeId: string
  readonly lineUserId: string
  readonly messageCount: number
  readonly imageCount: number
  /** The account's replies to the text and to the photo, by their reply tokens */
  readonly replies: ReadonlyArray<readonly LineMessage[]>
}

interface ChatJobs {
  readonly images: readonly string[]
  readonly ai: { readonly status: string; readonly agentActionId?: string; readonly reason?: string }
  /** The same job once more, as a retry of its event would run it */
  readonly again: { readonly status: string; readonly agentActionId?: string; readonly reason?: string }
  /** The AgentAction rows reading the draft, and the one the draft keeps */
  readonly readings: number
  readonly kept: string | null
  readonly action: { readonly status: string; readonly errorCode: string | null } | null
  /** Notices queued for the writer while the jobs ran */
  readonly notices: number
}

interface Refusal {
  readonly code: string | null
  readonly count: number | null
}

interface Drafted {
  readonly status: string
  readonly requestId: string | null
  readonly number: string | null
  readonly supplier: string | null
  readonly event: { readonly channel: string; readonly images: unknown; readonly aiAssisted: unknown } | null
}

/** The words LIFF gives a value of the reading that waits to be confirmed (src/app/liff/requests/[id]/edit/page.tsx) */
function waitingLabel(path: string): string {
  const line = /^lines\.(\d+)\.(description|quantity|uom|unitPrice)$/.exec(path)
  if (line) return th(`liffChat.review.line.${line[2]!}`, { no: Number(line[1]) + 1 })
  return th(`liffChat.review.path.${['title', 'deliverySiteId', 'suggestedSupplierId', 'requestTypeCode'].includes(path) ? path : 'other'}`)
}

test('@p1demo [FR-LINE-301/AC1] [FR-LINE-301/AC3] [FR-LINE-301/AC4] [FR-LINE-301/AC5] scene 15: the requester asks in the LINE chat with the quotation\'s photo; LIFF shows what the AI read, the money, the quantity and the supplier are confirmed one by one, and the request goes to the approver of the DOA, who gets the card in LINE', async ({
  page,
  context,
}) => {
  test.setTimeout(480_000)
  const sheet = await p1Sheet()
  const s = sceneOf(sheet, 15)
  const actor = userOf(sheet, s.actor)
  const approver = userOf(sheet, columnOf(s, 'expectedApprover'))
  const rule = ruleOf(sheet, columnOf(s, 'expectedRule'))
  const chatText = expectedOf<string>(s, 'chatText')
  const photos = expectedOf<number>(s, 'photos')
  const aiType = expectedOf<string>(s, 'aiType')
  const line = expectedOf<{ description: string; unit: string }>(s, 'line')
  const mustConfirm = expectedOf<string[]>(s, 'mustConfirm')
  const attachments = expectedOf<string[]>(s, 'attachments')
  const submitChannel = expectedOf<string>(s, 'submitChannel')
  const approverCard = expectedOf<boolean>(s, 'approverCard')
  const net = columnOf(s, 'net')
  const vat = columnOf(s, 'vat')
  const gross = columnOf(s, 'gross')
  const unitPrice = columnOf(s, 'unitPrice')
  const counted = countedOf(sheet, s)
  const budgetLine = budgetLineOf(sheet, s.budgetKey)
  const typeName = sheet.requestTypes.get(aiType)
  const siteName = sheet.sites.get(columnOf(s, 'site'))
  const supplierName = sheet.suppliers.get(columnOf(s, 'supplier'))?.nameTh
  if (!typeName || !siteName || !supplierName) throw new Error(`Demo_Script_P1 row ${s.row}: the type, site or supplier is not in the workbook`)
  // Where the DOA finds the approver: the rule's position in the department the sheet gives the approver
  const held = approver.positions.find((p) => p.startsWith(`${rule.approverPosition ?? ''}@`))
  if (!held) throw new Error(`${approver.code} holds no ${rule.approverPosition ?? '(no position)'} by sheet Users`)
  const role = th('requestForm.route.positionOf', { position: sheet.positions.get(rule.approverPosition!)?.nameTh ?? '', department: sheet.departments.get(held.split('@')[1]!) ?? '' })

  // Before the day: both phones linked to their LINE accounts (and the rich menus made)
  const prepared = day<{ active: boolean; linked: string[]; already: string[] }>('prepare', `${actor.code}:${lineUserOf(actor.code)}`, `${approver.code}:${lineUserOf(approver.code)}`)
  expect(prepared.active, "the organization's LINE channel is on").toBe(true)
  expect([...prepared.linked, ...prepared.already].sort()).toEqual([actor.code, approver.code].sort())

  // AC1: the words and the photo in the chat open one chat draft; each is answered with a reply carrying the button that
  // opens the draft in LIFF, and no answer repeats what was typed, the line or a price (BR-LINE-06 BR-NOTI-01)
  const chat = script<Chat>('scripts/chat.ts', 'chat', String(s.scene))
  expect(chat.lineUserId).toBe(lineUserOf(actor.code))
  expect({ messageCount: chat.messageCount, imageCount: chat.imageCount }).toEqual({ messageCount: 1 + photos, imageCount: photos })
  expect(chat.replies, 'one reply to the words and one to each photo').toHaveLength(1 + photos)
  const draftPath = `/liff/requests/new?intake=${chat.intakeId}`
  for (const reply of chat.replies) {
    expect(reply, 'each answer is one message').toHaveLength(1)
    const actions = (reply[0]?.template as { actions?: CardAction[] } | undefined)?.actions ?? []
    expect(actions.map((a) => ({ type: a.type, label: a.label }))).toEqual([{ type: 'uri', label: 'ตรวจและส่งคำขอ' }])
    expect(liffPathOf(actions[0]!.uri!)).toBe(draftPath)
  }
  const answered = JSON.stringify(chat.replies)
  for (const typedText of [chatText, line.description, baht(net), baht(gross), typed(unitPrice), typed(gross)]) expect(answered, `the chat's answers do not say "${typedText}"`).not.toContain(typedText)
  const pushesBefore = (await pushesTo(actor.code)).length

  // The button opens the draft in LIFF before the reading is done: LIFF says the AI is reading (AC5)
  await openAsLineUser(context, lineUserOf(actor.code))
  await page.goto(draftPath)
  await expect(page.getByRole('heading', { level: 1, name: th('liffChat.pageTitle') })).toBeVisible()
  await expect(page.getByText(th('liffChat.ai.reading'))).toBeVisible()

  // AC3 and AC5: the photo is fetched from LINE and kept (job chat-intake-image), then the Intake Agent reads the words
  // and the photo (job chat-intake-ai): one reading, linked to the draft, waiting for the requester
  const jobs = script<ChatJobs>('scripts/chat.ts', 'chat-jobs', chat.intakeId)
  if (jobs.action?.errorCode === 'FIXTURE_MISSING') {
    const { key } = script<{ key: string }>('scripts/chat.ts', 'ai-key', String(s.scene))
    throw new Error(`no recorded answer for the reading of scene ${s.scene}: record tests/fixtures/ai/${key}.json (its words, photo or the organization's types and sites changed)`)
  }
  // A retry of the job's event reads nothing again: the draft keeps its one reading (the model is not called twice).
  // Nothing is said in the chat when the reading ends (AC5): LIFF shows it — no notice is queued for the requester
  // (notices: 0) and nothing is pushed to their LINE
  expect(jobs).toEqual({
    images: Array(photos).fill('STORED'),
    ai: { status: 'LINKED', agentActionId: expect.any(String) },
    again: { status: 'SKIPPED', reason: 'READ_ALREADY' },
    readings: 1,
    kept: jobs.ai.agentActionId,
    action: { status: 'DRAFT', errorCode: null },
    notices: 0,
  })
  expect((await pushesTo(actor.code)).length, 'no push to the requester once the AI has read').toBe(pushesBefore)

  // LIFF: the words typed in the chat as a reference, the photo kept, and what the AI read with its badge; the type it
  // suggests is picked
  await page.goto(draftPath)
  await expect(page.getByRole('heading', { level: 1, name: th('liffChat.pageTitle') })).toBeVisible()
  const reference = page.getByRole('region', { name: th('liffChat.textHeading') })
  await expect(reference.getByText(chatText, { exact: true })).toBeVisible()
  await expect(reference.getByText(th('liffChat.textReference'))).toBeVisible()
  await expect(reference.getByRole('heading', { name: th('liffChat.imagesHeading', { count: photos }) })).toBeVisible()
  const read = page.getByRole('region', { name: new RegExp(`^${literally(th('liffChat.ai.heading'))}`) })
  await expect(read.getByText(th('liffChat.ai.badge'))).toBeVisible()
  await expect(read.getByText(th('liffChat.ai.line', { description: line.description, quantity: columnOf(s, 'qty'), uom: line.unit, unitPrice: typed(unitPrice) }), { exact: true })).toBeVisible()
  await expect(read.getByText(siteName, { exact: true })).toBeVisible()
  await expect(read.getByText(supplierName, { exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: new RegExp(`^${literally(typeName)}`) })).toBeChecked()

  // AC4: the requester makes the draft in LIFF (nothing is sent from the chat)
  await page.getByRole('button', { name: th('liffChat.make'), exact: true }).click()
  await expect(page).toHaveURL(/\/liff\/requests\/[0-9a-f-]{36}\/edit$/)
  const requestId = /\/liff\/requests\/([0-9a-f-]{36})\/edit$/.exec(new URL(page.url()).pathname)![1]!

  // BR-AI-16 (AC5): the values the row names — the quantity, the unit price and the supplier, among others — wait to be
  // confirmed one by one before the request may go. Sent before that, request.submit (the command of LIFF's send)
  // refuses with AI_REVIEW_PENDING, counting each value still waiting; then the requester ticks each and confirms
  const waiting = page.getByRole('region', { name: new RegExp(`^${literally(th('liffChat.review.heading'))}`) })
  await expect(waiting.getByText(th('liffChat.ai.badge'))).toBeVisible()
  for (const path of mustConfirm) await expect(waiting.getByText(waitingLabel(path), { exact: true }), `${path} waits to be confirmed`).toBeVisible()
  const early = script<Refusal>('scripts/chat.ts', 'send-unconfirmed', requestId)
  expect(early, 'nothing is sent while values the AI filled wait').toEqual({ code: 'AI_REVIEW_PENDING', count: expect.any(Number) })
  await expect(waiting.getByRole('checkbox'), 'one box for each value request.submit counts as waiting').toHaveCount(early.count!)
  for (const box of await waiting.getByRole('checkbox').all()) await box.check()
  await waiting.getByRole('button', { name: th('liffChat.review.confirm') }).click()
  await expect(page.getByRole('region', { name: new RegExp(`^${literally(th('liffChat.review.heading'))}`) })).toHaveCount(0)

  // Step 1: the row's budget line of this fiscal year
  await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ 1 จาก 3: / })).toBeVisible()
  await page.getByLabel(th('requestForm.budget.line')).selectOption({ label: th('requestForm.budget.option', { code: budgetLine.code, name: budgetLine.nameTh }) })
  await page.getByRole('button', { name: 'ไปขั้นถัดไป: รายการที่ขอ' }).click()

  // Step 2: the AI's line, and the row's amounts in the totals, each beside its label: before VAT, VAT at the rate of
  // sheet Settings (a fraction: "0.07" is written "VAT 7%") and with VAT
  await expect(page.getByRole('heading', { level: 2, name: /^ขั้นที่ 2 จาก 3: / })).toBeVisible()
  await expect(page.getByRole('group', { name: 'รายการที่ 1' }).getByLabel('สิ่งที่ขอ')).toHaveValue(line.description)
  const vatRate = Number(sheet.settings.get('vatRate'))
  if (!Number.isFinite(vatRate)) throw new Error('sheet Settings gives no vatRate')
  const totals = page.getByRole('region', { name: th('requestForm.totals.title'), exact: true })
  await expect(totals.getByRole('term')).toHaveText([th('requestForm.totals.net'), th('requestForm.totals.vat', { rate: Math.round(vatRate * 10_000) / 100 }), th('requestForm.totals.gross')])
  await expect(totals.getByRole('definition')).toHaveText([net, vat, gross].map((amount) => th('requestForm.totals.baht', { amount: baht(amount) })))
  await page.getByRole('button', { name: 'ไปขั้นถัดไป: ตรวจและส่ง' }).click()

  // Step 3: the route the DOA expects — the row's approver, the position the rule names, the rule — then the send
  const route = page.getByRole('region', { name: th('requestForm.route.title') })
  await expect(route.getByText(approver.nameTh, { exact: true })).toBeVisible()
  await expect(route.getByText(role, { exact: true })).toBeVisible()
  await expect(route).toContainText(`ข้อ ${rule.ruleCode}:`)
  await expect(route).toContainText(`${baht(counted)} บาท`)
  await page.getByRole('button', { name: 'ส่งขออนุมัติ', exact: true }).click()
  const sent = page.getByRole('status').filter({ hasText: 'ส่งขออนุมัติแล้ว' })
  const flagged = page.getByRole('heading', { level: 3, name: 'คำขอนี้คล้ายคำขอที่คุณส่งไปแล้ว' })
  await expect(sent.or(flagged)).toBeVisible()
  await expect(flagged, 'nothing like it was sent before (BR-DUP-05)').toHaveCount(0)
  await expect(sent).toContainText(`รอ ${approver.nameTh} พิจารณา`)

  // The database: the row's request, sent in LIFF, with the photo as an OTHER file, waiting for the approver of the rule
  const facts = day<RequestFacts | null>('latest', actor.code, net.toString())
  if (!facts?.number || !facts.route) throw new Error(`no request of ${actor.code} for ${baht(net)} before VAT was sent`)
  expect(facts).toMatchObject({
    status: 'PENDING_APPROVAL',
    requestType: columnOf(s, 'requestType'),
    requester: actor.code,
    chargedDept: columnOf(s, 'chargedDept'),
    budgetLine: budgetLine.code,
    site: columnOf(s, 'site'),
    net: net.toString(),
    vat: vat.toString(),
    gross: gross.toString(),
    lines: [line.description],
    route: { ruleCode: rule.ruleCode, amountBasis: sheet.doa.amountBasis, amount: counted.toString(), doa: { code: sheet.doa.code, versionNo: sheet.doa.version } },
  })
  expect(aiType, 'the type the AI suggested is the row\'s').toBe(columnOf(s, 'requestType'))
  if (s.escalated) expect(facts.route.escalatedFromRuleCode).not.toBeNull()
  else expect(facts.route.escalatedFromRuleCode).toBeNull()
  expect([...facts.files].sort()).toEqual([...attachments].sort())
  const open = facts.tasks.filter((t) => t.status === 'OPEN')
  expect(open).toHaveLength(1)
  expect(open[0]).toMatchObject({ assignee: approver.code, principal: null, resolvedFrom: `POSITION:${held}` })
  for (const type of ['request.drafted', 'request.submitted']) expect(facts.events.find((e) => e.type === type)?.channel, `${type} was made in ${submitChannel}`).toBe(submitChannel)
  // The chat draft made this request in LIFF (AC4), with the AI's values and the photo, and its suggested supplier is the
  // row's
  expect(requestId, 'the request LIFF made of the chat draft').toBe(facts.id)
  expect(script<Drafted>('scripts/chat.ts', 'drafted', chat.intakeId)).toMatchObject({
    status: 'DRAFTED',
    requestId: facts.id,
    number: facts.number,
    supplier: columnOf(s, 'supplier'),
    event: { channel: submitChannel, images: photos, aiAssisted: true },
  })

  // The approver's task notice goes out (played job notification-deliver): as the approval card in LINE, its summary only
  const delivered = deliverPending(approver.code, facts.id)
  const task = open[0]!
  if (approverCard) {
    expect(delivered.map((d) => ({ template: d.templateKey, status: d.outcome.status, channel: d.outcome.channel }))).toContainEqual({ template: 'task.assigned', status: 'SENT', channel: 'LINE' })
    const card = await cardTo(approver.code, facts.number)
    const shown = wordsOf(card)
    expect(shown).toContain(cardRow('number', facts.number))
    expect(shown).toContain(cardRow('amount', `${baht(counted)} บาท (${cardWord(sheet.doa.amountBasis === 'GROSS' ? 'basisGross' : 'basisNet')})`))
    for (const hidden of [facts.title, line.description, chatText, supplierName]) expect(shown, `the card does not show "${hidden}"`).not.toContain(hidden)
    // Below the stepUpThreshold "อนุมัติ" approves in the chat (§9.3): the approver was linked when the task was given
    expectCardButtons(card, { taskId: task.id, number: facts.number, inChat: counted < sheet.doa.stepUpThreshold })
  } else {
    expect(delivered.filter((d) => d.outcome.channel === 'LINE')).toHaveLength(0)
  }
})
