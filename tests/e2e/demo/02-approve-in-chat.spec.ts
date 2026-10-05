import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'

// Demo scene 2 "อนุมัติในแชท" (sheet Demo_Script; runbook §4), on the request scene 1 sent: the notification job delivers
// the approver's notice and the approval card reaches the approver's LINE (the fake LINE server of the run) with the
// summary only; below sheet DOA_Policy's stepUpThreshold the approver taps the button the row's steps name ("อนุมัติ") —
// LINE's signed postback, sent with `pnpm line:simulate` — and the app decides it on channel LINE_CHAT and answers with
// the confirmation card by reply. As §16.10 "ฉากที่ปรับ" has it, the channel and the DOA reference are then read on the
// request page's timeline (request.view ASSIGNED: the approver had a task on it), opened from the confirmation's
// "ดูรายละเอียด" in LIFF at 375 px: the stamp says who (name and position), what, when, on which channel, under which
// DOA version and rule. The scene's row names the approver (actor), the channel, the button and the DOA reference its
// steps quote; the request, its amounts and its rule are scene 1's row's, the DOA's code and version sheet DOA_Policy's.
// ./support.ts is imported inside the test: to the demo project every file of this folder is a test file (see there).

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
    countedOf,
    deliverPending,
    demoSheet,
    doaRefOf,
    expectApprovalCard,
    latestRequestOf,
    liffPathOf,
    openLiffAs,
    openTaskOf,
    prepareTheDay,
    requestFacts,
    requestTimeline,
    sceneOf,
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
  // FR-LINE-002 AC2: the amount the DOA counts is below sheet DOA_Policy's stepUpThreshold, so the card approves in the chat
  expect(countedOf(sheet, asked), 'scene 1\'s amount on the DOA\'s basis is below the stepUpThreshold').toBeLessThan(sheet.doa.stepUpThreshold)
  // The DOA reference the scene's steps name ("DOA-DEMO ฉบับ 1 ข้อ PR-02"): sheet DOA_Policy's code and version, and
  // the rule of scene 1's row; and the button they tap
  const doaRef = doaRefOf({ code: sheet.doa.code, versionNo: sheet.doa.version }, asked.expectedRule!)
  expect(scene.stepsTh, 'the steps of the scene name the DOA reference the timeline shows').toContain(doaRef)
  const button = tappedIn(scene)

  prepareTheDay(sheet)
  const request = latestRequestOf(asked.actor, amountOf(asked, 'net'))
  if (!request?.number || !request.route) throw new Error('scene 1 sent no request: run the demo scenes in order')
  const number = request.number
  const task = openTaskOf(request)
  expect(task).toMatchObject({ assignee: scene.actor, principal: null, resolvedFrom: role.resolvedFrom })
  expect(request.route).toMatchObject({ ruleCode: asked.expectedRule, amount: countedOf(sheet, asked).toString(), doa: { code: sheet.doa.code, versionNo: sheet.doa.version } })

  // The notification job delivers the approver's notice about it: by LINE, as the approval card with the summary only
  // (FR-LINE-002 AC1) — not the title, nor any line of what is asked for
  const delivered = deliverPending(scene.actor, request.id)
  expect(delivered.map((d) => ({ template: d.templateKey, status: d.outcome.status, channel: d.outcome.channel }))).toContainEqual({ template: 'task.assigned', status: 'SENT', channel: 'LINE' })
  const card = await cardTo(scene.actor, number)
  expectApprovalCard(sheet, card, { number, scene: asked, task, doaRef, hidden: [request.title, ...request.lines] })
  // With the approver's LINE token: the button the steps name is a postback of v, a and k only (BR-TOK-02), and LINE
  // shows what was tapped in the chat
  const approve = actionsOf(card).find((a) => a.type === 'postback')
  expect(approve).toMatchObject({ label: button, displayText: `${button} ${number}` })
  expect(approve?.data).toMatch(/^v=1&a=approve&k=[0-9a-f-]{36}$/)

  // The approver taps it: LINE's postback webhook, signed with the channel secret
  const tap = tapPostback(testInfo, scene.actor, approve!.data!)
  expect(tap.status, tap.printed).toBe(200)
  // The confirmation card, by reply while the reply token is fresh (FR-LINE-007 AC2): the document and its DOA reference
  const answer = await answerTo(tap)
  expect(answer.kind).toBe('reply')
  const confirmation = answer.messages[0]!
  expect(confirmation.type, 'the confirmation is a card').toBe('flex')
  const said = wordsOf(confirmation)
  expect(said).toContain('อนุมัติแล้ว')
  expect(said).toContain(number)
  expect(said).toContain(`อนุมัติภายใต้ ${doaRef}`)

  // Decided once, by the approver for nobody else, in the chat, with the DOA version and rule on the event (FR-DOA-005 AC1)
  const decided = requestFacts(number)
  expect(decided.status).toBe('APPROVED')
  const done = decided.tasks.find((t) => t.id === task.id)
  expect(done).toMatchObject({
    status: 'APPROVED',
    decision: 'APPROVE',
    channel: 'LINE_CHAT',
    decided: { channel: 'LINE_CHAT', by: scene.actor, onBehalfOf: null, doaVersionId: request.route.doa.versionId, doaRuleCode: request.route.ruleCode },
  })

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
