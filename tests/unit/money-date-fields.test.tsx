import { NextIntlClientProvider } from 'next-intl'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { chooseDatePart, DateField, dateOfParts, datePartsOf, yearsOf } from '@/ui/form/date-field'
import { plainNumber } from '@/ui/request-form/model'
import { readableMoney } from '@/ui/request-form/money'
import { MoneyInput } from '@/ui/request-form/money-input'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-PLT-002 AC3 (§9.9 principle 6): an amount typed into the request form reads with thousands separators and two
// decimals once the field is left — on the screen only, the form keeps the text as typed — and a day picked in a date
// field of a search or a period is picked as day, month and Buddhist-era year, in the reader's words only (§9.9: no
// English of the device's date picker on a Thai screen), and also reads in words under the lists.

const html = (node: ReactElement, locale: 'th' | 'en' = 'th') =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'th' ? th : en} timeZone="Asia/Bangkok">
      {node}
    </NextIntlClientProvider>,
  )

const valueOf = (markup: string) => /<input[^>]*\svalue="([^"]*)"/.exec(markup)?.[1]

describe('[FR-PLT-002/AC3] an amount typed into the request form reads as money once the field is left', () => {
  it.each<[string, string | null]>([
    ['140000', '140,000.00'],
    ['140000.00', '140,000.00'],
    ['1500.5', '1,500.50'],
    ['140,000.5', '140,000.50'],
    [' 2 500 ', '2,500.00'],
    ['0', '0.00'],
    ['9999999999999.99', '9,999,999,999,999.99'],
    ['', null],
    ['abc', null],
    ['1.234', null],
    ['-5', null],
    ['12,34,5.6.7', null],
  ])('%j reads %j', (typed, read) => {
    expect(readableMoney(typed)).toBe(read)
  })

  it('reads the same amount the form saves: the text as typed, separators taken out', () => {
    for (const typed of ['140000', '1,500.5', '0.75', '20 009.00']) {
      const read = readableMoney(typed)
      expect(read, typed).not.toBeNull()
      expect(amountToSatang(plainNumber(read!)), typed).toBe(amountToSatang(plainNumber(typed)))
    }
  })

  it('shows the amount grouped while the field does not have the focus, and text that is no amount as typed', () => {
    const shown = (value: string) => valueOf(html(<MoneyInput id="p" value={value} onChange={() => undefined} />))
    expect(shown('140000')).toBe('140,000.00')
    expect(shown('60000.00')).toBe('60,000.00')
    expect(shown('12a')).toBe('12a')
    expect(shown('')).toBe('')
    // A phone shows its keypad of digits
    expect(html(<MoneyInput id="p" value="1" onChange={() => undefined} />)).toContain('inputMode="decimal"')
  })
})

describe('[FR-PLT-002/AC3] a date field of a search or a period says the day with its Buddhist-era year', () => {
  /** The option a list of the field shows as chosen */
  const chosenIn = (markup: string, list: string) => {
    const select = new RegExp(`<select[^>]*id="${list}"[^>]*>([\\s\\S]*?)</select>`).exec(markup)?.[1] ?? ''
    return /<option[^>]*selected=""[^>]*>([^<]*)<\/option>/.exec(select)?.[1] ?? null
  }

  it('in Thai and in English: the day, the month and the Buddhist-era year from lists, and the day in words under them', () => {
    const thai = html(<DateField id="kpi-from" name="from" label="ตั้งแต่วันที่" defaultValue="2026-08-08" required />)
    // The form sends the day as before: yyyy-mm-dd of the Christian era, under the field's name
    expect(thai).toMatch(/<input type="hidden" id="kpi-from" name="from" value="2026-08-08"\/>/)
    expect(valueOf(thai)).toBe('2026-08-08')
    expect([chosenIn(thai, 'kpi-from-day'), chosenIn(thai, 'kpi-from-month'), chosenIn(thai, 'kpi-from-year')]).toEqual(['8', 'ส.ค.', '2569'])
    expect(thai).toMatch(/<fieldset[^>]*aria-describedby="kpi-from-hint"[^>]*><legend[^>]*>ตั้งแต่วันที่<\/legend>/)
    expect(thai).toContain('<p id="kpi-from-hint" class="text-base md:text-sm text-ink-muted">วันที่เลือก: 8 ส.ค. 2569</p>')
    const english = html(<DateField id="kpi-to" name="to" label="To" defaultValue="2026-10-06" />, 'en')
    expect(english).toContain('Chosen: 6 Oct 2569')
    expect([chosenIn(english, 'kpi-to-day'), chosenIn(english, 'kpi-to-month'), chosenIn(english, 'kpi-to-year')]).toEqual(['6', 'Oct', '2569'])
  })

  it('[§9.9] shows no word of the device’s own date picker: no "dd/mm/yyyy", no Christian-era year, each list named in Thai', () => {
    const thai = html(<DateField id="audit-from" name="from" label="ตั้งแต่วันที่" defaultValue="2026-08-08" />)
    expect(thai).not.toContain('type="date"')
    // Its words — the label, every option, the day in words — have no letter of English, and every year is of the Buddhist era
    const shown = thai.replace(/<[^>]+>/g, ' ')
    expect(shown).not.toMatch(/[A-Za-z]/)
    expect(shown).not.toMatch(/\b20\d\d\b/)
    expect(shown).toContain('2569')
    expect([...thai.matchAll(/<select[^>]*aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(['วัน', 'เดือน', 'ปี พ.ศ.'])
    const months = /<select[^>]*id="audit-from-month"[^>]*>([\s\S]*?)<\/select>/.exec(thai)?.[1] ?? ''
    expect([...months.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1])).toEqual(['เดือน', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'])
  })

  it('says nothing when no day is picked, sends none, asks for none unless required, and keeps a hint of its own beside the day', () => {
    const empty = html(<DateField id="audit-from" name="from" label="ตั้งแต่วันที่" />)
    expect(empty).not.toContain('audit-from-hint')
    expect(valueOf(empty)).toBe('')
    expect([chosenIn(empty, 'audit-from-day'), chosenIn(empty, 'audit-from-month'), chosenIn(empty, 'audit-from-year')]).toEqual(['วัน', 'เดือน', 'ปี พ.ศ.'])
    expect(empty).not.toContain('required=""')
    expect(html(<DateField id="kpi-from" name="from" label="ตั้งแต่วันที่" defaultValue="2026-08-08" required />).match(/<select[^>]*required=""/g)).toHaveLength(3)
    expect(html(<DateField id="d" name="d" label="วัน" hint="วันทำการ" defaultValue="2026-10-06" />)).toContain('วันทำการ · วันที่เลือก: 6 ต.ค. 2569')
  })

  it('sends a day only once the three lists are chosen, says what is missing until then, and keeps the day within its month', () => {
    const chosen = datePartsOf('2026-08-08')
    expect(chosen).toEqual({ day: '8', month: '8', year: '2026' })
    expect(dateOfParts(chosen)).toEqual({ value: '2026-08-08', partial: false })
    expect(dateOfParts(datePartsOf(''))).toEqual({ value: '', partial: false })
    expect(dateOfParts(datePartsOf('2026-02-30'))).toEqual({ value: '', partial: false })
    expect(dateOfParts({ day: '8', month: '', year: '2026' })).toEqual({ value: '', partial: true })
    // 31 then February of 2569 (2026): the day becomes the month's last; of 2571 (2028, a leap year) the 29th
    const thirtyFirst = chooseDatePart(chooseDatePart(datePartsOf(''), 'day', '31'), 'year', '2026')
    expect(chooseDatePart(thirtyFirst, 'month', '2')).toEqual({ day: '28', month: '2', year: '2026' })
    expect(chooseDatePart(chooseDatePart(thirtyFirst, 'month', '2'), 'year', '2028')).toEqual({ day: '28', month: '2', year: '2028' })
    expect(chooseDatePart({ day: '31', month: '2', year: '' }, 'year', '2028')).toEqual({ day: '29', month: '2', year: '2028' })
    expect(dateOfParts(chooseDatePart({ day: '31', month: '1', year: '2026' }, 'month', '4')).value).toBe('2026-04-30')
  })

  it('offers this year and the ten before it, newest first, with the year of the day it opens with when that is older', () => {
    expect(yearsOf(2026, datePartsOf(''))).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016])
    expect(yearsOf(2026, datePartsOf('2010-05-01')).slice(-2)).toEqual([2016, 2010])
    expect(yearsOf(2026, datePartsOf('2026-05-01'))).toHaveLength(11)
  })
})
