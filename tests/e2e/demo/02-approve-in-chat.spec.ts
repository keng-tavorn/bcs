import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'

// Demo scene 2 "อนุมัติในแชท" (sheet Demo_Script; runbook §4), on the request scene 1 sent: the notification job delivers
// the approver's notice and the approval card reaches the approver's LINE (the fake LINE server of the run) with the
// summary only. The premise, by the sheets: the amount the DOA counts for scene 1's row is below sheet DOA_Policy's
// stepUpThreshold, so the card carries the in-chat approve — §9.3's postback, which LINE shows in the chat as
// "อนุมัติ <number>" — and the approver taps the button the row's steps name ("อนุมัติ"): LINE's signed postback, sent
// with `pnpm line:simulate`. The app decides it on channel LINE_CHAT and answers with the confirmation card, a Flex
// message by reply with the tap's reply token (no push). As §16.10 "ฉากที่ปรับ" has it, the channel and the DOA reference
// are then read on the request page's timeline (request.view ASSIGNED: the approver had a task on it), opened from the
// confirmation's "ดูรายละเอียด" in LIFF at 375 px: the stamp says who (name and position), what, when, on which channel,
// under which DOA version and rule. The scene's row names the approver (actor), the channel, the button and the DOA
// reference its steps quote; the request, its amounts and its rule are scene 1's row's, the DOA's code, version and
// stepUpThreshold sheet DOA_Policy's. ./support.ts is imported inside the test: to the demo project every file of this
// folder is a test file (see there).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

test('@demo [FR-LINE-002/AC1] [FR-LINE-002/AC2] [FR-LINE-007/AC2] [FR-DOA-005/AC1] [FR-PLT-003/AC3] scene 2: the approval card of scene 1’s request reaches the approver in LINE; "อนุมัติ" in the chat approves it on channel LINE_CHAT, the confirmation card comes back, and the request page’s timeline stamps who, when, the channel and the DOA reference', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000)
  const {
    actionsOf,
    amountOf,
    answerTo,
    approverByRule,
    cardTo,
    cardWord,
    channelLabel,
    checkLiffScreen,
    confirmationWord,
    countedOf,
    deliverPending,
    demoSheet,
    expectApprovalCard,
    expectCardButtons,
    latestRequestOf,
    liffPathOf,
    nameIn,
    openLiffAs,
    openTaskOf,
    prepareTheDay,
    pushesSince,
    requestFacts,
    requestTimeline,
    sceneOf,
    sheetDoa,
    sheetDoaRef,
    stampRoleOf,
    tapPostback,
    tappedIn,
    th,
    thaiDateTime,
    userOf,
    wordsOf,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 2)
  expect(scene.channel).toBe('LINE_CHAT')
  // The request of scene 1, whose row sends it to this scene's approver, at the position its rule names
  const asked = sceneOf(sheet, 1)
  expect(asked.expectedApprover).toBe(scene.actor)
  const approver = userOf(sheet, scene.actor)
  const role = approverByRule(sheet, asked.expectedRule, asked.chargedDept)
  expect(role.member).toBe(scene.actor)
  // The premise (FR-LINE-002 AC2): the amount the DOA counts for scene 1's row is below sheet DOA_Policy's
  // stepUpThreshold, so the card approves in the chat with no PIN
  expect(countedOf(sheet, asked), 'scene 1\'s amount on the DOA\'s basis is below the stepUpThreshold of sheet DOA_Policy').toBeLessThan(sheet.doa.stepUpThreshold)
  // The DOA reference the scene's steps name ("DOA-DEMO ฉบับ 1 ข้อ PR-02"): sheet DOA_Policy's code and version, and
  // the rule of scene 1's row; and the button they tap, which is the card's approve
  const doaRef = sheetDoaRef(sheet, asked.expectedRule)
  expect(scene.stepsTh, 'the steps of the scene name the DOA reference the timeline shows').toContain(doaRef)
  const button = tappedIn(scene)
  expect(button, 'the steps tap the card\'s approve button').toBe(cardWord('approve'))
  const typeName = nameIn(sheet.requestTypes, asked.requestType, 'request type')

  prepareTheDay(sheet)
  // The DOA in effect is sheet DOA_Policy's, with its stepUpThreshold
  const doa = sheetDoa(sheet)
  const request = latestRequestOf(asked.actor, amountOf(asked, 'net'))
  if (!request?.number || !request.route) throw new Error('scene 1 sent no request: run the demo scenes in order')
  const number = request.number
  const task = openTaskOf(request)
  expect(task).toMatchObject({ assignee: scene.actor, principal: null, resolvedFrom: role.resolvedFrom })
  expect(request.route).toMatchObject({ ruleCode: asked.expectedRule, amount: countedOf(sheet, asked).toString(), doa: { versionId: doa.id, code: sheet.doa.code, versionNo: sheet.doa.version } })

  // The notification job delivers the approver's notice about it: by LINE, as the approval card with the summary only
  // (FR-LINE-002 AC1) — not the title, nor any line of what is asked for
  const delivered = deliverPending(scene.actor, request.id)
  expect(delivered.map((d) => ({ template: d.templateKey, status: d.outcome.status, channel: d.outcome.channel }))).toContainEqual({ template: 'task.assigned', status: 'SENT', channel: 'LINE' })
  const card = await cardTo(scene.actor, number)
  expectApprovalCard(sheet, card, { number, scene: asked, task, doaRef, hidden: [request.title, ...request.lines] })
  // §9.3: with the approver's LINE token, "อนุมัติ" is the postback v=1&a=approve&k=<tokenId> (BR-TOK-02) whose
  // displayText LINE shows in the chat — "อนุมัติ <number>" — beside "ตีกลับ / ไม่อนุมัติ" and "ดูรายละเอียด" into LIFF
  const approve = expectCardButtons(card, { taskId: task.id, number, inChat: true })
  expect(approve).toMatchObject({ type: 'postback', label: button, displayText: `${button} ${number}` })

  // The approver taps it: LINE's postback webhook, signed with the channel secret
  const tap = tapPostback(testInfo, scene.actor, approve.data!)
  expect(tap.status, tap.printed).toBe(200)
  expect(tap.replyToken, 'the event LINE sent carries a reply token').not.toBeNull()
  // FR-LINE-007 AC2: the answer is a reply with the tap's reply token while it is fresh, not a push
  const answer = await answerTo(tap)
  expect(answer, 'the answer is the reply to the tap').toMatchObject({ kind: 'reply', replyToken: tap.replyToken })
  expect(await pushesSince(scene.actor, tap.sentAt), 'nothing was pushed to the approver for the tap').toEqual([])

  // Decided once, by the approver for nobody else, in the chat, with the DOA version and rule on the event (FR-DOA-005 AC1)
  const decided = requestFacts(number)
  expect(decided.status).toBe('APPROVED')
  const done = decided.tasks.find((t) => t.id === task.id)
  expect(done).toMatchObject({
    status: 'APPROVED',
    decision: 'APPROVE',
    channel: 'LINE_CHAT',
    decided: { channel: 'LINE_CHAT', by: scene.actor, onBehalfOf: null, doaVersionId: doa.id, doaRuleCode: asked.expectedRule },
  })
  expect(done!.decidedAt, 'the task records when it was decided').not.toBeNull()

  // FR-LINE-002 AC2 (§9.3 "ผลสำเร็จตอบด้วยการ์ดยืนยันที่มี DOA ref"): the reply is one message, the confirmation card — a
  // Flex message that says the request is approved, which one, under which DOA version and rule, when, and that every
  // step is done (the demo DOA has one step), with "ดูรายละเอียด"
  expect(answer.messages, 'the reply is one message').toHaveLength(1)
  const confirmation = answer.messages[0]!
  expect(confirmation.type, 'the confirmation is a Flex message').toBe('flex')
  expect(confirmation.altText, 'what LINE shows of the card in the chat list').toBe(`${confirmationWord('header')}: ${typeName} ${number}`)
  const said = wordsOf(confirmation)
  for (const words of [
    confirmationWord('header'),
    `${typeName} ${number}`,
    `${confirmationWord('under')} ${doaRef}`,
    `${confirmationWord('at')} ${thaiDateTime(done!.decidedAt!)}`,
    confirmationWord('done'),
  ]) {
    expect(said, `the confirmation card says "${words}"`).toContain(words)
  }

  // "ดูรายละเอียด" of the confirmation opens the request's page in LIFF: the timeline stamps the approval with who
  // approved (name and position), when and on which channel, and the DOA version and rule (FR-PLT-003 AC3); the page
  // says what it was approved under
  const details = actionsOf(confirmation).find((a) => a.type === 'uri')
  expect(details).toMatchObject({ label: cardWord('details') })
  await openLiffAs(context, scene.actor)
  await page.goto(liffPathOf(details!.uri!))
  await expect(page).toHaveURL(new RegExp(`/liff/requests/${request.id}$`))
  await expect(page.getByRole('heading', { level: 1, name: number })).toBeVisible()
  const stamp = requestTimeline(page).getByRole('listitem').filter({ hasText: channelLabel('LINE_CHAT') })
  await expect(stamp).toHaveCount(1)
  await expect(stamp).toContainText(th('requestView.timeline.what.APPROVED'))
  await expect(stamp).toContainText(`${approver.nameTh} · ${stampRoleOf(role)}`)
  await expect(stamp).toContainText(`${thaiDateTime(done!.decided!.at)} · ${channelLabel('LINE_CHAT')}`)
  await expect(stamp).toContainText(doaRef)
  await expect(page.locator('p').filter({ hasText: 'อนุมัติภายใต้' })).toContainText(doaRef)
  await checkLiffScreen(page, testInfo, 'scene2-request-approved')
})
