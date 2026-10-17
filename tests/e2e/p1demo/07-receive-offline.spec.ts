import { baht, literally, th, typed } from '../demo/support'
import { expect, test } from '../fixtures'
import { appPhone, pending, photo } from './go-steps'
import { columnOf, day, expectedOf, historyOf, p1Sheet, sceneOf, script, signInAs, userOf } from './support'

// Scene 7 of the day of phase 1 (P1-08 · S17 · sheet Demo_Script_P1 row of scene 7): the row's receiver takes the goods
// of a PO of the past (the row's Request_History row, its PO sent to the supplier) at the site, in BCS Go, without a
// signal. With the signal the app prepares the POs the receiver may take offline (as many as the service offers): copies
// without a price — neither the copy the phone keeps nor the PO found and its form carry the row's unit price, net or
// gross (FR-PLT-301 AC5). Then, offline, the receiver finds the PO by its number (the camera's QR is tried on a phone),
// records the row's quantity, the delivery note of expectJson and its photos, and keeps it on the phone: nothing reaches
// the server (AC6 AC7). With the signal back the photo goes up and the receipt goes by itself (AC8);
// expectJson.lostAnswers of its answers are lost on the way, so the page sends it again with the same idempotency key,
// and the server keeps one receipt. The PO is then as expectJson says, with its receipt captured offline on the app's
// channel.

interface PoFacts {
  readonly id: string
  readonly number: string
  readonly status: string
  readonly supplier: { readonly code: string }
  readonly site: string | null
  readonly lines: ReadonlyArray<{ readonly description: string; readonly quantity: string; readonly uom: string }>
  readonly receipts: ReadonlyArray<{ readonly number: string; readonly status: string; readonly receiver: string; readonly deliveryNoteNo: string | null; readonly channel: string | null }>
}

interface Receipts {
  readonly status: string
  readonly receipts: ReadonlyArray<{ readonly number: string; readonly status: string; readonly offline: boolean; readonly quantities: readonly string[]; readonly photos: number; readonly channel: string | null }>
}

test('@p1demo [FR-PLT-301/AC5] [FR-PLT-301/AC6] [FR-PLT-301/AC7] [FR-PLT-301/AC8] scene 7: the receiver records the goods of a sent PO in BCS Go without a signal; back online it goes once, its lost answer sent again with the same key: one receipt', async ({
  browser,
}) => {
  test.setTimeout(6 * 60_000)
  const sheet = await p1Sheet()
  const scene = sceneOf(sheet, 7)
  expect([scene.area, scene.channel, scene.expectedOutcome]).toEqual(['OFFLINE_RECEIVE', 'APP_OFFLINE', 'RECEIVED'])
  // The row is the history row's PO: the same goods, supplier and site, and the receiver may take it
  const row = historyOf(sheet, scene.historyRef)
  expect(row.status, `Request_History ${row.ref} is ordered (its PO sent)`).toBe('ORDERED')
  expect({ type: row.requestType, dept: row.chargedDept, key: row.budgetKey, site: row.site, supplier: row.supplier, item: row.itemCode, qty: row.qty, unitPrice: row.unitPrice, net: row.net, vat: row.vat, gross: row.gross }).toEqual({
    type: scene.requestType,
    dept: scene.chargedDept,
    key: scene.budgetKey,
    site: scene.site,
    supplier: scene.supplier,
    item: scene.itemCode,
    qty: scene.qty,
    unitPrice: scene.unitPrice,
    net: scene.net,
    vat: scene.vat,
    gross: scene.gross,
  })
  const receiver = userOf(sheet, scene.actor)
  expect(receiver.roles).toContain('RECEIVER')
  expect(receiver.department).toBe(row.chargedDept)
  const item = sheet.items.get(columnOf(scene, 'itemCode'))
  if (!item) throw new Error(`sheet Items has no ${scene.itemCode}`)
  const qty = columnOf(scene, 'qty')
  const deliveryNote = expectedOf<string>(scene, 'deliveryNoteNo')
  const photos = expectedOf<number>(scene, 'photos')
  const lost = expectedOf<number>(scene, 'lostAnswers')
  // FR-PLT-301 AC5: the row's unit price, net and gross as a page or a copy could write them — "2780.00", "2,780.00" and,
  // from 1,000 baht, whole baht with its thousands ("2,780"); never a bare number, which a PO's number could hold
  const prices = [columnOf(scene, 'unitPrice'), columnOf(scene, 'net'), columnOf(scene, 'gross')]
  const written = prices.flatMap((amount) => [typed(amount), baht(amount), ...(amount >= 100_000n ? [(amount / 100n).toLocaleString('en-US')] : [])])

  // The PO of the history row, found by the row (the seed's events carry its key), never by a number typed here
  const history = day<{ number: string } | null>('history', row.ref)
  if (!history) throw new Error(`the seed made no request for Request_History ${row.ref}`)
  const po = day<PoFacts | null>('po', history.number)
  if (!po) throw new Error(`no PO orders ${row.ref}'s request ${history.number}`)
  if (po.status !== expectedOf<string>(scene, 'poStatusBefore') || po.receipts.length) {
    throw new Error(`${row.ref}'s PO is ${po.status} with ${po.receipts.length} receipt(s), not waiting for its goods: reset the p1demo database (scene 7 runs once per seed)`)
  }
  expect({ supplier: po.supplier.code, site: po.site, lines: po.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), uom: l.uom })) }).toEqual({
    supplier: scene.supplier,
    site: scene.site,
    lines: [{ description: item.nameTh, quantity: Number(qty), uom: item.unit }],
  })
  // What the receiver's phone keeps for receiving offline: the service's count, never typed
  const copies = script<{ count: number; numbers: string[] }>('scripts/go.ts', 'copies', receiver.code)
  expect(copies.numbers).toContain(po.number)

  // A phone without the service worker, so that the page's route sees the receipt's request
  const context = await appPhone(browser, { serviceWorkers: 'block' })
  try {
    const page = await context.newPage()
    await signInAs(page, sheet, receiver.code)
    // The runbook's way in: the menu's receiving page, then the app's receiving without a signal
    await page.goto('/receiving')
    await page.getByRole('link', { name: th('receiving.list.goReceive') }).click()
    await expect(page).toHaveURL(/\/go\/receive$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(th('goReceive.title'))
    // What the phone keeps is the page's answer from the service (the page also asks once by itself when it opens)
    const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/go/receiving/prepare' && r.request().method() === 'GET' && r.ok())
    await page.getByRole('button', { name: th('goReceive.prepare.button') }).click()
    await expect(page.getByText(th('goReceive.prepare.done', { count: copies.count }))).toBeVisible()
    await expect(page.getByRole('button', { name: th('goReceive.prepare.record', { number: po.number }) })).toBeVisible()
    // AC5: the copy of the PO the phone keeps has no price — no key that names one, none of the row's amounts
    const kept = ((await (await prepared).json()) as { copies: Array<{ number: string | null }> }).copies.find((c) => c.number === po.number)
    expect(kept, `the phone keeps a copy of ${po.number}`).toBeDefined()
    const keptText = JSON.stringify(kept)
    expect(keptText, 'no key of the copy names a price, amount, VAT or total').not.toMatch(/"\w*(?:price|amount|satang|vat|gross|net|total)\w*":/i)
    for (const amount of prices) expect(keptText, 'the copy carries none of the row\'s amounts in satang').not.toMatch(new RegExp(`[":]${amount}[",}]`))
    for (const shape of written) expect(keptText, 'the copy carries none of the row\'s amounts in baht').not.toContain(shape)

    // The server records the receipt; the first answers never reach the phone
    const keys: string[] = []
    await page.route('**/api/go/receiving/gr', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      keys.push(route.request().headers()['idempotency-key'] ?? '')
      if (keys.length > lost) return route.continue()
      await route.fetch()
      await route.abort('connectionfailed')
    })

    await context.setOffline(true)
    try {
      // The PO's number, as the scanner's value would find it (expectJson.find TYPED)
      expect(expectedOf<string>(scene, 'find')).toBe('TYPED')
      await page.getByLabel(th('goReceive.find.typedLabel')).fill(po.number)
      await page.getByRole('button', { name: th('goReceive.find.typedButton') }).click()
      const found = page.getByRole('dialog', { name: po.number })
      await expect(found).toContainText(th('goReceive.prepare.lines', { count: po.lines.length }))
      // AC5: the PO found shows no price
      for (const shape of written) await expect(found, 'the PO found shows none of the row\'s amounts').not.toContainText(shape)
      await found.getByRole('button', { name: th('goReceive.prepare.record', { number: po.number }) }).click()
      const form = page.getByRole('region', { name: th('goReceive.form.title', { number: po.number }) })
      await expect(form.getByRole('heading', { name: th('goReceive.form.title', { number: po.number }) })).toBeVisible()
      await expect(form.getByText(item.nameTh).first()).toBeVisible()
      // AC5: nor does its form
      for (const shape of written) await expect(form, 'the receipt form shows none of the row\'s amounts').not.toContainText(shape)
      // Each field by the line it belongs to (the label names the line for a screen reader)
      await form.getByLabel(`${item.nameTh}: ${th('receiving.form.receivedLabel', { uom: item.unit })}`).fill(qty)
      await form.getByLabel(th('receiving.form.deliveryNoteLabel'), { exact: true }).fill(deliveryNote)
      for (let n = 1; n <= photos; n++) await form.locator('input[type=file]').setInputFiles({ name: `receipt-${n}.jpg`, mimeType: 'image/jpeg', buffer: await photo(page) })
      for (let n = 1; n <= photos; n++) await expect(form.getByRole('button', { name: th('receiving.form.removePhoto', { name: `receipt-${n}.jpg` }), exact: true })).toBeVisible()
      const removable = new RegExp(`^${literally(th('receiving.form.removePhoto')).replace(literally('{name}'), '.+')}$`)
      await expect(form.getByRole('button', { name: removable })).toHaveCount(photos)
      await form.getByRole('button', { name: th('goReceive.form.save') }).click()
      await expect(page.getByText(th('goReceive.form.saved'))).toBeVisible()
      await expect(pending(page, th('goReceive.queue.waiting'))).toHaveText('1')
      // Nothing reached the server
      expect(script<Receipts>('scripts/go.ts', 'receipts', po.id).receipts).toEqual([])
    } finally {
      await context.setOffline(false)
    }

    // The signal is back: the photo goes up and the receipt goes, again with its key while its answer is lost
    await expect(page.getByText(th('goReceive.queue.empty'))).toBeVisible({ timeout: 90_000 })
    expect(keys).toHaveLength(lost + 1)
    expect(new Set(keys).size, 'every try of the receipt carries the same idempotency key').toBe(1)
    expect(keys[0]).not.toBe('')
  } finally {
    await context.close()
  }

  // One receipt, captured offline, on the app's channel; the PO as expectJson says
  const received = script<Receipts>('scripts/go.ts', 'receipts', po.id)
  expect(received.status).toBe(expectedOf<string>(scene, 'poStatusAfter'))
  expect(received.receipts).toHaveLength(expectedOf<number>(scene, 'receipts'))
  expect(received.receipts[0]).toEqual({
    number: expect.stringMatching(/^GR-\d{4}-\d{5}$/),
    status: expectedOf<string>(scene, 'receiptStatus'),
    offline: expectedOf<boolean>(scene, 'offline'),
    quantities: [Number(qty).toFixed(2)],
    photos,
    channel: expectedOf<string>(scene, 'receiptChannel'),
  })
  const after = day<PoFacts>('po', history.number)
  expect(after.receipts.map((r) => ({ receiver: r.receiver, deliveryNoteNo: r.deliveryNoteNo }))).toEqual([{ receiver: receiver.code, deliveryNoteNo: deliveryNote }])
})
