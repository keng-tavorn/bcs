import { devices } from '@playwright/test'
import { expect, test } from '../fixtures'

// Demo scene 8 "ตรวจรับหน้างานด้วยมือถือ" (sheet Demo_Script; runbook §4), on the PO scene 7 sent: the row's actor — the
// RECEIVER of the requesters' department (§16.10 "ฉากที่ปรับ") — got the PO's po.sent notice, whose page is the
// receiving of the PO; in LINE that is the LIFF page /gr/<poId> (src/channels/line/links.ts), and as the notice comes
// in the next digest the presenter opens its LIFF deep link (runbook §4), as LINE opens one: the LIFF app's endpoint
// with the page as liff.state, the gate signing the receiver in with their LINE account. On the receiving page the
// receiver takes in what the steps say — a share of one item and all of another ("รับไม้อัด 60% และ PPE ครบ": the PO's
// lines whose descriptions name them) — with the delivery note and a photo from the phone's camera; step 2 says what
// will happen before anything is written, and once posted the PO is partly received (the status the steps name) and
// the photo is attached to the receipt, which opens it. At 375 px in the phone's browser standing in for the LINE app
// (LIFF_MOCK), every page checked and photographed (also at 1440 px). ./support.ts is imported inside the test: to the
// demo project every file of this folder is a test file (see there).

// The phone of LIFF at 375 px (§9.4): a Pixel 7 without its defaultBrowserType, a worker option that would give this file
// a worker of its own — Playwright runs each worker's files together, and the scenes must run in the files' name order
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7']
test.use({ ...pixel7, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

/** The paper that came with the goods: its number, as the receiver types it from the delivery note */
const DELIVERY_NOTE = 'DN-0815'
/** The photo as the phone's camera names it */
const PHOTO = 'delivery.jpg'

test('@demo [FR-LINE-003/AC1] [FR-LINE-003/AC3] [FR-P2P-006/AC1] [FR-P2P-006/AC2] scene 8: the department’s receiver opens the receiving link of scene 7’s PO in LIFF, takes in part of one item and all of another with the delivery note and a photo from the phone; the PO is partly received and the photo is attached to the receipt', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(240_000)
  const {
    amountOf,
    checkLiffScreen,
    deliveryPhoto,
    demoSheet,
    firstScreenShot,
    latestRequestOf,
    liffEntryOf,
    liffPageOf,
    literally,
    nameIn,
    openLiffAs,
    poOrdering,
    prepareTheDay,
    quantityOf,
    receivingIn,
    scaledQuantity,
    sceneOf,
    shareOfQuantity,
    shownQuantity,
    supplierOf,
    th,
    userOf,
  } = await import('./support')
  const sheet = await demoSheet()
  const scene = sceneOf(sheet, 8)
  expect(scene.channel).toBe('LIFF')
  const receiver = userOf(sheet, scene.actor)
  // §16.10: the receiver of the demo is the RECEIVER of the requesters' department
  const asked = sceneOf(sheet, 1)
  expect(receiver.roles, 'the row\'s actor is a RECEIVER').toContain('RECEIVER')
  expect(receiver.department, 'of the department that asked for the goods').toBe(userOf(sheet, asked.actor).department)
  const take = receivingIn(scene)
  // The status the steps say the PO ends in ("สถานะ PO เป็นรับบางส่วน")
  const partly = th('receiving.status.po.PARTIALLY_RECEIVED')
  expect(scene.stepsTh, 'the steps name the PO\'s status after the receipt').toContain(partly)

  prepareTheDay(sheet)
  const first = latestRequestOf(asked.actor, amountOf(asked, 'net'))
  if (!first?.number) throw new Error('scene 1 sent no request: run the demo scenes in order')
  const po = poOrdering(first.number)
  if (!po?.number || po.status !== 'SENT') throw new Error(`scene 7 sent no PO of scene 1's request to its supplier (${po?.status ?? 'no PO'}): run the demo scenes in order`)
  // The lines the steps name: a share of the one, all that is still to come of the other, nothing of the rest
  const lineNaming = (item: string) => {
    const found = po.lines.filter((l) => l.description.includes(item))
    if (found.length !== 1) throw new Error(`the PO has ${found.length} lines of "${item}"`)
    return found[0]!
  }
  const part = lineNaming(take.part.item)
  const whole = lineNaming(take.whole)
  expect(part.id, 'two different lines').not.toBe(whole.id)
  for (const line of po.lines) expect(line.received, `nothing of ${line.description} was received before`).toBe('0')
  const taken = new Map([
    [part.id, shareOfQuantity(part.quantity, take.part.pct)],
    [whole.id, whole.quantity],
  ])
  const leftOf = (line: (typeof po.lines)[number]) => quantityOf(scaledQuantity(line.quantity) - scaledQuantity(taken.get(line.id) ?? '0'))
  const stillComing = po.lines.filter((l) => scaledQuantity(leftOf(l)) > 0n).length

  // The po.sent notice of scene 7 reached the receiver: its page is the receiving of the PO, in LINE the LIFF page
  const notice = po.notices.find((n) => n.templateKey === 'po.sent' && n.recipient === receiver.code)
  expect(notice, 'the receiver was told the PO went out').toMatchObject({ urgency: 'DIGEST', data: { forReceiver: true } })
  const liffPage = liffPageOf(notice!.href)
  expect(liffPage, 'the notice opens the receiving page of the PO in LIFF').toBe(`/gr/${po.id}`)

  // The receiving link, as LINE opens it: the gate signs the receiver in with LINE and the page opens
  await openLiffAs(context, receiver.code)
  await page.goto(liffEntryOf(liffPage!))
  await expect(page).toHaveURL(new RegExp(`/liff/gr/${po.id}$`))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(th('receiving.detail.title', { number: po.number }))
  const main = page.getByRole('main')
  await expect(main.getByText(th('document.badge.po.SENT'), { exact: true })).toBeVisible()
  // Which PO: its supplier and site (sheets Suppliers and Sites), the requests it orders, who asked from which department
  await expect(main).toContainText(th('receiving.detail.supplier', { name: supplierOf(sheet, po.supplier.code).nameTh }))
  await expect(main).toContainText(th('receiving.detail.site', { name: nameIn(sheet.sites, po.site, 'site') }))
  for (const r of po.requests) {
    await expect(main).toContainText(th('receiving.list.requestedBy', { number: r.number ?? '', name: userOf(sheet, r.requester).nameTh, department: nameIn(sheet.departments, r.department, 'department') }))
  }
  await expect(page.getByText(th('receiving.form.step', { step: 1 }))).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene8-receive')
  await firstScreenShot(page, testInfo, 'scene8-receive')

  // FR-P2P-006 AC1: the quantities per line, the delivery note, and a photo from the camera (FR-LINE-003 AC3)
  for (const line of [part, whole]) await page.getByLabel(`${line.description}: ${th('receiving.form.receivedLabel', { uom: line.uom })}`).fill(taken.get(line.id)!)
  await page.getByLabel(th('receiving.form.deliveryNoteLabel')).fill(DELIVERY_NOTE)
  const camera = page.getByLabel(th('liffReceiving.photos.take'), { exact: true })
  await expect(camera).toHaveAttribute('capture', 'environment')
  await camera.setInputFiles({ name: PHOTO, mimeType: 'image/jpeg', buffer: await deliveryPhoto(page) })
  await expect(page.getByText(th('receiving.form.photoItem', { name: PHOTO }), { exact: true })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene8-entered')

  // Step 2, before anything is written: what is taken in and what is still to come, the PO's status after, the paper
  // and the photo
  await page.getByRole('button', { name: th('receiving.form.toReview') }).click()
  await expect(page.getByRole('heading', { level: 2, name: th('receiving.form.reviewTitle') })).toBeVisible()
  await expect(page.getByText(th('receiving.form.step', { step: 2 }))).toBeVisible()
  await expect(page.getByText(th('receiving.form.afterPartial', { count: stillComing }))).toBeVisible()
  for (const line of [part, whole]) {
    const got = shownQuantity(taken.get(line.id)!)
    await expect(page.getByText(th('receiving.form.reviewLine', { received: got, uom: line.uom, accepted: got, left: shownQuantity(leftOf(line)) }))).toBeVisible()
  }
  await expect(page.getByText(th('receiving.form.deliveryNoteValue', { number: DELIVERY_NOTE }))).toBeVisible()
  await expect(page.getByText(th('receiving.form.photoCount', { count: 1 }))).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene8-review')
  await firstScreenShot(page, testInfo, 'scene8-review')
  await page.getByRole('button', { name: th('receiving.form.confirm') }).click()

  // FR-P2P-006 AC2: posted; the PO is partly received
  const doneTitle = new RegExp(`^${literally(th('receiving.form.doneTitle', { number: '__N__' })).replace('__N__', '(\\S+)')}$`)
  await expect(page.getByText(doneTitle)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(th('receiving.form.donePo', { status: partly }))).toBeVisible()
  // The PO's badge (§9.10) says the same in its own word
  await expect(main.getByText(th('document.badge.po.PARTIALLY_RECEIVED'), { exact: true })).toBeVisible()
  const receipts = page.getByRole('list', { name: th('receiving.history.label') })
  for (const line of [part, whole]) {
    const got = shownQuantity(taken.get(line.id)!)
    await expect(receipts).toContainText(th('receiving.history.line', { description: line.description, received: got, uom: line.uom, accepted: got }))
  }
  await expect(receipts).toContainText(th('receiving.history.deliveryNote', { number: DELIVERY_NOTE }))
  await checkLiffScreen(page, testInfo, 'scene8-received')

  // As the database has it: posted by the receiver on channel LIFF, the quantities taken in, the photo attached to the
  // receipt as a photo; the PO partly received
  const received = poOrdering(first.number)!
  expect(received.status).toBe('PARTIALLY_RECEIVED')
  expect(received.receipts).toHaveLength(1)
  const receipt = received.receipts[0]!
  expect(receipt).toMatchObject({ status: 'POSTED', receiver: receiver.code, channel: 'LIFF', deliveryNoteNo: DELIVERY_NOTE, photos: [{ kind: 'PHOTO', fileName: PHOTO, mimeType: 'image/jpeg' }] })
  expect(receipt.lines.filter((l) => scaledQuantity(l.received) > 0n).map((l) => ({ poLineId: l.poLineId, received: l.received, accepted: l.accepted })).sort((a, b) => a.poLineId.localeCompare(b.poLineId))).toEqual(
    [...taken].map(([poLineId, quantity]) => ({ poLineId, received: quantity, accepted: quantity })).sort((a, b) => a.poLineId.localeCompare(b.poLineId)),
  )
  for (const line of received.lines) expect(line.received, line.description).toBe(taken.get(line.id) ?? '0')
  await expect(page.getByText(receipt.number!, { exact: true })).toBeVisible()
  // The photo opens from the receipt, through a short-lived address
  await receipts.getByRole('button', { name: th('receiving.history.openPhoto', { name: PHOTO }) }).click()
  await expect(page.getByRole('img', { name: th('receiving.form.photoItem', { name: PHOTO }) })).toBeVisible()
  await checkLiffScreen(page, testInfo, 'scene8-photo')
})
