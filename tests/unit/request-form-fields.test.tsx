import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConfirmRemove } from '@/ui/request-form/confirm-remove'
import { FieldInput, showDay } from '@/ui/request-form/field-input'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// Fields of a request type's form as the requester sees them (S2-11): every kind of field shows its own hint and
// error next to it, tied to the control (aria-describedby), and a date is also said with its Buddhist-era year beside
// the device's own date picker. The interactions run in tests/e2e/request-form.spec.ts.

const render = (node: ReactNode, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const noop = () => undefined

describe('[FR-INT-002/AC1] a field of the form shows its own hint and error', () => {
  it('a required tick box says it is required and shows its error, tied to the box', () => {
    const html = render(<FieldInput def={{ id: 'confirmed', type: 'checkbox', required: true, label: { th: 'ยืนยันว่าตรวจสเปกแล้ว', en: 'Specification checked' }, help: { th: 'ติ๊กเมื่อตรวจแล้ว', en: 'Tick once checked' } }} value={undefined} onChange={noop} locale="th" error="ตอบข้อนี้ก่อนส่ง" />)
    expect(html).toContain('ยืนยันว่าตรวจสเปกแล้ว')
    expect(html).toContain('(จำเป็น)')
    expect(html).toContain('id="field-confirmed-hint"')
    expect(html).toContain('id="field-confirmed-error"')
    expect(html).toContain('aria-describedby="field-confirmed-hint field-confirmed-error"')
    expect(html).toContain('ตอบข้อนี้ก่อนส่ง')
    expect(html).toContain('aria-invalid="true"')
  })

  it('a tick box without an error points to no error', () => {
    const html = render(<FieldInput def={{ id: 'confirmed', type: 'checkbox', label: { th: 'ยืนยัน', en: 'Confirm' } }} value={true} onChange={noop} locale="th" />)
    expect(html).not.toContain('field-confirmed-error')
    expect(html).not.toContain('aria-describedby')
  })

  it('a date shows the day chosen with its Buddhist-era year beside the device’s picker, in the reader’s language', () => {
    expect(showDay('2027-10-31', 'th')).toBe('31 ต.ค. 2570')
    expect(showDay('2027-10-31', 'en')).toBe('31 Oct 2570')
    const def = { id: 'startOn', type: 'date' as const, required: true, label: { th: 'วันเริ่มงาน', en: 'Start date' } }
    const thai = render(<FieldInput def={def} value="2027-10-31" onChange={noop} locale="th" />)
    expect(thai).toContain('วันที่เลือก: 31 ต.ค. 2570')
    expect(thai).toContain('aria-describedby="field-startOn-hint"')
    expect(render(<FieldInput def={def} value="2027-10-31" onChange={noop} locale="en" />, 'en')).toContain('Chosen: 31 Oct 2570')
    // Nothing chosen yet: no hint to point at
    expect(render(<FieldInput def={def} value="" onChange={noop} locale="th" />)).not.toContain('field-startOn-hint')
  })
})

describe('[FR-INT-006/AC1] taking something off a request is a danger button that asks first', () => {
  it('starts as one outlined danger button saying what it removes; the question is not shown until pressed', () => {
    const html = render(<ConfirmRemove label="ลบรายการที่ 2" question="ลบรายการที่ 2 ออกจากคำขอ?" confirmLabel="ลบรายการนี้" keepLabel="ไม่ลบ เก็บรายการไว้" onConfirm={noop} />)
    expect(html).toContain('ลบรายการที่ 2')
    expect(html).toContain('border-danger')
    expect(html).not.toContain('ลบรายการที่ 2 ออกจากคำขอ?')
    expect(html).not.toContain('ไม่ลบ เก็บรายการไว้')
  })
})
