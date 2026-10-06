import { describe, expect, it } from 'vitest'
import { poCancelErrorKey, poErrorKey, toPoFailure } from '@/ui/purchase-order/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// §9.9 principle 7 on the purchase-order page (purchaseOrder.errors): a refusal says what happened and how to fix it, in
// Thai and in English. Four said only what happened (D-05): goods received before a cancel (GR_POSTED), the quantity of a
// line that orders several request lines (MERGED_LINE), an inactive supplier (SUPPLIER_INACTIVE) and a line without a
// source request (NO_SOURCE_REQUEST). Each now names the fix the services allow, in the words of the screen where it is
// done; tests/integration/po-refusal-fixes.test.ts does the fixes against real Postgres.

const errors = { th: th.purchaseOrder.errors, en: en.purchaseOrder.errors }
const LOCALES = [
  ['th', th],
  ['en', en],
] as const

describe('the purchase-order page says how to fix each refusal, not only what happened (§9.9 principle 7)', () => {
  it('GR_POSTED: a cancel refused because goods came; what will not come is closed short on the receiving page of the PO', () => {
    expect(poCancelErrorKey(toPoFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'SENT', command: 'po.cancel', reason: 'GR_POSTED' } }))).toBe('GR_POSTED')
    expect(errors.th.GR_POSTED).toBe('มีการตรวจรับของในใบสั่งซื้อนี้แล้ว จึงยกเลิก PO ไม่ได้ ถ้าของที่ยังไม่มาจะไม่มาแล้ว ให้ขอปิดใบสั่งซื้อทั้งที่รับไม่ครบที่หน้าตรวจรับของใบนี้')
    expect(errors.en.GR_POSTED).toBe(
      'Goods were received on this purchase order already, so the PO cannot be cancelled. If what is still to come will not come, ask to close the purchase order short on its receiving page.',
    )
    // The receiving page names that part the same way (receiving.closeShort): procurement asks for it there
    expect(errors.th.GR_POSTED).toContain(th.receiving.closeShort.title)
    expect(errors.en.GR_POSTED).toContain(en.receiving.closeShort.title.toLowerCase())
  })

  it('SHORT_NOT_APPROVED, and the sentence of why closing waits: what will not come is closed short on the receiving page, then the PO closes once that is approved', () => {
    expect(poErrorKey(toPoFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'PARTIALLY_RECEIVED', command: 'po.close', reason: 'SHORT_NOT_APPROVED' } }))).toBe('SHORT_NOT_APPROVED')
    const said = 'ยังมีบรรทัดที่รับของไม่ครบ ปิดได้เมื่อรับครบ ถ้าของที่ค้างจะไม่มาแล้ว ให้ขอปิดใบสั่งซื้อทั้งที่รับไม่ครบที่หน้าตรวจรับของใบนี้ แล้วปิดได้เมื่อคำขอนั้นได้รับอนุมัติ'
    expect(errors.th.SHORT_NOT_APPROVED).toBe(said)
    expect(th.purchaseOrder.actions.close.needsShortfall).toBe(said)
    const english = 'Some lines did not come in full. It closes once they come; if the rest will not come, ask to close the purchase order short on its receiving page, and close it once that is approved.'
    expect(errors.en.SHORT_NOT_APPROVED).toBe(english)
    expect(en.purchaseOrder.actions.close.needsShortfall).toBe(english)
    // In the words of the receiving page's part (receiving.closeShort), never a "shortfall variance" no page names
    for (const text of [errors.th.SHORT_NOT_APPROVED, th.purchaseOrder.actions.close.needsShortfall]) expect(text).toContain(th.receiving.closeShort.title)
    for (const text of [errors.en.SHORT_NOT_APPROVED, en.purchaseOrder.actions.close.needsShortfall]) expect(text).toContain(en.receiving.closeShort.title.toLowerCase())
    for (const text of [errors.th.SHORT_NOT_APPROVED, th.purchaseOrder.actions.close.needsShortfall]) expect(text).not.toContain('ผลต่างขาดส่ง')
  })

  it('MERGED_LINE: a line of several request lines keeps its quantity; taken off and drafted again in the pool, each request line is a line whose quantity changes', () => {
    expect(poErrorKey(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity', reason: 'MERGED_LINE' } }))).toBe('MERGED_LINE')
    expect(errors.th.MERGED_LINE).toBe(
      'บรรทัดที่รวมหลายบรรทัดคำขอแก้จำนวนไม่ได้ แก้ได้เฉพาะราคา ถ้าต้องสั่งจำนวนอื่น ให้เอาบรรทัดนี้ออก กลับเข้ากองรอจัดซื้อ แล้วกด “รวมเป็นร่าง PO ตอนนี้” ที่กองรอจัดซื้อ ร่างใหม่แยกบรรทัดตามบรรทัดคำขอ จึงแก้จำนวนได้',
    )
    expect(errors.en.MERGED_LINE).toBe(
      'A line that orders several request lines cannot change its quantity, only its price. To order another quantity, take this line off, back to the procurement pool, then press “Make draft POs now” in the pool: the new draft has one line per request line, so its quantities can change.',
    )
    // In the words of the line's form, where the line is taken off, and of the pool's button that drafts it again
    expect(errors.th.MERGED_LINE).toContain(th.purchaseOrder.actions.edit.remove)
    expect(errors.en.MERGED_LINE.toLowerCase()).toContain(en.purchaseOrder.actions.edit.remove.toLowerCase())
    for (const [locale, messages] of LOCALES) expect(errors[locale].MERGED_LINE, locale).toContain(`“${messages.procurement.pool.round.submit}”`)
  })

  it('SUPPLIER_INACTIVE: the supplier is activated in the supplier register first, as the notice before sending already says', () => {
    expect(poErrorKey(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' } }))).toBe('SUPPLIER_INACTIVE')
    expect(errors.th.SUPPLIER_INACTIVE).toBe('ผู้ขายรายนี้ถูกปิดใช้งาน จึงส่งขออนุมัติไม่ได้ เปิดใช้ผู้ขายที่ทะเบียนผู้ขายก่อน แล้วกลับมาส่ง')
    expect(errors.en.SUPPLIER_INACTIVE).toBe('This supplier is inactive, so the PO cannot be sent for approval. Activate the supplier in the supplier register first, then come back to send it.')
    // One sentence for one state, whether the page knew it before the press or the service found it at the press
    for (const [locale, messages] of LOCALES) expect(errors[locale].SUPPLIER_INACTIVE, locale).toBe(messages.purchaseOrder.actions.submit.supplierInactive)
  })

  it('NO_SOURCE_REQUEST: the line without a source request is found under the lines and taken off in the draft’s editing', () => {
    expect(poErrorKey(toPoFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines', reason: 'NO_SOURCE_REQUEST' } }))).toBe('NO_SOURCE_REQUEST')
    expect(errors.th.NO_SOURCE_REQUEST).toBe(
      'ทุกบรรทัดต้องมาจากคำขอที่อนุมัติแล้ว แต่บางบรรทัดของร่างนี้ไม่มีคำขอต้นทาง (ในส่วน “รายการ” ไม่มี “จากคำขอ” ใต้ชื่อ) จึงส่งขออนุมัติไม่ได้ เอาบรรทัดนั้นออกที่ส่วน “แก้ไขร่าง” แล้วส่งขออนุมัติอีกครั้ง',
    )
    expect(errors.en.NO_SOURCE_REQUEST).toBe(
      'Every line must come from an approved request, but some lines of this draft have no source request (under “Lines” they show no “From request”), so it cannot be sent for approval. Take those lines off under “Edit the draft”, then send it for approval again.',
    )
    // What it points at is the page's own: the lines' section, the words a line's source starts with, the draft's editing
    for (const [locale, messages] of LOCALES) {
      const said = errors[locale].NO_SOURCE_REQUEST
      expect(said, locale).toContain(`“${messages.purchaseOrder.lines.title}”`)
      expect(said, locale).toContain(`“${messages.purchaseOrder.lines.source.split(' {number}')[0]}”`)
      expect(said, locale).toContain(`“${messages.purchaseOrder.actions.edit.title}”`)
    }
  })
})
