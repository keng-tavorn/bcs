import { baht, th } from '../demo/support'
import { expect, test } from '../fixtures'
import { appPhone, FAKE_PUSH_ENV, fakePushes, fingerprint } from './go-steps'
import { columnOf, countedOf, day, expectedOf, p1Sheet, sceneOf, script, scriptWith, signInAs, userOf } from './support'

// Scene 2 of the day of phase 1 (P1-08 · S17 · sheet Demo_Script_P1 row of scene 2): the request of an earlier scene
// (expectJson.requestOfScene — scene 1's contract work, past its three reviewers) waits for the row's approver. Before
// the day the approver added a passkey in BCS Go (the password again, the device's name of expectJson) and the phone was
// registered for push; the notice of the task goes by push (expectJson.pushTemplate) with the document's number only —
// no amount, name or subject (BR-NOTI-06). The tap opens the task in the app; at an amount from stepUpThreshold the
// approval asks for a step-up and the approver gives it with the fingerprint (passkey, FR-PLT-301 AC3). The decision's
// channel is the app's (FR-PLT-301 AC1), and the route and the history of the request say "แอป BCS Go". The request ends
// as expectJson.requestStatusAfter says. The phone is the mobile browser with BCS Go's mark in its user agent (the
// native halves are tried on a phone, docs/runbooks/bcs-go-demo.md); the delivery job is played by the scene.
// For the scenes after this one: the approver keeps the ANDROID push device registered here, with "รับแจ้งเตือนในแอป"
// on, so the notification route tries push first for them (golden notification-route). A later scene that delivers the
// approver's notices must play the job with the fake FCM — scriptWith(FAKE_PUSH_ENV, …), as deliver-push does here —
// not with a bare day('deliver', …), which runs without FAKE_PUSH_ENV. Today no later scene delivers to this approver.

interface RequestFacts {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly title: string
  readonly requestType: string
  readonly requester: string
  readonly gross: string
  readonly route: { readonly ruleCode: string; readonly doa: { readonly versionId: string } } | null
  readonly tasks: ReadonlyArray<{
    readonly id: string
    readonly stepNo: number
    readonly status: string
    readonly assignee: string
    readonly decision: string | null
    readonly channel: string | null
    readonly decided: { readonly channel: string; readonly doaRuleCode: string | null; readonly doaVersionId: string | null; readonly stepUp: boolean } | null
  }>
}

test('@p1demo [FR-PLT-301/AC1] [FR-PLT-301/AC3] scene 2: the approver gets the push of scene 1\'s request, opens the task in BCS Go and approves it with a passkey; the route and the history say "แอป BCS Go"', async ({
  browser,
}) => {
  test.setTimeout(6 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 2)
  expect([scene.area, scene.channel, scene.expectedOutcome]).toEqual(['APP_APPROVE', 'APP', 'APPROVED'])
  // The request is the one an earlier scene sent: its row says who asked, for what and how much
  const asked = sceneOf(sheet, expectedOf<number>(scene, 'requestOfScene'))
  expect([asked.expectedRule, asked.expectedApprover], `scene ${asked.scene}'s request goes to this scene's approver under its rule`).toEqual([scene.expectedRule, scene.expectedApprover])
  const approver = userOf(sheet, scene.actor)
  expect(approver.code).toBe(scene.expectedApprover)
  const requester = userOf(sheet, asked.actor)
  const [net, gross] = [columnOf(asked, 'net'), columnOf(asked, 'gross')]
  const supplierName = sheet.suppliers.get(columnOf(asked, 'supplier'))?.nameTh
  if (!supplierName) throw new Error(`sheet Suppliers has no ${asked.supplier}`)
  // The premise of the passkey: the amount the DOA counts reaches stepUpThreshold (sheet DOA_Policy)
  expect(countedOf(sheet, asked) >= sheet.doa.stepUpThreshold, `${baht(countedOf(sheet, asked))} needs a step-up (stepUpThreshold ${baht(sheet.doa.stepUpThreshold)})`).toBe(true)

  const request = day<RequestFacts | null>('latest', asked.actor, net.toString())
  if (!request) throw new Error(`scene ${asked.scene} sent no request: run the p1demo scenes in order`)
  expect({ requestType: request.requestType, gross: request.gross, rule: request.route?.ruleCode, status: request.status }).toEqual({
    requestType: asked.requestType,
    gross: gross.toString(),
    rule: scene.expectedRule,
    status: 'PENDING_APPROVAL',
  })
  // Its reviewers all passed (scene 1), and the approver's task is open
  expect(request.tasks.filter((t) => t.stepNo === 1).map((t) => ({ assignee: t.assignee, status: t.status })).sort((a, b) => a.assignee.localeCompare(b.assignee))).toEqual(
    asked.expectedReviewers.map((r) => ({ assignee: r.member, status: 'APPROVED' })).sort((a, b) => a.assignee.localeCompare(b.assignee)),
  )
  const task = request.tasks.find((t) => t.status === 'OPEN' && t.assignee === approver.code)
  if (!task) throw new Error(`scene ${asked.scene}'s reviewers have not all passed: no open task of ${approver.code}`)

  const context = await appPhone(browser)
  try {
    const page = await context.newPage()
    // The fingerprint exists before any page of the app loads
    await fingerprint(page)
    await signInAs(page, sheet, approver.code)
    // Before the day: the approver's passkey, added in the app after the password again (FR-PLT-301 AC4)
    await page.goto('/settings/pin')
    await page.getByRole('button', { name: th('pinSettings.passkey.add') }).click()
    const form = page.getByRole('form', { name: th('pinSettings.passkey.addTitle') })
    // A member with an authenticator app (sheet Users) chooses between the two proofs: the password here
    if (approver.twoFactor) await form.getByRole('radio', { name: th('pinSettings.prove.PASSWORD'), exact: true }).check()
    await form.getByLabel(th('pinSettings.prove.password'), { exact: true }).fill(process.env.SEED_DEV_PASSWORD!)
    await form.getByLabel(th('pinSettings.passkey.label'), { exact: true }).fill(expectedOf<string>(scene, 'passkeyDeviceLabel'))
    await form.getByRole('button', { name: th('pinSettings.passkey.addSubmit') }).click()
    await expect(page.getByText(th('pinSettings.passkey.added'))).toBeVisible()

    let path = `/tasks/${task.id}`
    if (expectedOf<boolean>(scene, 'push')) {
      // The phone registered for push (the app does it once FCM gives its token), then the task's notice goes by push
      const device = script<{ token: string }>('scripts/go.ts', 'push-device', approver.code, String(scene.scene))
      const template = expectedOf<string>(scene, 'pushTemplate')
      const delivered = scriptWith<{ outcomes: Array<{ status: string; channel?: string }> }>(FAKE_PUSH_ENV, 'scripts/go.ts', 'deliver-push', approver.code, request.id, template)
      expect(delivered.outcomes).toEqual([{ status: 'SENT', channel: 'PUSH' }])
      const push = (await fakePushes()).find((p) => p.token === device.token)
      // BR-NOTI-06: a title, the document's number, the page to open — no amount, no name, no subject
      expect(push).toMatchObject({ title: th(`push.${template}.title`), body: request.number, data: expect.objectContaining({ path: `/tasks/${task.id}` }) })
      const shown = JSON.stringify(push)
      const amounts = [net, gross].flatMap((amount) => [baht(amount), amount.toString().slice(0, -2)])
      for (const secret of [...amounts, request.title, requester.nameTh, approver.nameTh, supplierName]) expect(shown, 'the push names no amount, subject, person or supplier').not.toContain(secret)
      path = push!.data.path!
    }

    // The tap opens the task in the app; from stepUpThreshold the approval asks for a step-up: the fingerprint gives it
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(request.title)
    await expect(page.getByText(th('tasks.detail.requestLabel', { number: request.number }), { exact: true })).toBeVisible()
    await page.getByRole('button', { name: th('tasks.decide.approve'), exact: true }).click()
    const confirm = page.getByRole('group', { name: new RegExp(`^${th('tasks.decide.approve')} ${request.number} `) })
    await expect(confirm).toContainText(baht(gross))
    expect(expectedOf<string>(scene, 'stepUpMethod')).toBe('PASSKEY')
    await confirm.getByRole('button', { name: th('tasks.passkey.approve') }).click()
    await expect(page.getByRole('region', { name: request.title }).getByText(th('tasks.decide.approved'), { exact: true })).toBeVisible()

    // As decided: the app's channel, under the rule and version of the route, with the passkey's step-up
    const after = day<RequestFacts | null>('request', request.number)!
    expect(after.status).toBe(expectedOf<string>(scene, 'requestStatusAfter'))
    const decided = after.tasks.find((t) => t.id === task.id)!
    expect(decided).toMatchObject({ status: 'APPROVED', decision: 'APPROVE', channel: expectedOf<string>(scene, 'decisionChannel') })
    expect(decided.decided).toMatchObject({ channel: expectedOf<string>(scene, 'decisionChannel'), doaRuleCode: scene.expectedRule, doaVersionId: after.route!.doa.versionId, stepUp: true })
    expect(script<{ method: string | null }>('scripts/go.ts', 'grant', task.id).method).toBe(expectedOf<string>(scene, 'stepUpMethod'))

    // FR-PLT-003 AC3: the route and the history name the channel of the decision
    const channel = th(`timeline.channel.${expectedOf<string>(scene, 'decisionChannel')}`)
    await page.goto(`/requests/${request.id}`)
    const approverStep = page.getByRole('list', { name: th('document.steps.list') }).getByRole('listitem').filter({ hasText: approver.nameTh })
    await expect(approverStep.first()).toContainText(th('tasks.decide.approved'))
    await expect(approverStep.first()).toContainText(channel)
    await page.getByRole('tab', { name: th('document.tabs.history') }).click()
    await expect(page).toHaveURL(/[?&]tab=history/)
    const history = page.getByRole('list', { name: th('document.history.table') }).getByRole('listitem').filter({ hasText: approver.nameTh }).filter({ hasText: th('tasks.decide.approve') })
    await expect(history.first()).toContainText(channel)
  } finally {
    await context.close()
  }
})
