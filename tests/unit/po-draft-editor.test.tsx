import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DraftEditor, lineChange, type DraftLineEdit } from '@/ui/purchase-order/draft-editor'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// Editing a draft PO (FR-P2P-003 AC2, src/ui/purchase-order/draft-editor.tsx) one line at a time (§9.9: no single long
// form of more than 8 fields): the lines are listed with their price and quantity, each with a button that opens that line
// alone, so the page first shows no field of any line — only the two of the terms. Prices read with thousands separators
// and 2 decimals (§9.9 principle 6, FR-PLT-002 AC3); what a line's form sends is the price without them, compared with the
// line's as an amount, never as a number. Opening a line, the focus and the grouping when a field is left are checked in
// the browser (tests/e2e/purchase-order.spec.ts).

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

const line = (over: Partial<DraftLineEdit> = {}): DraftLineEdit => ({ id: 'l-1', no: 1, description: 'อุปกรณ์ความปลอดภัย PPE', uom: 'รายการ', quantity: '1', unitPrice: '12,000.00', maxQuantity: '1', ...over })

const render = (messages: typeof th, lines: readonly DraftLineEdit[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={messages === th ? 'th' : 'en'} messages={messages} timeZone="Asia/Bangkok">
      <DraftEditor poId="po-1" version={3} lines={lines} paymentTermDays={null} notesToSupplier={null} save={async () => ({ ok: true })} />
    </NextIntlClientProvider>,
  )
const count = (html: string, text: string) => html.split(text).length - 1

describe('[FR-P2P-003/AC2] [FR-PLT-002/AC3] a line of a draft sends its price without separators, and only what changed', () => {
  it('sends nothing when neither the price nor the quantity changed, however the price is written', () => {
    for (const price of ['12,000.00', '12000.00', '12000', ' 12 000.0 ']) expect(lineChange(line(), { price, quantity: '1' }), price).toEqual({ ok: true, edit: null })
  })

  it('sends the price as plain baht text: no separators, no spaces, the decimals as typed', () => {
    expect(lineChange(line(), { price: '1,150.00', quantity: '1' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '1150.00' } })
    expect(lineChange(line(), { price: '11500', quantity: '1' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '11500' } })
    expect(lineChange(line(), { price: ' 9 000 000 000.5 ', quantity: '1' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '9000000000.5' } })
    // One satang more is another price
    expect(lineChange(line(), { price: '12,000.01', quantity: '1' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '12000.01' } })
  })

  it('refuses a price that is no amount: more than 2 decimals, a sign, letters, nothing', () => {
    for (const price of ['1,150.005', '-5', '12a', '', '1.2.3']) expect(lineChange(line(), { price, quantity: '1' }), price).toEqual({ ok: false, problems: { price: 'badPrice' } })
  })

  it('sends a new quantity within what the request has left, and refuses one above it or not above 0', () => {
    const ten = line({ quantity: '10', maxQuantity: '10' })
    expect(lineChange(ten, { price: '12,000.00', quantity: ' 8 ' })).toEqual({ ok: true, edit: { poLineId: 'l-1', quantity: '8' } })
    expect(lineChange(ten, { price: '1,150.00', quantity: '8' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '1150.00', quantity: '8' } })
    // "10.0" is the same quantity
    expect(lineChange(ten, { price: '12,000.00', quantity: '10.0' })).toEqual({ ok: true, edit: null })
    expect(lineChange(ten, { price: '12,000.00', quantity: '11' })).toEqual({ ok: false, problems: { quantity: 'overMax' } })
    for (const quantity of ['0', '1.23456', 'สิบ', '']) expect(lineChange(ten, { price: '12,000.00', quantity }), quantity).toEqual({ ok: false, problems: { quantity: 'badQuantity' } })
    // Both wrong: both said at once
    expect(lineChange(ten, { price: 'x', quantity: '11' })).toEqual({ ok: false, problems: { price: 'badPrice', quantity: 'overMax' } })
  })

  it('never changes the quantity of a line that orders several request lines (its field is shut)', () => {
    const merged = line({ quantity: '5', maxQuantity: null })
    expect(lineChange(merged, { price: '12,000.00', quantity: '3' })).toEqual({ ok: true, edit: null })
    expect(lineChange(merged, { price: '11,000.00', quantity: 'anything' })).toEqual({ ok: true, edit: { poLineId: 'l-1', unitPrice: '11000.00' } })
  })
})

describe('[FR-P2P-003/AC2] the draft is edited one line at a time: no form of more than 8 fields (§9.9)', () => {
  const lines = [line(), line({ id: 'l-2', no: 2, description: 'ไม้อัด 10 มม.', uom: 'แผ่น', quantity: '20', unitPrice: '1,500.00', maxQuantity: '20' }), line({ id: 'l-3', no: 3, description: 'ตะปู 2 นิ้ว', uom: 'กล่อง', quantity: '100', unitPrice: '120.00', maxQuantity: '100' })]

  it('lists every line with its price grouped and its quantity, each with its own button, and no field of a line', () => {
    const html = render(th, lines)
    expect(html).toContain('>ราคาและจำนวน<')
    for (const [no, description, price] of [
      [1, 'อุปกรณ์ความปลอดภัย PPE', '12,000.00'],
      [2, 'ไม้อัด 10 มม.', '1,500.00'],
      [3, 'ตะปู 2 นิ้ว', '120.00'],
    ] as const) {
      expect(html).toContain(`>บรรทัด ${no}: ${description}<`)
      expect(html).toContain(`>${price}<`)
      expect(html).toContain(`>แก้บรรทัด ${no}<`)
    }
    expect(html).toContain('>จำนวน (แผ่น)<')
    expect(html).toContain('>20<')
    // Only the terms ask anything before a line is opened: the credit days and the note
    expect(count(html, '<input')).toBe(1)
    expect(count(html, '<textarea')).toBe(1)
    expect(html).not.toContain('บันทึกบรรทัด')
    expect(html).not.toContain('บันทึกราคาและจำนวน')
    expect(html).toContain('>บันทึกเงื่อนไขและหมายเหตุ<')
  })

  it('ends the prices of the listed lines on one right edge, in tabular digits, by the list’s own width (§9.9 principle 6)', () => {
    const html = render(th, lines)
    // The list is the container its lines measure: on a laptop the menu and the aside leave the PO's column narrow
    expect(html.match(/<div class="([^"]*)"><h3 [^>]*>ราคาและจำนวน<\/h3>/)?.[1]!.split(' ')).toContain('@container')
    // Each line's row, its part and its list of price and quantity, in order
    const rows = [...html.matchAll(/<div class="([^"]*)"><div class="([^"]*)"><p class="[^"]*">บรรทัด (\d+): [^<]*<\/p><dl class="([^"]*)">/g)]
    expect(rows.map((row) => row[3])).toEqual(['1', '2', '3'])
    for (const [, row, part, , list] of rows) {
      // Never the screen alone: a line goes beside its button only where the list has room
      expect([row, part, list].flatMap((c) => c!.split(' ')).filter((c) => /^(sm|md|lg|xl|2xl):/.test(c))).toEqual([])
      expect(row!.split(' ')).toContain('@min-[28rem]:flex-row')
      // Beside its button the line takes the room left, so every list is the same 24rem rather than as wide as its own
      // label and price — a narrower price would otherwise end further left and its decimals would not line up
      expect(part!.split(' ')).toContain('@min-[28rem]:flex-1')
      expect(list!.split(' ')).toEqual(expect.arrayContaining(['w-full', '@min-[28rem]:max-w-sm']))
    }
    // A price is money: right-aligned with tabular digits
    for (const price of ['12,000.00', '1,500.00', '120.00']) expect(html).toContain(`<dd class="money text-ink">${price}</dd>`)
  })

  it('says the same in English', () => {
    const html = render(en as unknown as typeof th, lines)
    expect(html).toContain('>Prices and quantities<')
    expect(html).toContain('>Line 2: ไม้อัด 10 มม.<')
    expect(html).toContain('>Edit line 3<')
    expect(count(html, '<input')).toBe(1)
  })

  it('names what each button does, and shows a price as it reads elsewhere, in both languages', () => {
    for (const messages of [th, en]) {
      const edit = messages.purchaseOrder.actions.edit
      for (const words of [edit.editLine, edit.saveLine]) expect(words).toContain('{no}')
      expect(edit.closeLine.length).toBeGreaterThan(0)
      // The example of a price is written as prices read (§9.9 principle 6)
      expect(edit.badPrice).toContain('1,500.00')
    }
    expect(th.purchaseOrder.actions.edit.saveLine).toBe('บันทึกบรรทัด {no}')
    expect(th.purchaseOrder.actions.edit.closeLine).toBe('ปิดโดยไม่บันทึก')
  })
})
